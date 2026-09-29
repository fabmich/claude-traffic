import { MinHeap } from '../core/heap';
import { hash2 } from '../core/rng';
import type { Connector, Lane, Network, Segment } from '../roads/network';
import { CLASS_BIT, VKind, type VKindId } from './params';
import type { Destination, Leg } from './vehicle';

/** Directed segment id: seg.id * 2 + (forward ? 0 : 1). */
export const dsOf = (seg: Segment, forward: boolean): number => seg.id * 2 + (forward ? 0 : 1);
export const dsOfLane = (lane: Lane): number => dsOf(lane.segment, lane.forward);

export interface RouteStart {
  ds: number;
  /** Position along the directed segment's lanes. */
  s: number;
}

export interface RouteResult {
  legs: Leg[];
  dest: Destination;
  cost: number;
}

/**
 * Travel-time router over directed segments. Turns come from lane connectors, so lane arrows and
 * restrictions shape the available routes. Costs include speed limits, live congestion,
 * junction waiting times and per-driver preference noise.
 */
export class Router {
  readonly nDs: number;
  private adjStart: Int32Array;
  private adjTo: Int32Array;
  private adjCost: Float32Array;
  private adjMask: Uint8Array;
  private dsLen: Float32Array;
  private dsLimit: Float32Array;
  private dsExists: Uint8Array;
  private dsStartX: Float32Array;
  private dsStartY: Float32Array;
  private dsTruckBan: Uint8Array;
  private dsLanes: Lane[][];
  private gStart: Float64Array;
  private came: Int32Array;
  private seen: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heap = new MinHeap(2048);
  maxLimit = 30;
  searches = 0;

  constructor(
    readonly net: Network,
    turnPenalty: (c: Connector) => number,
  ) {
    const nDs = net.segments.length * 2;
    this.nDs = nDs;
    this.dsLen = new Float32Array(nDs);
    this.dsLimit = new Float32Array(nDs);
    this.dsExists = new Uint8Array(nDs);
    this.dsStartX = new Float32Array(nDs);
    this.dsStartY = new Float32Array(nDs);
    this.dsTruckBan = new Uint8Array(nDs);
    this.dsLanes = new Array(nDs);
    for (const seg of net.segments) {
      for (const forward of [true, false]) {
        const lanes = forward ? seg.forward : seg.backward;
        const ds = dsOf(seg, forward);
        this.dsLanes[ds] = lanes;
        if (lanes.length === 0) continue;
        this.dsExists[ds] = 1;
        this.dsLen[ds] = lanes.reduce((a, l) => a + l.length, 0) / lanes.length;
        this.dsLimit[ds] = seg.speedLimit;
        this.dsStartX[ds] = lanes[0].path.x0;
        this.dsStartY[ds] = lanes[0].path.y0;
        this.dsTruckBan[ds] = seg.truckBan ? 1 : 0;
        if (seg.speedLimit > this.maxLimit) this.maxLimit = seg.speedLimit;
      }
    }
    // Aggregate connectors into directed-segment edges.
    const edges = new Map<number, Map<number, { cost: number; mask: number }>>();
    for (const c of net.connectors) {
      const a = dsOfLane(c.from);
      const b = dsOfLane(c.to);
      const carOk = !c.from.busOnly && !c.to.busOnly;
      const mask = (carOk ? CLASS_BIT[VKind.Car] | CLASS_BIT[VKind.Truck] : 0) | CLASS_BIT[VKind.Bus];
      const cost = c.length / Math.max(2, c.maxSpeed) + turnPenalty(c);
      let m = edges.get(a);
      if (!m) edges.set(a, (m = new Map()));
      const e = m.get(b);
      if (!e) m.set(b, { cost, mask });
      else {
        e.cost = Math.min(e.cost, cost);
        e.mask |= mask;
      }
    }
    this.adjStart = new Int32Array(nDs + 1);
    let count = 0;
    for (let ds = 0; ds < nDs; ds++) {
      this.adjStart[ds] = count;
      count += edges.get(ds)?.size ?? 0;
    }
    this.adjStart[nDs] = count;
    this.adjTo = new Int32Array(count);
    this.adjCost = new Float32Array(count);
    this.adjMask = new Uint8Array(count);
    for (let ds = 0; ds < nDs; ds++) {
      let k = this.adjStart[ds];
      const m = edges.get(ds);
      if (!m) continue;
      for (const [to, e] of m) {
        this.adjTo[k] = to;
        this.adjCost[k] = e.cost;
        this.adjMask[k] = e.mask;
        k++;
      }
    }
    this.gStart = new Float64Array(nDs + 10);
    this.came = new Int32Array(nDs + 10);
    this.seen = new Uint32Array(nDs + 10);
    this.closed = new Uint32Array(nDs + 10);
  }

