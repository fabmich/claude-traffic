import { DAY_SECONDS } from '../config';
import type { Citizen } from '../city/City';
import { BState, type Building } from '../city/buildings';
import { Zone } from '../city/zones';
import { Emitter } from '../core/events';
import { angleDiff, type Polyline } from '../core/polyline';
import { Rng } from '../core/rng';
import type { World } from '../game/World';
import type { Connector, Lane, Segment } from '../roads/network';
import { KIND_PARAMS, VKind } from '../sim/params';
import { dsOfLane } from '../sim/routing';
import type { Destination, Vehicle } from '../sim/vehicle';

const HOUR = DAY_SECONDS / 24;

/** Tunables of public transport. */
export const TRANSIT = {
  stopCost: 250,
  /** Upkeep per bus and day. */
  busUpkeep: 90,
  fare: 2,
  capacity: 40,
  /** Longest walk to or from a stop (meters, straight line). */
  walkMax: 220,
  walkSpeed: 1.4,
  /** Passengers give up after waiting this long (seconds). */
  maxWait: HOUR * 5,
  /** Weights of the generalized cost (seconds of in-vehicle time). */
  walkWeight: 1.1,
  waitWeight: 1.2,
  transferPenalty: 60,
  /** Parking and running costs of a car trip (seconds). */
  carPenalty: 240,
  logitScale: 90,
  /** Minimum distance between two stops on the same lane. */
  stopSpacing: 30,
  colors: ['#e8594f', '#3d8fe0', '#2fa66a', '#f2a93b', '#8e6fd8', '#e06fae', '#3fb6c0', '#9b7b52', '#5b6b7a'],
};

export class Stop {
  seg: Segment | null = null;
  lane: Lane | null = null;
  forward = true;
  /** Position on the curb lane. */
  s = 0;
  x = 0;
  y = 0;
  angle = 0;
  waiting: Passenger[] = [];
  lines: Line[] = [];
  boardings = 0;
  boardingsYesterday = 0;

  constructor(
    readonly id: number,
    public name: string,
    /** Where the player placed the stop and the direction of travel it serves. */
    readonly ax: number,
    readonly ay: number,
    readonly heading: number,
    readonly tile: number,
  ) {}

  get valid(): boolean {
    return this.lane !== null;
  }

  get dest(): Destination {
    return { seg: this.seg!, forward: this.forward, s: this.s, tile: this.tile, outside: false };
  }
}

export class Line {
  stops: Stop[] = [];
  /** Position of each stop in `stops`. */
  index = new Map<Stop, number>();
  /** Buses wanted on the line. */
  target = 2;
  /** Buses requested or driving. */
  fleet = 0;
  buses = new Set<Vehicle>();
  /** Estimated and observed seconds from stop i to stop i + 1. */
  legTime: number[] = [];
  observed: number[] = [];
  legPaths: Polyline[][] = [];
  broken = false;
  riders = 0;
  ridersYesterday = 0;
  spawnIdx = 0;
  lastSpawn = -1e9;

  constructor(
    readonly id: number,
    public name: string,
    public color: string,
  ) {}

  /** Seconds for one full round trip (driving plus stops). */
  get cycle(): number {
    let t = 0;
    for (let i = 0; i < this.stops.length; i++) t += (this.observed[i] || this.legTime[i] || 0) + 8;
    return t;
  }

  /** Average seconds between buses at a stop. */
  get headway(): number {
    return this.buses.size ? this.cycle / this.buses.size : Infinity;
  }

  /** Riding time from stop index a to stop index b in the direction of travel. */
  ride(a: number, b: number): number {
    const n = this.stops.length;
    let t = 0;
    for (let i = a; i !== b; i = (i + 1) % n) t += (this.observed[i] || this.legTime[i] || 60) + 8;
    return t;
  }
}

export const PState = { Walking: 0, Waiting: 1, Riding: 2 } as const;

