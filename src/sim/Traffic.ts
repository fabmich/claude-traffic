import { LANE_W, TILE } from '../config';
import type { PointOut } from '../core/polyline';
import { Rng } from '../core/rng';
import { isLeftTurn, isRightTurn, type Connector, type Lane, type Network, type RoadNode } from '../roads/network';
import type { JunctionSettings } from '../roads/settings';
import { JunctionControl } from './junctions';
import { B_MAX, CAR_COLORS, KIND_PARAMS, TRUCK_COLORS, VKind, type VKindId } from './params';
import { dsOf, dsOfLane, Router } from './routing';
import { Vehicle, type Destination, type Leg, type TripHandler } from './vehicle';

export interface TrafficSettings {
  despawnStuck: boolean;
  /** Seconds a vehicle may be stuck before it is removed. */
  stuckTime: number;
  maxVehicles: number;
}

export interface SpawnOrigin {
  lane: Lane;
  s: number;
}

export interface SpawnRequest {
  kind: VKindId;
  origins: SpawnOrigin[];
  dests: Destination[];
  onTrip?: TripHandler;
  data?: unknown;
  color?: string;
  /** Called if the vehicle could not be spawned (no route or no gap for too long). */
  onFail?: (reason: 'noroute' | 'timeout' | 'cap') => void;
  created?: number;
}

export interface TrafficStats {
  spawned: number;
  arrived: number;
  despawnedStuck: number;
  noRoute: number;
  /** Average of speed / desired speed over moving and waiting vehicles (0..1). */
  flow: number;
}

const tmp: PointOut = { x: 0, y: 0, a: 0 };

/** Intelligent Driver Model acceleration towards a leader `gap` meters ahead approaching at `dv`. */
function idm(v: Vehicle, v0: number, gap: number, dv: number): number {
  const sStar = v.s0 + Math.max(0, v.v * v.T + (v.v * dv) / (2 * Math.sqrt(v.aMax * v.bComf)));
  const r = v.v / Math.max(0.1, v0);
  const r2 = r * r;
  const g = Math.max(gap, 0.1);
  return v.aMax * (1 - r2 * r2 - (sStar / g) * (sStar / g));
}

function idmFree(v: Vehicle, v0: number): number {
  const r = v.v / Math.max(0.1, v0);
  const r2 = r * r;
  const a = v.aMax * (1 - r2 * r2);
  return Math.max(a, -v.bComf);
}

/** Microscopic traffic simulation on a compiled road network. */
export class TrafficSim {
  vehicles: Vehicle[] = [];
  net: Network;
  router: Router;
  controls: JunctionControl[] = [];
  time = 0;
  tick = 0;
  private nextId = 1;
  private rng: Rng;
  private pending: SpawnRequest[] = [];
  private statTimer = 0;
  stats: TrafficStats = { spawned: 0, arrived: 0, despawnedStuck: 0, noRoute: 0, flow: 1 };
  settings: TrafficSettings = { despawnStuck: true, stuckTime: 180, maxVehicles: 4000 };
  /** Called when a vehicle is removed without arriving (despawned or its road vanished). */
  onRemoved: ((v: Vehicle, reason: string) => void) | null = null;

  constructor(net: Network, junctions: JunctionSettings, seed: number) {
    this.net = net;
    this.rng = new Rng(seed ^ 0x7f4a7c15);
    this.router = this.buildRouter(net);
    this.buildControls(junctions);
  }

  private buildRouter(net: Network): Router {
    return new Router(net, (c) => this.turnPenalty(c));
  }

  /** Static routing penalty for using a connector (turn type and junction control). */
  private turnPenalty(c: Connector): number {
    let p = 0.3;
    if (isRightTurn(c.turn)) p += 1;
    else if (isLeftTurn(c.turn)) p += 2.5;
    else if (c.turn === 4) p += 12;
    const ctrl = this.controls?.[c.node.id];
    if (ctrl) {
      if (ctrl.kind === 'signals') p += 7;
      else if (ctrl.kind === 'allstop') p += 5;
      else if (ctrl.prio.get(c.inArm) === 0) p += 4;
      else if (ctrl.prio.get(c.inArm) === 1) p += 1.5;
    }
    return p;
  }

  private buildControls(junctions: JunctionSettings): void {
    this.controls = this.net.nodes.map((n) => new JunctionControl(n, junctions.get(n.ringOf ?? n.tile)));
    // Rebuild router so turn penalties reflect the controls.
    this.router = this.buildRouter(this.net);
  }