  exists(ds: number): boolean {
    return this.dsExists[ds] === 1;
  }

  length(ds: number): number {
    return this.dsLen[ds];
  }

  /** Effective speed on a directed segment: limit, vehicle cap, live congestion and junction waits. */
  speed(ds: number, vMax: number): number {
    const lanes = this.dsLanes[ds];
    let ratio = 0;
    let wait = 0;
    for (const l of lanes) {
      ratio += l.statSpeed;
      wait += l.statWait;
    }
    ratio = Math.max(0.12, ratio / lanes.length);
    const base = Math.min(this.dsLimit[ds], vMax);
    const len = this.dsLen[ds];
    const t = len / (base * ratio) + wait / lanes.length;
    return len / Math.max(0.05, t);
  }

  /**
   * Finds the fastest route from any start to any destination.
   * Returns the legs (starting with the start segment) and the destination reached.
   */
  route(kind: VKindId, starts: RouteStart[], dests: Destination[], seed: number, vMax: number): RouteResult | null {
    if (dests.length === 0) return null;
    this.searches++;
    const gen = ++this.gen;
    const heap = this.heap;
    heap.clear();
    const nDs = this.nDs;
    const bit = CLASS_BIT[kind];
    const goal = nDs;
    const destByDs = new Map<number, Destination>();
    for (const d of dests) destByDs.set(dsOf(d.seg, d.forward), d);
    const dx = dests[0].seg.center.xs[0];
    const dy = dests[0].seg.center.ys[0];
    const hScale = 1 / Math.max(10, Math.min(this.maxLimit, vMax));
    const heur = (ds: number): number => Math.hypot(this.dsStartX[ds] - dx, this.dsStartY[ds] - dy) * hScale * 0.8;
    const noise = (ds: number): number => 1 + (hash2(ds, seed, 97) - 0.5) * 0.24;
    let bestGoal = Infinity;
    let goalFrom = -1;
    const startIds: number[] = [];

    const relaxFrom = (u: number, gEnd: number, fromId: number): void => {
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
        if ((this.adjMask[k] & bit) === 0) continue;
        const w = this.adjTo[k];
        const d = destByDs.get(w);
        if (kind === VKind.Truck && this.dsTruckBan[w] && !d) continue;
        const gw = gEnd + this.adjCost[k];
        if (this.closed[w] === gen) continue;
        if (this.seen[w] === gen && gw >= this.gStart[w] - 1e-9) continue;
        this.seen[w] = gen;
        this.gStart[w] = gw;
        this.came[w] = fromId;
        heap.push(w, gw + heur(w));
        if (d) {
          const total = gw + (d.outside ? this.dsLen[w] : d.s) / this.speed(w, vMax);
          if (total < bestGoal) {
            bestGoal = total;
            goalFrom = w;
            heap.push(goal, total);
          }
        }
      }
    };

    starts.slice(0, 8).forEach((st, i) => {
      if (!this.exists(st.ds)) return;
      const sid = nDs + 1 + i;
      startIds[i] = st.ds;
      const sp = this.speed(st.ds, vMax);
      const d = destByDs.get(st.ds);
      if (d && (d.outside || d.s >= st.s - 0.5)) {
        const total = Math.max(0, (d.outside ? this.dsLen[st.ds] : d.s) - st.s) / sp;
        if (total < bestGoal) {
          bestGoal = total;
          goalFrom = sid;
          heap.push(goal, total);
        }
      }
      relaxFrom(st.ds, (Math.max(0, this.dsLen[st.ds] - st.s) / sp) * noise(st.ds), sid);
    });

    while (heap.size > 0) {
      const u = heap.pop();
      if (u === goal) break;
      if (this.closed[u] === gen) continue;
      this.closed[u] = gen;
      const gEnd = this.gStart[u] + (this.dsLen[u] / this.speed(u, vMax)) * noise(u);
      if (gEnd >= bestGoal) continue;
      relaxFrom(u, gEnd, u);
    }
    if (goalFrom < 0) return null;
    const ids: number[] = [];
    let cur = goalFrom;
    for (let guard = 0; cur < nDs && guard < 100000; guard++) {
      ids.push(cur);
      cur = this.came[cur];
    }
    ids.push(startIds[cur - nDs - 1]);
    ids.reverse();
    const legs: Leg[] = ids.map((ds) => ({ seg: this.net.segments[ds >> 1], forward: (ds & 1) === 0 }));
    const destDs = goalFrom < nDs ? goalFrom : startIds[goalFrom - nDs - 1];
    return { legs, dest: destByDs.get(destDs)!, cost: bestGoal };
  }
}
