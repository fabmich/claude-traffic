import { isRightTurn, type Connector, type RoadNode } from '../roads/network';
import type { SignalPlanSetting } from '../roads/settings';
import { dirDiff } from '../world/grid';

/** Movement class of a turn for signal groups: 0 right, 1 straight, 2 left / U-turn. */
export const movementOf = (turn: number): number => (isRightTurn(turn) ? 0 : turn === 0 ? 1 : 2);
export const MOVEMENT_NAMES = ['right', 'straight', 'left'];
export const groupKey = (armDir: number, movement: number): string => `${armDir}:${movement}`;
export const groupOfConnector = (c: Connector): string => groupKey(c.inArm.dir, movementOf(c.turn));

export type LightColor = 'green' | 'amber' | 'red';

/** Default plan: one phase per pair of opposite approaches (all movements), others alone. */
export function defaultSignalPlan(node: RoadNode): SignalPlanSetting {
  const arms = node.arms.filter((a) => a.ins.length > 0);
  const used = new Set<number>();
  const phases: SignalPlanSetting['phases'] = [];
  for (const a of arms) {
    if (used.has(a.dir)) continue;
    used.add(a.dir);
    let best: (typeof arms)[number] | null = null;
    let bestDiff = 2;
    for (const b of arms) {
      if (used.has(b.dir)) continue;
      const d = dirDiff(a.dir, b.dir);
      if (d > bestDiff) {
        bestDiff = d;
        best = b;
      }
    }
    const groups = [0, 1, 2].map((m) => groupKey(a.dir, m));
    if (best) {
      used.add(best.dir);
      groups.push(...[0, 1, 2].map((m) => groupKey(best!.dir, m)));
    }
    phases.push({ green: 18, groups });
  }
  return { phases, actuated: true };
}

/** Fixed-time or actuated traffic light controller for one junction. */
export class SignalController {
  phases: Array<{ green: number; groups: Set<string> }>;
  actuated: boolean;
  phaseIdx = 0;
  state: 'green' | 'amber' | 'allred' = 'green';
  t = 0;
  minGreen = 6;
  maxGreen = 40;
  amber = 3;
  allRed = 1.5;
  /** Seconds since the green groups last had approaching traffic (for gap-out). */
  private gap = 0;

  constructor(plan: SignalPlanSetting) {
    this.phases = plan.phases.map((p) => ({ green: Math.max(4, p.green), groups: new Set(p.groups) }));
    if (this.phases.length === 0) this.phases.push({ green: 20, groups: new Set() });
    this.actuated = plan.actuated;
  }

  get phase(): { green: number; groups: Set<string> } {
    return this.phases[this.phaseIdx];
  }

  colorOf(group: string): LightColor {
    if (this.state === 'allred') return 'red';
    if (!this.phase.groups.has(group)) return 'red';
    return this.state === 'green' ? 'green' : 'amber';
  }

  /** True if two groups are ever green at the same time. */
  greenTogether(a: string, b: string): boolean {
    return this.phases.some((p) => p.groups.has(a) && p.groups.has(b));
  }

  /**
   * Advances the controller. `demand(groups, near)` reports whether vehicles are approaching the
   * given groups (within a short distance if `near`).
   */
  step(dt: number, demand: (groups: Set<string>, near: boolean) => boolean): void {
    this.t += dt;
    const ph = this.phase;
    if (this.state === 'green') {
      if (this.phases.length === 1) return;
      const minG = this.actuated ? this.minGreen : ph.green;
      const maxG = this.actuated ? Math.max(ph.green, this.maxGreen) : ph.green;
      if (this.actuated) {
        if (demand(ph.groups, true)) this.gap = 0;
        else this.gap += dt;
      }
      if (this.t < minG) return;
      let end = this.t >= maxG;
      if (this.actuated && !end) {
        const others = this.phases.some((p, i) => i !== this.phaseIdx && demand(p.groups, false));
        end = others && this.gap > 2.0;
      }
      if (end) {
        this.state = 'amber';
        this.t = 0;
      }
    } else if (this.state === 'amber') {
      if (this.t >= this.amber) {
        this.state = 'allred';
        this.t = 0;
      }
    } else if (this.t >= this.allRed) {
      let next = (this.phaseIdx + 1) % this.phases.length;
      if (this.actuated) {
        for (let k = 0; k < this.phases.length; k++) {
          const i = (this.phaseIdx + 1 + k) % this.phases.length;
          if (demand(this.phases[i].groups, false)) {
            next = i;
            break;
          }
        }
      }
      this.phaseIdx = next;
      this.state = 'green';
      this.t = 0;
      this.gap = 0;
    }
  }

  /** Seconds until the current state changes (for display). */
  remaining(): number {
    if (this.state === 'amber') return this.amber - this.t;
    if (this.state === 'allred') return this.allRed - this.t;
    return Math.max(0, this.phase.green - this.t);
  }
}