  control(node: RoadNode): JunctionControl {
    return this.controls[node.id];
  }

  get count(): number {
    return this.vehicles.length;
  }

  // ---------------------------------------------------------------- network changes

  /** Switches to a recompiled network, keeping vehicles whose roads still exist. */
  setNetwork(net: Network, junctions: JunctionSettings): void {
    const old = this.vehicles;
    this.net = net;
    this.buildControls(junctions);
    for (const l of net.lanes) l.vehicles = [];
    this.vehicles = [];
    for (const v of old) {
      let ok = true;
      if (v.lane) {
        const nl = net.laneByKey.get(v.lane.key);
        if (nl) {
          v.lane = nl;
          v.s = Math.min(v.s, nl.length - 0.05);
        } else ok = false;
      } else if (v.conn) {
        const nc = net.connectorByKey.get(v.conn.key);
        if (nc) v.conn = nc;
        else {
          const nl = net.laneByKey.get(v.conn.to.key);
          if (nl) {
            v.conn = null;
            v.lane = nl;
            v.s = Math.min(1, nl.length);
            v.routeIdx++;
          } else ok = false;
        }
      }
      if (ok && v.dest) {
        const seg = net.segByKey.get(v.dest.seg.key);
        const lanes = seg ? (v.dest.forward ? seg.forward : seg.backward) : [];
        if (seg && lanes.length) v.dest = { ...v.dest, seg, s: Math.min(v.dest.s, lanes[0].length - 1) };
        else ok = false;
      }
      if (!ok) {
        this.finish(v, false, 'road removed', false);
        continue;
      }
      v.prevLane = null;
      v.prevConn = null;
      v.granted = null;
      v.nextConn = null;
      v.mergeTarget = null;
      const legs: Leg[] = [];
      for (const leg of v.route) {
        const seg = net.segByKey.get(leg.seg.key);
        if (!seg) {
          v.needsReroute = true;
          break;
        }
        legs.push({ seg, forward: leg.forward });
      }
      v.route = legs;
      v.listIndex = this.vehicles.length;
      this.vehicles.push(v);
      if (v.lane) v.lane.vehicles.push(v);
      else if (v.conn) v.conn.vehicles.push(v);
      if (v.lane && !this.legMatchesLane(v)) v.needsReroute = true;
    }
    for (const l of net.lanes) l.vehicles.sort((a, b) => b.s - a.s);
    for (const c of net.connectors) c.vehicles.sort((a, b) => b.s - a.s);
    this.pending = this.pending.filter((r) => r.origins.every((o) => net.laneByKey.get(o.lane.key)));
    for (const r of this.pending) r.origins = r.origins.map((o) => ({ lane: net.laneByKey.get(o.lane.key)!, s: o.s }));
  }

  private legMatchesLane(v: Vehicle): boolean {
    const leg = v.currentLeg;
    return !!leg && !!v.lane && leg.seg === v.lane.segment && leg.forward === v.lane.forward;
  }

  // ---------------------------------------------------------------- spawning

  /** Queues a trip; the vehicle appears as soon as there is a safe gap. */
  request(req: SpawnRequest): void {
    req.created = this.time;
    this.pending.push(req);
  }