interface JourneyLeg {
  line: Line;
  from: Stop;
  to: Stop;
}

export interface Journey {
  legs: JourneyLeg[];
  walkIn: number;
  walkOut: number;
  cost: number;
}

export class Passenger {
  state: number = PState.Walking;
  leg = 0;
  /** Walking: time of arrival. */
  until = 0;
  /** Waiting: time waiting started. */
  since = 0;
  /** Walking to the final destination (not to a stop). */
  final = false;
  bus: Vehicle | null = null;

  constructor(
    readonly c: Citizen,
    readonly j: Journey,
  ) {}

  get current(): JourneyLeg {
    return this.j.legs[this.leg];
  }
}

interface BusState {
  line: Line;
  /** Index of the stop the bus is heading to (or standing at). */
  idx: number;
  riders: Passenger[];
  leftAt: number;
  retire: boolean;
}

export type TransitEvents = { changed: void };

/** Bus stops, lines, buses and passengers, plus the mode choice hook of the city. */
export class Transit {
  readonly events = new Emitter<TransitEvents>();
  stops: Stop[] = [];
  lines: Line[] = [];
  private walking: Passenger[] = [];
  private bus = new Map<Vehicle, BusState>();
  private rng: Rng;
  private nextStopId = 1;
  private nextLineId = 1;
  private version = 0;
  private near = new WeakMap<Building, { v: number; list: Array<{ stop: Stop; walk: number }> }>();
  private timer = 0;
  private estimateTimer = 0;
  private lastDay = 1;
  /** Journeys by bus started today. */
  tripsToday = 0;

  constructor(private world: World) {
    this.rng = new Rng(world.options.seed ^ 0x2b7e1516);
    const city = world.city;
    city.transitPlanner = (c, from, to, dist) => this.plan(c, from, to, dist);
    city.transitBonus = (b) => this.bonus(b);
  }

  private get now(): number {
    return this.world.traffic.time;
  }

  private changed(): void {
    this.version++;
    let up = 0;
    for (const l of this.lines) up += l.target * TRANSIT.busUpkeep;
    this.world.city.transitUpkeepPerDay = up + this.stops.length * 4;
    this.events.emit('changed', undefined);
  }

  // ---------------------------------------------------------------- stops

  /** Curb lane of a road side near a world point (for placing stops). */
  locate(x: number, y: number, heading: number, maxDist = 10): { seg: Segment; forward: boolean; lane: Lane; s: number; d: number } | null {
    let best: { seg: Segment; forward: boolean; lane: Lane; s: number; d: number } | null = null;
    for (const seg of this.world.network.segments) {
      if (seg.type.hidden || !seg.type.access) continue;
      const b = seg.bbox;
      if (x < b.x0 - maxDist || x > b.x1 + maxDist || y < b.y0 - maxDist || y > b.y1 + maxDist) continue;
      for (const forward of [true, false]) {
        const lanes = forward ? seg.forward : seg.backward;
        if (lanes.length === 0) continue;
        const lane = lanes[0];
        const pr = lane.path.project(x, y);
        if (Math.abs(angleDiff(pr.a, heading)) > 0.9 || pr.d > maxDist) continue;
        if (!best || pr.d < best.d) best = { seg, forward, lane, s: pr.s, d: pr.d };
      }
    }
    return best;
  }

  private resolve(stop: Stop): void {
    stop.seg = null;
    stop.lane = null;
    const hit = this.locate(stop.ax, stop.ay, stop.heading);
    if (!hit || hit.lane.length < 18) return;
    const s = Math.max(12, Math.min(hit.lane.length - 4, hit.s));
    stop.seg = hit.seg;
    stop.forward = hit.forward;
    stop.lane = hit.lane;
    stop.s = s;
    const pt = { x: 0, y: 0, a: 0 };
    hit.lane.path.pointAt(s, pt);
    stop.x = pt.x;
    stop.y = pt.y;
    stop.angle = pt.a;
  }

