import { opposite } from '../world/grid';
import { isLeftTurn, isRightTurn, type Arm, type Lane, type RoadNode } from './network';

export interface LanePair {
  from: Lane;
  to: Lane;
  inArm: Arm;
  outArm: Arm;
  turn: number;
}

/** Turn index for travelling in through `inArm` and out through `outArm`. */
export function turnIndex(inArm: Arm, outArm: Arm): number {
  const travel = opposite(inArm.dir);
  return (outArm.dir - travel + 8) & 7;
}

/** Ordering from the sharpest right turn (0) to the U-turn (7). */
export const rightToLeftOrder = (k: number): number => (3 - k + 8) & 7;

/** Exits reachable from an arm, sorted right to left. U-turns only at dead ends. */
export function exitsFor(node: RoadNode, inArm: Arm): Array<{ arm: Arm; k: number }> {
  const deadEnd = node.arms.length === 1;
  const exits: Array<{ arm: Arm; k: number }> = [];
  for (const arm of node.arms) {
    if (arm.outs.length === 0) continue;
    const k = turnIndex(inArm, arm);
    if (arm === inArm && !deadEnd) continue;
    if (k === 4 && !deadEnd) continue;
    exits.push({ arm, k });
  }
  exits.sort((a, b) => rightToLeftOrder(a.k) - rightToLeftOrder(b.k));
  return exits;
}

/** All exits including U-turns (used by the lane editor). */
export function allExitsFor(node: RoadNode, inArm: Arm): Array<{ arm: Arm; k: number }> {
  const exits: Array<{ arm: Arm; k: number }> = [];
  for (const arm of node.arms) {
    if (arm.outs.length === 0) continue;
    exits.push({ arm, k: turnIndex(inArm, arm) });
  }
  exits.sort((a, b) => rightToLeftOrder(a.k) - rightToLeftOrder(b.k));
  return exits;
}

/**
 * Default lanes an incoming lane uses to reach exit `k` with `m` outgoing lanes, given the
 * c incoming lanes (curb first) that serve this exit.
 */
export function targetLanes(inLaneRank: number, c: number, m: number, k: number): number[] {
  if (m <= 0) return [];
  if (k === 0 || (!isRightTurn(k) && !isLeftTurn(k) && k !== 4)) {
    // Straight: proportional mapping; fan out when there are more outgoing lanes.
    if (c >= m) {
      return [c === 1 ? 0 : Math.round((inLaneRank * (m - 1)) / (c - 1))];
    }
    const res: number[] = [];
    for (let o = 0; o < m; o++) {
      const feeder = m === 1 ? 0 : Math.round((o * (c - 1)) / (m - 1));
      if (feeder === inLaneRank) res.push(o);
    }
    return res;
  }
  if (isRightTurn(k)) return [Math.min(inLaneRank, m - 1)];
  if (isLeftTurn(k)) return [Math.max(0, m - c + inLaneRank)];
  // U-turn: same index keeps paths from crossing.
  return [Math.min(inLaneRank, m - 1)];
}

/** Which exits each incoming lane serves by default (index into `exits`). */
export function defaultLaneExits(n: number, exits: Array<{ arm: Arm; k: number }>): number[][] {
  const E = exits.length;
  const result: number[][] = [];
  if (E === 0) {
    for (let i = 0; i < n; i++) result.push([]);
    return result;
  }
  if (n === 1) return [exits.map((_, j) => j)];
  // Weighted interval overlap: straight exits weigh more so they get more lanes.
  const weights = exits.map((e) => (e.k === 0 ? 2 * Math.max(1, e.arm.outs.length) : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const bounds: number[] = [0];
  for (const w of weights) bounds.push(bounds[bounds.length - 1] + w / total);
  for (let i = 0; i < n; i++) {
    const l0 = i / n;
    const l1 = (i + 1) / n;
    const list: number[] = [];
    for (let j = 0; j < E; j++) {
      const overlap = Math.min(l1, bounds[j + 1]) - Math.max(l0, bounds[j]);
      if (overlap > 1e-6) list.push(j);
    }
    if (list.length === 0) list.push(Math.min(E - 1, Math.floor(((l0 + l1) / 2) * E)));
    result.push(list);
  }
  return result;
}

/** Default lane-to-lane connections for a node (before user overrides). */
export function defaultConnections(node: RoadNode): LanePair[] {
  const pairs: LanePair[] = [];
  if (node.outside) return pairs;
  for (const inArm of node.arms) {
    const n = inArm.ins.length;
    if (n === 0) continue;
    const exits = exitsFor(node, inArm);
    const laneExits = defaultLaneExits(n, exits);
    exits.forEach((exit, j) => {
      const serving: number[] = [];
      for (let i = 0; i < n; i++) if (laneExits[i].includes(j)) serving.push(i);
      const c = serving.length;
      serving.forEach((laneIdx, rank) => {
        for (const o of targetLanes(rank, c, exit.arm.outs.length, exit.k)) {
          pairs.push({ from: inArm.ins[laneIdx], to: exit.arm.outs[o], inArm, outArm: exit.arm, turn: exit.k });
        }
      });
    });
  }
  return pairs;
}

/** Connections from a custom lane assignment (list of [outDir, outLane]) for one incoming lane. */
export function customPairs(node: RoadNode, inArm: Arm, laneIdx: number, targets: Array<[number, number]>): LanePair[] {
  const out: LanePair[] = [];
  const from = inArm.ins[laneIdx];
  if (!from) return out;
  for (const [dir, idx] of targets) {
    const outArm = node.armByDir(dir);
    if (!outArm) continue;
    const to = outArm.outs[idx];
    if (!to) continue;
    out.push({ from, to, inArm, outArm, turn: turnIndex(inArm, outArm) });
  }
  return out;
}