  private trySpawn(req: SpawnRequest): 'ok' | 'wait' | 'fail' {
    if (this.vehicles.length >= this.settings.maxVehicles) {
      req.onFail?.('cap');
      return 'fail';
    }
    const kind = req.kind;
    const p = KIND_PARAMS[kind];
    const length = p.length[0] + this.rng.next() * (p.length[1] - p.length[0]);
    const origins = req.origins.filter((o) => o.lane.length > 0);
    if (origins.length === 0) return 'fail';
    const seed = this.rng.int(1 << 30);
    const res = this.router.route(
      kind,
      origins.map((o) => ({ ds: dsOfLane(o.lane), s: o.s })),
      req.dests,
      seed,
      p.vMax,
    );
    if (!res) {
      this.stats.noRoute++;
      req.onFail?.('noroute');
      return 'fail';
    }
    const firstDs = dsOf(res.legs[0].seg, res.legs[0].forward);
    const origin = origins.find((o) => dsOfLane(o.lane) === firstDs) ?? origins[0];
    // Spawn in the lane of that direction with the most room at the origin.
    const lanes = res.legs[0].forward ? res.legs[0].seg.forward : res.legs[0].seg.backward;
    const s = Math.max(origin.s, length + 0.2);
    let best: Lane | null = null;
    let bestRoom = -Infinity;
    for (const lane of lanes) {
      if (lane.busOnly && kind !== VKind.Bus) continue;
      const room = this.roomAt(lane, Math.min(s, lane.length - 0.5), length);
      if (room > bestRoom) {
        bestRoom = room;
        best = lane;
      }
      if (origin.lane === lane && room > 0) {
        best = lane;
        break;
      }
    }
    if (!best || bestRoom <= 0) return 'wait';
    const v = new Vehicle(this.nextId++, kind);
    v.length = length;
    v.width = p.width;
    v.vMax = p.vMax;
    v.aMax = p.a * (0.9 + this.rng.next() * 0.2);
    v.bComf = p.b;
    v.T = p.T[0] + this.rng.next() * (p.T[1] - p.T[0]);
    v.s0 = p.s0;
    v.politeness = p.politeness;
    v.speedFactor = 0.93 + this.rng.next() * 0.07;
    v.seed = seed;
    v.color = req.color ?? (kind === VKind.Truck ? this.rng.pick(TRUCK_COLORS) : this.rng.pick(CAR_COLORS));
    v.route = res.legs;
    v.routeIdx = 0;
    v.dest = res.dest;
    v.onTrip = req.onTrip ?? null;
    v.tripData = req.data ?? null;
    v.spawnTime = this.time;
    v.lastRoute = this.time;
    v.lane = best;
    v.s = Math.min(s, best.length - 0.1);
    v.v = Math.min(best.speedLimit * 0.5, 8);
    this.insertSorted(best.vehicles, v);
    v.listIndex = this.vehicles.length;
    this.vehicles.push(v);
    this.updatePose(v);
    v.px = v.x;
    v.py = v.y;
    v.pHeading = v.heading;
    this.stats.spawned++;
    return 'ok';
  }

  /** Free space around position s on a lane for a vehicle of `length` (<= 0 means blocked). */
  private roomAt(lane: Lane, s: number, length: number): number {
    let room = Infinity;
    for (const w of lane.vehicles) {
      if (w.s >= s) room = Math.min(room, w.s - w.length - s - 2);
      else room = Math.min(room, s - length - w.s - Math.max(3, w.v * 1.4));
    }
    return room;
  }

  private insertSorted(list: Vehicle[], v: Vehicle): void {
    let i = list.length;
    while (i > 0 && list[i - 1].s < v.s) i--;
    list.splice(i, 0, v);
  }

  private removeFrom(list: Vehicle[], v: Vehicle): void {
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
  }

  /** Removes a vehicle; `arrived` tells the trip callback whether it reached its destination. */
  private finish(v: Vehicle, arrived: boolean, reason: string, unlink = true): void {
    if (unlink) {
      if (v.lane) this.removeFrom(v.lane.vehicles, v);
      if (v.conn) this.removeFrom(v.conn.vehicles, v);
      if (v.granted) this.removeFrom(v.granted.granted, v);
      if (v.mergeTarget) this.removeFrom(v.mergeTarget.mergers, v);
      const i = v.listIndex;
      const last = this.vehicles.pop()!;
      if (last !== v && i >= 0 && i < this.vehicles.length + 1) {
        this.vehicles[i] = last;
        last.listIndex = i;
      }
    }
    v.listIndex = -1;
    v.lane = null;
    v.conn = null;
    if (arrived) this.stats.arrived++;
    else this.onRemoved?.(v, reason);
    v.onTrip?.(v, arrived);
  }

  /** Removes a vehicle immediately (e.g. bulldozed road). */
  remove(v: Vehicle): void {
    if (v.listIndex >= 0) this.finish(v, false, 'removed');
  }

  // ---------------------------------------------------------------- routing helpers

  private reroute(v: Vehicle): boolean {
    v.needsReroute = false;
    v.lastRoute = this.time;
    if (!v.lane || !v.dest) return false;
    const res = this.router.route(v.kind, [{ ds: dsOfLane(v.lane), s: v.s }], [v.dest], v.seed, v.vMax);
    if (!res) return false;
    v.route = res.legs;
    v.routeIdx = 0;
    v.dest = res.dest;
    v.nextConn = null;
    if (v.granted && v.granted.from === v.lane) {
      // keep the grant only if still on the route
      const nl = v.nextLeg;
      if (!nl || v.granted.to.segment !== nl.seg || v.granted.to.forward !== nl.forward) {
        this.removeFrom(v.granted.granted, v);
        v.granted = null;
      }
    }
    return true;
  }