  /** Checks whether a stop could be placed; returns an error or null. */
  canPlaceStop(x: number, y: number, heading: number): string | null {
    const hit = this.locate(x, y, heading);
    if (!hit) return 'Place stops on the side of a street (not on highways)';
    if (hit.lane.length < 18) return 'This road piece is too short for a stop';
    const s = Math.max(12, Math.min(hit.lane.length - 4, hit.s));
    for (const st of this.stops) if (st.lane === hit.lane && Math.abs(st.s - s) < TRANSIT.stopSpacing) return 'Too close to another stop';
    return null;
  }

  addStop(x: number, y: number, heading: number): Stop | string {
    const err = this.canPlaceStop(x, y, heading);
    if (err) return err;
    if (!this.world.canAfford(TRANSIT.stopCost)) return 'Not enough money';
    this.world.spend(TRANSIT.stopCost);
    const w = this.world.map.w;
    const tile = Math.floor(y / 24) * w + Math.floor(x / 24);
    const stop = new Stop(this.nextStopId++, `Stop ${this.nextStopId - 1}`, x, y, heading, tile);
    this.resolve(stop);
    this.stops.push(stop);
    this.changed();
    return stop;
  }

  removeStop(stop: Stop): void {
    for (const line of [...stop.lines]) {
      const i = line.stops.indexOf(stop);
      if (i < 0) continue;
      const stops = line.stops.filter((s) => s !== stop);
      if (stops.length < 2) this.deleteLine(line);
      else this.setLineStops(line, stops);
    }
    for (const p of [...stop.waiting]) this.giveUp(p, stop.x, stop.y);
    stop.waiting = [];
    this.stops = this.stops.filter((s) => s !== stop);
    this.world.earn(TRANSIT.stopCost / 2);
    this.changed();
  }

