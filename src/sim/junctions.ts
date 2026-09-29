import { isLeftTurn, type Arm, type Conflict, type Connector, type ControlKind, type RoadNode } from '../roads/network';
import type { JunctionSetting, SignKind } from '../roads/settings';
import { dirDiff, opposite } from '../world/grid';
import { defaultSignalPlan, groupOfConnector, SignalController } from './signals';
import type { Vehicle } from './vehicle';

export const PRIO_STOP = 0;
export const PRIO_YIELD = 1;
export const PRIO_MAIN = 2;

/** Gap (seconds) a yielding driver wants before a priority vehicle reaches the conflict point. */
const GAP_TIME = 2.6;

const isRingArm = (a: Arm): boolean => a.segment.type.key.startsWith('ring');

/** True if connector B comes from the right of connector A's approach. */
function fromRight(a: Connector, b: Connector): boolean {
  const travel = opposite(a.inArm.dir);
  const k = (b.inArm.dir - travel + 8) & 7;
  return k >= 1 && k <= 3;
}

/** Right-of-way rules and entry permission for one junction. */
export class JunctionControl {
  readonly kind: ControlKind;
  readonly signal: SignalController | null = null;
  readonly prio = new Map<Arm, number>();
  readonly groupOf = new Map<Connector, string>();
  readonly ring: boolean;
  /** Queue order for all-way stops. */
  private stamp = 0;
  /** Total vehicles let through (statistics). */
  passed = 0;

  constructor(
    readonly node: RoadNode,
    setting: JunctionSetting | undefined,
  ) {
    this.ring = node.arms.some(isRingArm);
    let kind: ControlKind = setting?.control ?? 'auto';
    if (kind === 'roundabout') kind = 'auto';
    if (this.ring) kind = 'roundabout';
    if (kind === 'signals' && node.arms.filter((a) => a.ins.length > 0).length < 2) kind = 'auto';
    this.kind = kind;
    this.computePriorities(setting?.signs);
    if (kind === 'signals') {
      this.signal = new SignalController(setting?.signalPlan ?? defaultSignalPlan(node));
      for (const c of node.connectors) this.groupOf.set(c, groupOfConnector(c));
    }
    this.assignYields();
  }