  private allowed(v: Vehicle, lane: Lane): boolean {
    return !lane.busOnly || v.kind === VKind.Bus;
  }

  /** Connectors from `lane` that continue along the vehicle's next leg. */
  private routeConnectors(v: Vehicle, lane: Lane, legIdx: number): Connector[] {
    const next = v.route[legIdx + 1];
    if (!next) return [];
    const out: Connector[] = [];
    for (const c of lane.outs) {
      if (c.to.segment === next.seg && c.to.forward === next.forward && this.allowed(v, c.to)) out.push(c);
    }
    return out;
  }

  /** How suitable a lane is for the vehicle's route (lower is better, Infinity = unusable). */
  laneScore(v: Vehicle, lane: Lane): number {
    if (!this.allowed(v, lane)) return Infinity;
    const legIdx = v.routeIdx;
    const isFinal = legIdx >= v.route.length - 1;
    if (isFinal) {
      if (!v.dest || v.dest.outside) return lane.vehicles.length * 0.02;
      const near = v.dest.s - v.s < 150;
      return (near ? lane.index : lane.index * 0.05) + lane.vehicles.length * 0.02;
    }
    const conns = this.routeConnectors(v, lane, legIdx);
    if (conns.length === 0) return Infinity;
    let score = 0.5;
    const next2 = v.route[legIdx + 2];
    if (next2) {
      for (const c of conns) {
        if (c.to.outs.some((c2) => c2.to.segment === next2.seg && c2.to.forward === next2.forward)) {
          score = 0;
          break;
        }
      }
    } else score = 0;
    if (v.kind === VKind.Bus && lane.busOnly) score -= 0.3;
    return score + lane.vehicles.length * 0.04;
  }