  stopAt(x: number, y: number, radius = 9): Stop | null {
    let best: Stop | null = null;
    let bd = radius;
    for (const s of this.stops) {
      if (!s.valid) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- lines

  /** Route between two stops for a bus (null if unreachable). */
  legRoute(a: Stop, b: Stop): { legs: Array<{ seg: Segment; forward: boolean }>; cost: number } | null {
    if (!a.valid || !b.valid) return null;
    const res = this.world.traffic.router.route(VKind.Bus, [{ ds: dsOfLane(a.lane!), s: a.s }], [b.dest], 1, KIND_PARAMS[VKind.Bus].vMax);
    return res ? { legs: res.legs, cost: res.cost } : null;
  }

  /** Polylines along a bus route between two stops (for drawing). */
  legPath(a: Stop, b: Stop): Polyline[] | null {
    const r = this.legRoute(a, b);
    if (!r) return null;
    const out: Polyline[] = [];
    const legs = r.legs;
    let enter: Lane | null = a.lane;
    let s0 = a.s;
    for (let i = 0; i < legs.length; i++) {
      const lanes = legs[i].forward ? legs[i].seg.forward : legs[i].seg.backward;
      const lane: Lane = enter && enter.segment === legs[i].seg && enter.forward === legs[i].forward ? enter : lanes[0];
      if (!lane) return out;
      const last = i === legs.length - 1;
      const s1 = last ? b.s : lane.length;
      if (s1 > s0) out.push(lane.path.slice(s0, s1));
      if (last) break;
      const next = legs[i + 1];
      let conn: Connector | null = null;
      for (const l of lanes) {
        for (const c of l.outs) {
          if (c.to.segment !== next.seg || c.to.forward !== next.forward) continue;
          if (!conn || c.from.index + c.to.index < conn.from.index + conn.to.index) conn = c;
        }
      }
      if (!conn) return out;
      if (conn.from !== lane) out.push(conn.from.path.slice(Math.max(0, conn.from.length - 6), conn.from.length));
      out.push(conn.path);
      enter = conn.to;
      s0 = 0;
    }
    return out;
  }

  private refreshLine(line: Line): void {
    const n = line.stops.length;
    line.broken = false;
    line.legTime = [];
    line.legPaths = [];
    for (let i = 0; i < n; i++) {
      const a = line.stops[i];
      const b = line.stops[(i + 1) % n];
      const r = this.legRoute(a, b);
      if (!r) line.broken = true;
      line.legTime.push(r ? r.cost : 0);
      line.legPaths.push(this.legPath(a, b) ?? []);
    }
  }

  createLine(stops: Stop[]): Line {
    const id = this.nextLineId++;
    const line = new Line(id, `Line ${id}`, TRANSIT.colors[(id - 1) % TRANSIT.colors.length]);
    this.lines.push(line);
    this.setLineStops(line, stops);
    line.target = Math.max(1, Math.min(6, Math.round(line.cycle / 150)));
    this.changed();
    return line;
  }

  setLineStops(line: Line, stops: Stop[]): void {
    for (const s of line.stops) s.lines = s.lines.filter((l) => l !== line);
    line.stops = [...stops];
    line.index = new Map(line.stops.map((st, i) => [st, i]));
    for (const s of line.stops) if (!s.lines.includes(line)) s.lines.push(line);
    line.observed = [];
    this.refreshLine(line);
    // Buses continue from the first stop of the new route.
    const first = line.stops.find((s) => s.valid);
    for (const v of line.buses) {
      const st = this.bus.get(v);
      if (!st || !first) continue;
      st.idx = line.stops.indexOf(first);
      this.world.traffic.redirect(v, [first.dest]);
    }
    for (const s of this.stops) {
      for (const p of [...s.waiting]) {
        if (p.current.line === line && (!line.index.has(p.current.to) || !line.index.has(p.current.from))) this.giveUp(p, s.x, s.y);
      }
    }
    this.changed();
  }

  deleteLine(line: Line): void {
    line.target = 0;
    for (const v of [...line.buses]) this.world.traffic.remove(v);
    for (const s of line.stops) s.lines = s.lines.filter((l) => l !== line);
    for (const s of this.stops) for (const p of [...s.waiting]) if (p.j.legs.some((l) => l.line === line)) this.giveUp(p, s.x, s.y);
    this.lines = this.lines.filter((l) => l !== line);
    this.changed();
  }

  setBusCount(line: Line, n: number): void {
    line.target = Math.max(0, Math.min(20, n));
    let extra = line.fleet - line.target;
    for (const v of line.buses) {
      const st = this.bus.get(v);
      if (st) st.retire = extra-- > 0;
    }
    this.changed();
  }

  /** Bus info for the vehicle panel. */
  busInfo(v: Vehicle): { line: Line; riders: number; next: Stop | null } | null {
    const st = this.bus.get(v);
    if (!st) return null;
    return { line: st.line, riders: st.riders.length, next: st.line.stops[st.idx] ?? null };
  }

  // ---------------------------------------------------------------- buses

  private spawnBus(line: Line): void {
    const n = line.stops.length;
    for (let k = 0; k < n; k++) {
      const i = (line.spawnIdx + k) % n;
      const a = line.stops[i];
      const b = line.stops[(i + 1) % n];
      if (!a.valid || !b.valid) continue;
      line.spawnIdx = (i + Math.max(1, Math.floor(n / Math.max(1, line.target)))) % n;
      line.fleet++;
      line.lastSpawn = this.now;
      const st: BusState = { line, idx: (i + 1) % n, riders: [], leftAt: this.now, retire: false };
      this.world.traffic.request({
        kind: VKind.Bus,
        origins: [{ lane: a.lane!, s: a.s }],
        dests: [b.dest],
        color: line.color,
        data: `Bus on ${line.name}`,
        onSpawn: (v) => {
          if (!this.lines.includes(line)) {
            // The line was deleted while this bus waited for a gap.
            this.world.traffic.remove(v);
            return;
          }
          this.bus.set(v, st);
          line.buses.add(v);
        },
        onStop: (v) => this.atStop(v),
        onTrip: (v) => this.busGone(v),
        onFail: () => {
          line.fleet = Math.max(0, line.fleet - 1);
        },
      });
      return;
    }
  }

  private busGone(v: Vehicle): void {
    const st = this.bus.get(v);
    if (!st) return;
    this.bus.delete(v);
    st.line.buses.delete(v);
    st.line.fleet = Math.max(0, st.line.fleet - 1);
    for (const p of st.riders) this.giveUp(p, v.x, v.y);
    st.riders = [];
  }

  /** A bus reached its next stop: passengers get off and on, then it heads for the following stop. */
  private atStop(v: Vehicle): number | null {
    const st = this.bus.get(v);
    if (!st) return null;
    const line = st.line;
    const n = line.stops.length;
    const stop = line.stops[st.idx];
    if (!stop || n < 2) return null;
    const prev = (st.idx - 1 + n) % n;
    const took = this.now - st.leftAt;
    if (took > 0 && took < 1200) line.observed[prev] = line.observed[prev] ? line.observed[prev] * 0.7 + took * 0.3 : took;
    let moved = 0;
    for (let i = st.riders.length - 1; i >= 0; i--) {
      const p = st.riders[i];
      if (p.c.removed) {
        st.riders.splice(i, 1);
        continue;
      }
      if (!line.index.has(p.current.to)) {
        // Their stop was taken off the line.
        st.riders.splice(i, 1);
        this.giveUp(p, stop.x, stop.y);
        continue;
      }
      if (p.current.to === stop || st.retire) {
        st.riders.splice(i, 1);
        moved++;
        if (p.current.to === stop) this.alight(p, stop);
        else {
          p.state = PState.Waiting;
          p.since = this.now;
          p.bus = null;
          stop.waiting.push(p);
        }
      }
    }
    if (st.retire) {
      line.fleet = Math.max(0, line.fleet - 1);
      line.buses.delete(v);
      this.bus.delete(v);
      return null;
    }
    for (let i = 0; i < stop.waiting.length && st.riders.length < TRANSIT.capacity; ) {
      const p = stop.waiting[i];
      if (p.c.removed) {
        stop.waiting.splice(i, 1);
        continue;
      }
      if (p.current.line !== line) {
        i++;
        continue;
      }
      stop.waiting.splice(i, 1);
      p.state = PState.Riding;
      p.bus = v;
      st.riders.push(p);
      moved++;
      line.riders++;
      stop.boardings++;
      if (p.leg === 0) this.world.city.budgetToday.fares += TRANSIT.fare;
    }
    for (let k = 1; k <= n; k++) {
      const idx = (st.idx + k) % n;
      const next = line.stops[idx];
      if (!next.valid || next === stop) continue;
      if (this.world.traffic.redirect(v, [next.dest])) {
        st.idx = idx;
        st.leftAt = this.now;
        return Math.min(20, 3 + moved * 0.5);
      }
    }
    line.broken = true;
    return null;
  }

  private alight(p: Passenger, stop: Stop): void {
    p.bus = null;
    if (p.leg < p.j.legs.length - 1) {
      p.leg++;
      if (!this.lines.includes(p.current.line)) {
        this.giveUp(p, stop.x, stop.y);
        return;
      }
      p.state = PState.Waiting;
      p.since = this.now;
      stop.waiting.push(p);
      return;
    }
    p.state = PState.Walking;
    p.final = true;
    p.until = this.now + p.j.walkOut;
    this.walking.push(p);
  }

  /** The passenger stops using transit and walks the rest of the way. */
  private giveUp(p: Passenger, x: number, y: number): void {
    const target = p.c.tripTarget;
    const dist = target ? Math.hypot(target.cx - x, target.cy - y) : 300;
    const i = p.state === PState.Waiting ? p.current.from.waiting.indexOf(p) : -1;
    if (i >= 0) p.current.from.waiting.splice(i, 1);
    p.state = PState.Walking;
    p.final = true;
    p.bus = null;
    p.until = this.now + Math.min(900, (dist * 1.3) / TRANSIT.walkSpeed);
    if (!this.walking.includes(p)) this.walking.push(p);
  }

  // ---------------------------------------------------------------- journeys

  /** Stops within walking distance of a building that are served by a line. */
  stopsNear(b: Building): Array<{ stop: Stop; walk: number }> {
    const c = this.near.get(b);
    if (c && c.v === this.version) return c.list;
    const list: Array<{ stop: Stop; walk: number }> = [];
    for (const s of this.stops) {
      if (!s.valid || s.lines.length === 0) continue;
      const d = Math.hypot(s.x - b.cx, s.y - b.cy);
      if (d <= TRANSIT.walkMax) list.push({ stop: s, walk: (d * 1.25) / TRANSIT.walkSpeed });
    }
    list.sort((a, b2) => a.walk - b2.walk);
    list.length = Math.min(list.length, 6);
    this.near.set(b, { v: this.version, list });
    return list;
  }

  /** Best bus journey between two buildings (direct or with one transfer). */
  journey(from: Building, to: Building): Journey | null {
    const O = this.stopsNear(from);
    if (O.length === 0) return null;
    const D = this.stopsNear(to);
    if (D.length === 0) return null;
    const W = TRANSIT.walkWeight;
    const Wt = TRANSIT.waitWeight;
    let best: Journey | null = null;
    for (const o of O) {
      for (const l1 of o.stop.lines) {
        if (l1.broken || l1.buses.size === 0) continue;
        const i1 = l1.index.get(o.stop)!;
        const wait1 = (l1.headway / 2) * Wt;
        for (const d of D) {
          if (d.stop === o.stop) continue;
          const j1 = l1.index.get(d.stop);
          if (j1 !== undefined) {
            const cost = o.walk * W + wait1 + l1.ride(i1, j1) + d.walk * W;
            if (!best || cost < best.cost) best = { legs: [{ line: l1, from: o.stop, to: d.stop }], walkIn: o.walk, walkOut: d.walk, cost };
            continue;
          }
          // One transfer at a stop both lines serve.
          for (const l2 of d.stop.lines) {
            if (l2 === l1 || l2.broken || l2.buses.size === 0) continue;
            const j2 = l2.index.get(d.stop)!;
            const wait2 = (l2.headway / 2) * Wt;
            for (let t = 0; t < l1.stops.length; t++) {
              const ts = l1.stops[t];
              if (ts === o.stop || ts === d.stop) continue;
              const i2 = l2.index.get(ts);
              if (i2 === undefined) continue;
              const cost = o.walk * W + wait1 + l1.ride(i1, t) + TRANSIT.transferPenalty + wait2 + l2.ride(i2, j2) + d.walk * W;
              if (!best || cost < best.cost) best = { legs: [{ line: l1, from: o.stop, to: ts }, { line: l2, from: ts, to: d.stop }], walkIn: o.walk, walkOut: d.walk, cost };
            }
          }
        }
      }
    }
    return best;
  }

  /** Mode choice: decides whether a citizen takes the bus and starts the journey. */
  plan(c: Citizen, from: Building, to: Building, dist: number): boolean {
    if (this.lines.length === 0 || dist < 250) return false;
    const j = this.journey(from, to);
    if (!j) return false;
    if (c.car) {
      const jam = 1 + (1 - this.world.traffic.stats.flow) * 1.5;
      const carCost = ((dist * 1.4) / 9 + 20) * jam + TRANSIT.carPenalty;
      const p = 1 / (1 + Math.exp((j.cost - carCost) / TRANSIT.logitScale));
      if (this.rng.next() >= p) return false;
    } else if (j.cost > ((dist * 1.3) / TRANSIT.walkSpeed) * TRANSIT.walkWeight) return false;
    const p = new Passenger(c, j);
    p.until = this.now + j.walkIn;
    this.walking.push(p);
    this.tripsToday++;
    return true;
  }

  /** Happiness bonus for homes with good bus service nearby. */
  bonus(b: Building): number {
    if (b.zone !== Zone.Residential || b.state !== BState.Active) return 0;
    const near = this.stopsNear(b);
    if (near.length === 0) return 0;
    let best = Infinity;
    const lines = new Set<Line>();
    for (const n of near) {
      for (const l of n.stop.lines) {
        lines.add(l);
        best = Math.min(best, l.headway);
      }
    }
    if (best === Infinity) return 0;
    return (best < 200 ? 4 : best < 400 ? 2 : 1) + Math.min(2, lines.size - 1);
  }

  // ---------------------------------------------------------------- network and step

  onNetworkChanged(): void {
    for (const s of this.stops) this.resolve(s);
    for (const l of this.lines) this.refreshLine(l);
    for (const [v, st] of this.bus) {
      const stop = st.line.stops[st.idx];
      if (v.dwell > 0 || !stop?.valid || !v.lane) continue;
      v.dest = stop.dest;
      v.needsReroute = true;
    }
    this.version++;
  }

  step(dt: number): void {
    this.timer += dt;
    if (this.timer < 0.5) return;
    this.timer = 0;
    const now = this.now;
    const city = this.world.city;
    // Walkers arriving at stops or destinations.
    if (this.walking.length) {
      const keep: Passenger[] = [];
      for (const p of this.walking) {
        if (p.c.removed) continue;
        if (now < p.until) {
          keep.push(p);
          continue;
        }
        if (p.final) {
          city.arrive(p.c, true);
          continue;
        }
        const leg = p.current;
        if (!leg.from.valid || !leg.from.lines.includes(leg.line)) {
          this.giveUp(p, leg.from.x, leg.from.y);
          keep.push(p);
          continue;
        }
        p.state = PState.Waiting;
        p.since = now;
        leg.from.waiting.push(p);
      }
      this.walking = keep;
    }
    // Passengers who waited too long walk instead.
    for (const s of this.stops) {
      for (let i = s.waiting.length - 1; i >= 0; i--) {
        const p = s.waiting[i];
        if (p.c.removed) s.waiting.splice(i, 1);
        else if (now - p.since > TRANSIT.maxWait) this.giveUp(p, s.x, s.y);
      }
    }
    // Keep the wanted number of buses on each line.
    for (const l of this.lines) {
      if (l.fleet < l.target && !l.broken && now - l.lastSpawn > 4 && l.stops.filter((s) => s.valid).length >= 2) this.spawnBus(l);
    }
    this.estimateTimer += 0.5;
    if (this.estimateTimer >= 30) {
      this.estimateTimer = 0;
      for (const l of this.lines) {
        const n = l.stops.length;
        l.broken = false;
        for (let i = 0; i < n; i++) {
          const r = this.legRoute(l.stops[i], l.stops[(i + 1) % n]);
          if (r) l.legTime[i] = r.cost;
          else l.broken = true;
        }
      }
    }
    const day = this.world.clock.day;
    if (day !== this.lastDay) {
      this.lastDay = day;
      this.tripsToday = 0;
      for (const l of this.lines) {
        l.ridersYesterday = l.riders;
        l.riders = 0;
      }
      for (const s of this.stops) {
        s.boardingsYesterday = s.boardings;
        s.boardings = 0;
      }
    }
  }

  /** Passengers currently waiting, riding and walking to or from stops. */
  get passengers(): { waiting: number; riding: number; walking: number } {
    let waiting = 0;
    let riding = 0;
    for (const s of this.stops) waiting += s.waiting.length;
    for (const st of this.bus.values()) riding += st.riders.length;
    return { waiting, riding, walking: this.walking.length };
  }
}