  private computePriorities(signs: Record<number, SignKind> | undefined): void {
    const arms = this.node.arms;
    const set = (a: Arm, p: number) => this.prio.set(a, p);
    if (this.kind === 'roundabout') {
      for (const a of arms) set(a, isRingArm(a) ? PRIO_MAIN : PRIO_YIELD);
      return;
    }
    if (this.kind === 'allstop') {
      for (const a of arms) set(a, PRIO_STOP);
      return;
    }
    if (this.kind === 'signals') {
      for (const a of arms) set(a, PRIO_MAIN);
      return;
    }
    if (this.kind === 'priority') {
      for (const a of arms) {
        const s = signs?.[a.dir] ?? 'main';
        set(a, s === 'main' ? PRIO_MAIN : s === 'yield' ? PRIO_YIELD : PRIO_STOP);
      }
      return;
    }
    // Automatic: the bigger road (or the through road of a T) has priority.
    for (const a of arms) set(a, PRIO_MAIN);
    if (arms.length <= 2) return;
    const rank = (a: Arm) => a.segment.type.rank;
    const sorted = [...arms].sort((p, q) => rank(q) - rank(p));
    const top = rank(sorted[0]);
    const topArms = arms.filter((a) => rank(a) === top);
    let main: Arm[] = [];
    if (topArms.length === 2) main = topArms;
    else if (topArms.length === 1) {
      const rest = arms.filter((a) => a !== topArms[0]);
      const r2 = Math.max(...rest.map(rank));
      const cands = rest.filter((a) => rank(a) === r2);
      cands.sort((p, q) => dirDiff(q.dir, topArms[0].dir) - dirDiff(p.dir, topArms[0].dir));
      main = [topArms[0], cands[0]];
    } else if (arms.length === 3) {
      let best: Arm[] = [];
      let bestD = -1;
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++) {
          const d = dirDiff(arms[i].dir, arms[j].dir);
          if (d > bestD) {
            bestD = d;
            best = [arms[i], arms[j]];
          }
        }
      main = best;
    } else {
      // Four or more equal roads: priority to the right for everyone.
      for (const a of arms) set(a, PRIO_YIELD);
      return;
    }
    for (const a of arms) set(a, main.includes(a) ? PRIO_MAIN : PRIO_YIELD);
  }

  /** Decides for every conflict which side gives way. */
  assignYields(): void {
    for (const c of this.node.connectors) {
      for (const x of c.conflicts) x.yields = this.yieldsTo(c, x.other, x);
    }
  }

  private turnRule(a: Connector, b: Connector, x: Conflict): boolean {
    if (a.inArm === b.inArm) return a.from.index > b.from.index;
    if (x.kind === 'merge') {
      if (a.turn !== 0 && b.turn === 0) return true;
      if (a.turn === 0 && b.turn !== 0) return false;
      return fromRight(a, b);
    }
    if (dirDiff(a.inArm.dir, b.inArm.dir) >= 3) {
      const la = isLeftTurn(a.turn) || a.turn === 4;
      const lb = isLeftTurn(b.turn) || b.turn === 4;
      if (la && !lb) return true;
      if (!la && lb) return false;
    }
    return fromRight(a, b);
  }

  private yieldsTo(a: Connector, b: Connector, x: Conflict): boolean {
    if (this.kind === 'signals') {
      const ga = this.groupOf.get(a)!;
      const gb = this.groupOf.get(b)!;
      if (!this.signal!.greenTogether(ga, gb)) return false;
      return this.turnRule(a, b, x);
    }
    if (this.kind === 'allstop') return false;
    const pa = this.prio.get(a.inArm) ?? PRIO_MAIN;
    const pb = this.prio.get(b.inArm) ?? PRIO_MAIN;
    const la = pa === PRIO_STOP ? PRIO_YIELD : pa;
    const lb = pb === PRIO_STOP ? PRIO_YIELD : pb;
    if (la !== lb) return la < lb;
    return this.turnRule(a, b, x);
  }

  mustStop(arm: Arm): boolean {
    return this.prio.get(arm) === PRIO_STOP;
  }

  /** Signal colour for a connector (green if the junction has no lights). */
  lightFor(c: Connector): 'green' | 'amber' | 'red' {
    if (!this.signal) return 'green';
    return this.signal.colorOf(this.groupOf.get(c) ?? '');
  }

  nextStamp(): number {
    return ++this.stamp;
  }

  /**
   * Decides whether vehicle `v`, `dist` meters before the stop line, may enter connector `c` now.
   */
  canEnter(v: Vehicle, c: Connector, dist: number): boolean {
    // 1. Signals and signs.
    if (this.signal) {
      const col = this.lightFor(c);
      if (col === 'red') return false;
      if (col === 'amber') {
        const stopDist = (v.v * v.v) / (2 * v.bComf);
        if (stopDist < dist - 1) return false;
      }
    }
    if (this.mustStop(c.inArm) && !v.stoppedAtLine) return false;

    // 2. Room behind the junction ("don't block the box"). Circulating roundabout traffic keeps
    // moving as a whole, so it only needs the space vacated by the vehicle ahead.
    const ringThrough = c.inArm.dir === 8 && c.outArm.dir === 9;
    if (!ringThrough) {
      const out = c.to;
      let free = out.length;
      const tail = out.vehicles[out.vehicles.length - 1];
      if (tail) free = tail.s - tail.length + (tail.v > 1 ? tail.v * 1.5 : 0);
      for (const ic of out.ins) {
        for (const w of ic.vehicles) free -= w.length + 1.5;
        for (const w of ic.granted) if (w !== v) free -= w.length + 1.5;
      }
      const need = Math.min(v.length + 1.5, out.length * 0.9);
      if (free < need) return false;
    }

    // 3. Conflicts with vehicles already inside or committed, and with priority traffic.
    const vEnter = Math.max(v.v, 1);
    const tStop = dist / vEnter;
    for (const x of c.conflicts) {
      const o = x.other;
      for (const w of o.vehicles) {
        if (w.s - w.length < x.sOther + 0.5) return false;
      }
      for (const w of o.granted) {
        if (w !== v) return false;
      }
      if (x.yields || this.kind === 'allstop') {
        for (const w of o.approaching) {
          if (w === v) continue;
          if (this.kind === 'allstop') {
            if (w.stoppedAtLine && w.arrivalStamp < v.arrivalStamp) return false;
            continue;
          }
          if (w.v < 0.8 && w.distToStop > 1.5) continue; // stopped and waiting: not a threat
          if (w.v < 0.3) continue;
          const tw = (w.distToStop + x.sOther) / Math.max(w.v, 0.5);
          const clear = tStop + (x.s + v.length + 2) / Math.max(3, Math.min(c.maxSpeed, vEnter + 2));
          if (tw < clear + GAP_TIME * 0.5) return false;
        }
      }
    }
    return true;
  }
}