  /** Chooses the connector to use at the end of the current lane. */
  private planConnector(v: Vehicle): Connector | null {
    const lane = v.lane!;
    const conns = this.routeConnectors(v, lane, v.routeIdx);
    if (conns.length === 0) return null;
    if (conns.length === 1) return conns[0];
    const next2 = v.route[v.routeIdx + 2];
    let best = conns[0];
    let bestScore = Infinity;
    for (const c of conns) {
      let sc = c.to.vehicles.length * 0.2;
      if (next2 && !c.to.outs.some((c2) => c2.to.segment === next2.seg && c2.to.forward === next2.forward)) sc += 5;
      if (c.to.busOnly && v.kind !== VKind.Bus) sc += 100;
      if (sc < bestScore) {
        bestScore = sc;
        best = c;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- simulation step

  step(dt: number): void {
    this.time += dt;
    this.tick++;
    // Signals.
    for (const ctrl of this.controls) {
      if (ctrl.signal) ctrl.signal.step(dt, (groups, near) => this.demand(ctrl, groups, near));
    }
    // Approach registry for gap acceptance.
    for (const c of this.net.connectors) if (c.approaching.length) c.approaching.length = 0;
    for (const v of this.vehicles) {
      v.distToStop = Infinity;
      if (!v.lane) continue;
      if (v.needsReroute && !this.reroute(v)) {
        if (this.time - v.lastRoute > 5) {
          v.needsReroute = true;
        }
      }
      if (!v.nextConn || v.nextConn.from !== v.lane) v.nextConn = this.planConnector(v);
      const c = v.nextConn;
      const dist = v.lane.length - v.s;
      v.distToStop = dist;
      if (c && v.granted !== c && dist < 110) c.approaching.push(v);
    }
    // Accelerations.
    for (const lane of this.net.lanes) {
      const list = lane.vehicles;
      for (let i = 0; i < list.length; i++) list[i].acc = this.accelOnLane(list[i], i > 0 ? list[i - 1] : null, dt);
    }
    for (const c of this.net.connectors) {
      const list = c.vehicles;
      for (let i = 0; i < list.length; i++) list[i].acc = this.accelOnConnector(list[i], i > 0 ? list[i - 1] : null);
    }
    // Lane changes (staggered so each vehicle decides about twice per second).
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if ((this.tick + v.id) % 5 === 0) this.laneChange(v);
    }
    // Movement.
    const moving = this.vehicles.slice();
    for (const v of moving) this.move(v, dt);
    // Spawns.
    if (this.pending.length) {
      const keep: SpawnRequest[] = [];
      const budget = 40;
      let n = 0;
      for (const r of this.pending) {
        if (n >= budget) {
          keep.push(r);
          continue;
        }
        n++;
        const res = this.trySpawn(r);
        if (res === 'wait') {
          if (this.time - (r.created ?? 0) > 60) r.onFail?.('timeout');
          else keep.push(r);
        }
      }
      this.pending = keep;
    }
    this.statTimer += dt;
    if (this.statTimer >= 1) {
      this.updateStats(this.statTimer);
      this.statTimer = 0;
    }
  }

  private demand(ctrl: JunctionControl, groups: Set<string>, near: boolean): boolean {
    for (const c of ctrl.node.connectors) {
      if (!groups.has(ctrl.groupOf.get(c) ?? '')) continue;
      for (const v of c.approaching) if (!near || v.distToStop < 35) return true;
      if (!near && c.granted.length) return true;
    }
    return false;
  }

  private desired(v: Vehicle, limit: number): number {
    return Math.max(1, Math.min(limit, v.vMax) * v.speedFactor);
  }

  private accelOnLane(v: Vehicle, leader: Vehicle | null, dt: number): number {
    const lane = v.lane!;
    const v0 = this.desired(v, lane.speedLimit);
    let acc = leader ? idm(v, v0, leader.s - leader.length - v.s, v.v - leader.v) : idmFree(v, v0);
    const dist = lane.length - v.s;
    const isFinal = v.routeIdx >= v.route.length - 1;

    // Cooperative merging: make room for vehicles that must change into this lane.
    if (lane.mergers.length) {
      for (const m of lane.mergers) {
        if (!m.lane || m.blockedTime < 0.8) continue;
        const sm = (m.s * lane.length) / Math.max(1, m.lane.length);
        const gap = sm - m.length - v.s;
        if (gap > 1.5 && gap < 45 && v.politeness > 0.1) acc = Math.min(acc, idm(v, v0, gap, v.v - m.v));
      }
    }

    if (isFinal && v.dest) {
      if (!v.dest.outside) {
        const d = v.dest.s - v.s;
        if (d < 60) acc = Math.min(acc, idm(v, v0, d + 6, v.v - 3));
        return Math.max(-B_MAX, Math.min(acc, v.aMax));
      }
      // Outside connection: drive off the end of the lane.
      return Math.max(-B_MAX, Math.min(acc, v.aMax));
    }

    const c = v.nextConn;
    if (!c) {
      // Wrong lane for the route: stop before the end and wait for a lane change.
      acc = Math.min(acc, idm(v, v0, dist - 1.5, v.v));
      v.blockedTime += dt;
      return Math.max(-B_MAX, Math.min(acc, v.aMax));
    }
    v.blockedTime = 0;
    const ctrl = this.controls[c.node.id];
    if (v.v < 0.3 && dist < 3.5) {
      if (!v.stoppedAtLine) {
        v.stoppedAtLine = true;
        v.arrivalStamp = ctrl.nextStamp();
      }
    }
    if (v.granted !== c && lane.vehicles[0] === v) {
      // Only the first vehicle of a lane asks to enter the junction.
      const reqDist = Math.max(14, (v.v * v.v) / (2 * v.bComf) + 10);
      if (dist < reqDist && ctrl.canEnter(v, c, dist)) {
        if (v.granted) this.removeFrom(v.granted.granted, v);
        v.granted = c;
        c.granted.push(v);
      }
    }
    if (v.granted !== c) {
      acc = Math.min(acc, idm(v, v0, dist - 0.8, v.v));
    } else {
      // Leaders beyond the stop line: on our connector, on sibling connectors near the start, or in the exit lane.
      let found = false;
      const lc = c.vehicles[c.vehicles.length - 1];
      if (lc) {
        acc = Math.min(acc, idm(v, v0, dist + lc.s - lc.length, v.v - lc.v));
        found = true;
      }
      for (const c2 of lane.outs) {
        if (c2 === c) continue;
        const w = c2.vehicles[c2.vehicles.length - 1];
        if (w && w.s - w.length < 3) acc = Math.min(acc, idm(v, v0, dist + w.s - w.length, v.v - w.v));
      }
      if (!found) {
        const lo = c.to.vehicles[c.to.vehicles.length - 1];
        if (lo) acc = Math.min(acc, idm(v, v0, dist + c.length + lo.s - lo.length, v.v - lo.v));
      }
      // Slow down for the turn.
      const vt = c.maxSpeed * v.speedFactor;
      if (v.v > vt) {
        const need = (v.v * v.v - vt * vt) / (2 * Math.max(0.5, dist));
        if (need > 0.2) acc = Math.min(acc, -need * 1.15);
      }
    }
    return Math.max(-B_MAX, Math.min(acc, v.aMax));
  }

  private accelOnConnector(v: Vehicle, leader: Vehicle | null): number {
    const c = v.conn!;
    const v0 = this.desired(v, c.maxSpeed);
    let acc = leader ? idm(v, v0, leader.s - leader.length - v.s, v.v - leader.v) : idmFree(v, v0);
    const dist = c.length - v.s;
    const lo = c.to.vehicles[c.to.vehicles.length - 1];
    if (!leader && lo) acc = Math.min(acc, idm(v, v0, dist + lo.s - lo.length, v.v - lo.v));
    return Math.max(-B_MAX, Math.min(acc, v.aMax));
  }

  /** Mandatory and discretionary lane changes. */
  private laneChange(v: Vehicle): void {
    const lane = v.lane;
    if (!lane || v.laneChangeCooldown > this.time) return;
    if (!lane.left && !lane.right) return;
    const dist = lane.length - v.s;
    if (v.granted && dist < 25) return;
    const cur = this.laneScore(v, lane);
    let target: Lane | null = null;
    let mandatory = false;
    if (cur === Infinity) {
      // Move towards the nearest usable lane.
      const sib = lane.siblings;
      let bestIdx = -1;
      let bestD = Infinity;
      for (const l of sib) {
        if (this.laneScore(v, l) === Infinity) continue;
        const d = Math.abs(l.index - lane.index);
        if (d < bestD) {
          bestD = d;
          bestIdx = l.index;
        }
      }
      if (bestIdx < 0) {
        v.needsReroute = true;
        return;
      }
      target = bestIdx > lane.index ? lane.left : lane.right;
      mandatory = true;
    } else {
      const left = lane.left ? this.laneScore(v, lane.left) : Infinity;
      const right = lane.right ? this.laneScore(v, lane.right) : Infinity;
      if (Math.min(left, right) < cur - 0.3) {
        target = left < right ? lane.left : lane.right;
        mandatory = dist < 120;
      } else if (dist > 60 && v.v > 2) {
        // Discretionary change (MOBIL) among equally good lanes.
        target = this.mobil(v, lane, left, right, cur);
      }
    }
    if (!target) {
      if (v.mergeTarget) {
        this.removeFrom(v.mergeTarget.mergers, v);
        v.mergeTarget = null;
      }
      return;
    }
    const urgency = mandatory ? Math.max(0, 1 - dist / 150) : 0;
    if (this.safeToChange(v, lane, target, urgency)) {
      this.executeChange(v, lane, target);
    } else if (mandatory && urgency > 0.3 && v.mergeTarget !== target) {
      if (v.mergeTarget) this.removeFrom(v.mergeTarget.mergers, v);
      v.mergeTarget = target;
      target.mergers.push(v);
    }
  }

  private neighbours(lane: Lane, s: number, self: Vehicle): { lead: Vehicle | null; follow: Vehicle | null } {
    let lead: Vehicle | null = null;
    let follow: Vehicle | null = null;
    for (const w of lane.vehicles) {
      if (w === self) continue;
      if (w.s >= s) lead = w;
      else {
        follow = w;
        break;
      }
    }
    return { lead, follow };
  }

  private safeToChange(v: Vehicle, from: Lane, to: Lane, urgency: number): boolean {
    const sT = (v.s * to.length) / Math.max(1, from.length);
    if (sT < v.length || sT > to.length - 1) return false;
    const { lead, follow } = this.neighbours(to, sT, v);
    const bSafe = 3 + urgency * 2.5;
    const v0 = this.desired(v, to.speedLimit);
    if (lead) {
      const gap = lead.s - lead.length - sT;
      if (gap < 1.5 + v.v * 0.3 * (1 - urgency)) return false;
      if (idm(v, v0, gap, v.v - lead.v) < -bSafe) return false;
    }
    if (follow) {
      const gap = sT - v.length - follow.s;
      if (gap < 1.5) return false;
      const fv0 = this.desired(follow, to.speedLimit);
      if (idm(follow, fv0, gap, follow.v - v.v) < -bSafe) return false;
    }
    return true;
  }

  private mobil(v: Vehicle, lane: Lane, left: number, right: number, cur: number): Lane | null {
    const idx = lane.vehicles.indexOf(v);
    const leader = idx > 0 ? lane.vehicles[idx - 1] : null;
    const v0 = this.desired(v, lane.speedLimit);
    const aCur = leader ? idm(v, v0, leader.s - leader.length - v.s, v.v - leader.v) : idmFree(v, v0);
    let best: Lane | null = null;
    let bestGain = 0;
    for (const [l, sc, bias] of [
      [lane.left, left, -0.2],
      [lane.right, right, 0.25],
    ] as Array<[Lane | null, number, number]>) {
      if (!l || sc > cur + 0.05) continue;
      const sT = (v.s * l.length) / Math.max(1, lane.length);
      const { lead, follow } = this.neighbours(l, sT, v);
      const aNew = lead ? idm(v, v0, lead.s - lead.length - sT, v.v - lead.v) : idmFree(v, v0);
      let dFollow = 0;
      if (follow) {
        const fv0 = this.desired(follow, l.speedLimit);
        const before = lead ? idm(follow, fv0, lead.s - lead.length - follow.s, follow.v - lead.v) : idmFree(follow, fv0);
        const after = idm(follow, fv0, sT - v.length - follow.s, follow.v - v.v);
        dFollow = after - before;
      }
      const gain = aNew - aCur + v.politeness * dFollow + bias;
      if (gain > 0.35 && gain > bestGain) {
        bestGain = gain;
        best = l;
      }
    }
    return best;
  }

  private executeChange(v: Vehicle, from: Lane, to: Lane): void {
    this.removeFrom(from.vehicles, v);
    v.s = (v.s * to.length) / Math.max(1, from.length);
    v.lane = to;
    this.insertSorted(to.vehicles, v);
    v.lat += to.index > from.index ? LANE_W : -LANE_W;
    v.nextConn = null;
    if (v.granted) {
      this.removeFrom(v.granted.granted, v);
      v.granted = null;
    }
    if (v.mergeTarget) {
      this.removeFrom(v.mergeTarget.mergers, v);
      v.mergeTarget = null;
    }
    v.laneChangeCooldown = this.time + 2.5;
    v.stoppedAtLine = false;
  }

  private move(v: Vehicle, dt: number): void {
    if (v.listIndex < 0) return;
    const acc = v.acc;
    const v1 = Math.max(0, v.v + acc * dt);
    const ds = acc < 0 && v1 === 0 ? (v.v * v.v) / (2 * Math.max(0.1, -acc)) : (v.v + v1) * 0.5 * dt;
    v.v = v1;
    v.s += Math.max(0, ds);
    v.distanceDriven += Math.max(0, ds);
    // Stuck detection.
    if (v.v < 0.3) {
      v.waitTime += dt;
      const ctrl = v.nextConn ? this.controls[v.nextConn.node.id] : null;
      const atRed = !!ctrl && ctrl.lightFor(v.nextConn!) !== 'green';
      if (v.waitTime > 30 && !atRed && this.time - v.lastRoute > 20) v.needsReroute = true;
      if (this.settings.despawnStuck && v.waitTime > this.settings.stuckTime) {
        this.stats.despawnedStuck++;
        this.finish(v, false, 'stuck');
        return;
      }
    } else if (v.v > 1) v.waitTime = 0;
    if (v.lat !== 0) {
      const step = dt * 1.8;
      v.lat = Math.abs(v.lat) <= step ? 0 : v.lat - Math.sign(v.lat) * step;
    }

    // Arrival on the destination lane.
    const isFinal = v.routeIdx >= v.route.length - 1;
    if (v.lane && isFinal && v.dest && !v.dest.outside && v.s >= v.dest.s - 0.5) {
      this.finish(v, true, 'arrived');
      return;
    }
    // Element transitions.
    for (let guard = 0; guard < 6; guard++) {
      if (v.lane && v.s > v.lane.length) {
        const lane = v.lane;
        if (isFinal && v.dest?.outside) {
          this.finish(v, true, 'arrived');
          return;
        }
        const c = v.granted;
        if (!c || c.from !== lane) {
          v.s = lane.length;
          v.v = 0;
          break;
        }
        this.removeFrom(lane.vehicles, v);
        this.removeFrom(c.granted, v);
        c.vehicles.push(v);
        const w = v.waitTime;
        lane.statWait = lane.statWait * 0.9 + Math.min(w, 120) * 0.1;
        this.controls[c.node.id].passed++;
        v.prevLane = lane;
        v.prevConn = null;
        v.lane = null;
        v.conn = c;
        v.s -= lane.length;
        v.granted = null;
        v.stoppedAtLine = false;
        if (v.mergeTarget) {
          this.removeFrom(v.mergeTarget.mergers, v);
          v.mergeTarget = null;
        }
      } else if (v.conn && v.s > v.conn.length) {
        const c = v.conn;
        this.removeFrom(c.vehicles, v);
        const out = c.to;
        v.s -= c.length;
        v.prevConn = c;
        v.prevLane = null;
        v.conn = null;
        v.lane = out;
        this.insertSorted(out.vehicles, v);
        v.routeIdx++;
        v.nextConn = null;
        if (!this.legMatchesLane(v)) v.needsReroute = true;
        else if (this.time - v.lastRoute > 90 && this.rng.chance(0.15)) v.needsReroute = true;
      } else break;
    }
    if (v.listIndex >= 0) this.updatePose(v);
  }

  /** Computes world position and heading (for rendering) from the element position. */
  updatePose(v: Vehicle): void {
    v.px = v.x;
    v.py = v.y;
    v.pHeading = v.heading;
    const el = v.lane ?? v.conn;
    if (!el) return;
    // Centre of the vehicle: half a length behind the front bumper, possibly on the previous element.
    let s = v.s - v.length / 2;
    let path = el.path;
    if (s < 0) {
      const prev = v.lane ? v.prevConn : v.prevLane;
      if (prev && prev.path) {
        s += prev.path.length;
        path = prev.path;
      } else s = 0;
    }
    v.pathHint = path.pointAt(Math.max(0, s), tmp, v.pathHint);
    let x = tmp.x;
    let y = tmp.y;
    const a = tmp.a;
    if (v.lat !== 0) {
      x -= Math.sin(a) * v.lat;
      y += Math.cos(a) * v.lat;
    }
    v.x = x;
    v.y = y;
    v.heading = a - (v.lat !== 0 ? Math.sign(v.lat) * Math.min(0.12, Math.abs(v.lat) * 0.06) : 0);
    // Layer (bridge / tunnel) for drawing.
    v.layer = 0;
    if (v.lane) {
      const seg = v.lane.segment;
      if (seg.spanRanges.length) {
        const sc = v.lane.forward ? seg.trimA + v.s : seg.center.length - seg.trimB - v.s;
        for (const r of seg.spanRanges) {
          if (sc >= r.s0 + 2 && sc <= r.s1 - 2) v.layer = r.kind === 'bridge' ? 1 : -1;
        }
      }
    }
  }

  private updateStats(dt: number): void {
    const k = Math.min(1, dt * 0.15);
    let sumRatio = 0;
    let n = 0;
    for (const lane of this.net.lanes) {
      const list = lane.vehicles;
      if (list.length === 0) {
        lane.statSpeed += (1 - lane.statSpeed) * k * 0.5;
        lane.statWait *= 1 - k * 0.3;
        continue;
      }
      let r = 0;
      for (const v of list) r += Math.min(1, v.v / Math.max(1, Math.min(lane.speedLimit, v.vMax) * v.speedFactor));
      r /= list.length;
      lane.statSpeed += (r - lane.statSpeed) * k;
      lane.statFlow = list.length;
      sumRatio += r * list.length;
      n += list.length;
    }
    for (const c of this.net.connectors) {
      for (const v of c.vehicles) {
        sumRatio += Math.min(1, v.v / Math.max(1, Math.min(c.maxSpeed, v.vMax) * v.speedFactor));
        n++;
      }
    }
    const flow = n > 0 ? sumRatio / n : 1;
    this.stats.flow += (flow - this.stats.flow) * 0.2;
  }

  /** Vehicle closest to a world point (within `radius` meters). */
  vehicleAt(x: number, y: number, radius = 4): Vehicle | null {
    let best: Vehicle | null = null;
    let bd = radius;
    for (const v of this.vehicles) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** Remaining route polylines of a vehicle (for display). */
  routePaths(v: Vehicle): Array<import('../core/polyline').Polyline> {
    const out = [];
    if (v.lane) out.push(v.lane.path.slice(v.s, v.lane.length));
    if (v.conn) out.push(v.conn.path.slice(v.s, v.conn.length));
    for (let i = v.routeIdx + (v.conn ? 1 : 0); i < v.route.length; i++) {
      const leg = v.route[i];
      const lanes = leg.forward ? leg.seg.forward : leg.seg.backward;
      if (lanes.length === 0) continue;
      const lane = lanes[Math.min(lanes.length - 1, 0)];
      if (i === v.route.length - 1 && v.dest && !v.dest.outside) out.push(lane.path.slice(0, v.dest.s));
      else if (!(v.lane && i === v.routeIdx)) out.push(lane.path);
    }
    return out;
  }

  get tileSize(): number {
    return TILE;
  }
}
