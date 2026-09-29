import { KMH, LANE_W } from '../config';
import { Polyline } from '../core/polyline';
import { targetLanes } from './laneDefaults';
import { Lane, Segment, type Arm, type Network, type RoadNode } from './network';
import { RoadNode as RoadNodeClass } from './network';
import { ROAD_TYPES } from './roadTypes';
import type { JunctionSettings } from './settings';

export const RING_IN = 8;
export const RING_OUT = 9;

export interface RingPlan {
  center: RoadNode;
  subs: RoadNode[];
  radius: number;
  lanes: number;
  typeId: number;
  halfWidth: number;
  trim: number;
}

/** Ring geometry for a roundabout at a node with `arms` arms. */
export function ringSpec(arms: number, large: boolean): { radius: number; lanes: number; typeId: number; halfWidth: number; trim: number } {
  const big = large || arms > 4;
  const lanes = big ? 2 : 1;
  return {
    radius: big ? 20 : 8.8,
    lanes,
    typeId: big ? 9 : 8,
    halfWidth: (lanes * LANE_W) / 2 + 0.8,
    trim: big ? 3.4 : 2.2,
  };
}

/**
 * Replaces roundabout nodes by one ring node per arm. Arms are moved to the ring nodes and their
 * trims set so approach lanes end just outside the ring. Returns the plans and the new node list.
 */
export function planRoundabouts(nodes: RoadNode[], settings: JunctionSettings): { plans: RingPlan[]; nodes: RoadNode[] } {
  const plans: RingPlan[] = [];
  const out: RoadNode[] = [];
  for (const n of nodes) {
    const st = settings.get(n.tile);
    if (st?.control !== 'roundabout' || n.outside || n.arms.length === 0) {
      out.push(n);
      continue;
    }
    const spec = ringSpec(n.arms.length, !!st.roundaboutLarge);
    const subs: RoadNode[] = [];
    n.arms.forEach((arm, i) => {
      const sub = new RoadNodeClass(0, n.tile, n.x + arm.ux * spec.radius, n.y + arm.uy * spec.radius, `${n.tile}r${i}`);
      sub.ringOf = n.tile;
      sub.ringRadius = spec.radius;
      sub.control = 'roundabout';
      arm.node = sub;
      arm.trim = spec.radius + spec.halfWidth + 1.2;
      sub.arms.push(arm);
      subs.push(sub);
      out.push(sub);
    });
    plans.push({ center: n, subs, ...spec });
  }
  out.forEach((n, i) => (n.id = i));
  return { plans, nodes: out };
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): Polyline {
  const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)));
  const xs = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    xs[i] = cx + Math.cos(a) * r;
    ys[i] = cy + Math.sin(a) * r;
  }
  return new Polyline(xs, ys);
}

/** Builds the one-way ring segments (counter-clockwise on screen) between consecutive ring nodes. */
export function buildRingSegments(net: Network, plan: RingPlan): void {
  const { center, subs } = plan;
  const type = ROAD_TYPES[plan.typeId];
  const k = subs.length;
  const angle = (s: RoadNode): number => Math.atan2(s.y - center.y, s.x - center.x);
  for (let i = 0; i < k; i++) {
    const a = subs[i];
    const b = subs[(i - 1 + k) % k];
    const a0 = angle(a);
    let a1 = angle(b);
    while (a1 >= a0 - 1e-6) a1 -= Math.PI * 2;
    const poly = arc(center.x, center.y, plan.radius, a0, a1);
    let trim = plan.trim;
    if (poly.length < 2 * trim + 2) trim = Math.max(0.5, (poly.length - 2) / 2);
    const key = `${center.tile}r${i}`;
    const speed = type.speedKmh * KMH;
    const seg = new Segment(net.segments.length, key, type, a, b, [center.tile, center.tile], poly, trim, trim, speed, false, false);
    net.segments.push(seg);
    net.segByKey.set(key, seg);
    const cut = poly.slice(trim, poly.length - trim);
    for (let li = 0; li < plan.lanes; li++) {
      const off = ((plan.lanes - 1) / 2 - li) * LANE_W;
      const lane = new Lane(net.lanes.length, `${key}|F${li}`, seg, true, li, off, cut.offset(off), speed);
      net.lanes.push(lane);
      net.laneByKey.set(lane.key, lane);
      seg.forward.push(lane);
    }
    seg.forward.forEach((l, li) => {
      l.left = seg.forward[li + 1] ?? null;
      l.right = seg.forward[li - 1] ?? null;
    });
    const h0 = cut.startHeading();
    const h1 = cut.endHeading();
    const outArm: Arm = {
      node: a,
      dir: RING_OUT,
      segment: seg,
      atStart: true,
      ins: [],
      outs: seg.forward,
      trim,
      halfWidth: plan.halfWidth,
      ux: Math.cos(h0),
      uy: Math.sin(h0),
      nIn: 0,
      nOut: plan.lanes,
    };
    const inArm: Arm = {
      node: b,
      dir: RING_IN,
      segment: seg,
      atStart: false,
      ins: seg.forward,
      outs: [],
      trim,
      halfWidth: plan.halfWidth,
      ux: -Math.cos(h1),
      uy: -Math.sin(h1),
      nIn: plan.lanes,
      nOut: 0,
    };
    a.arms.push(outArm);
    b.arms.push(inArm);
    for (const l of seg.forward) {
      l.fromNode = a;
      l.toNode = b;
      l.fromArm = outArm;
      l.toArm = inArm;
    }
    const bb = poly.bbox();
    const pad = plan.halfWidth + 2;
    seg.bbox = { x0: bb.x0 - pad, y0: bb.y0 - pad, x1: bb.x1 + pad, y1: bb.y1 + pad };
  }
  net.roundabouts.set(center.tile, { nodes: subs, x: center.x, y: center.y, radius: plan.radius, halfWidth: plan.halfWidth });
}

/** Lane pairs at a ring node: circulate, exit to the arm, enter from the arm. */
export function ringLanePairs(node: RoadNode): Array<{ from: Lane; to: Lane; inArm: Arm; outArm: Arm; turn: number }> {
  const rin = node.arms.find((a) => a.dir === RING_IN);
  const rout = node.arms.find((a) => a.dir === RING_OUT);
  const arm = node.arms.find((a) => a.dir < 8);
  const pairs: Array<{ from: Lane; to: Lane; inArm: Arm; outArm: Arm; turn: number }> = [];
  if (!rin || !rout) return pairs;
  const n = rout.outs.length;
  rin.ins.forEach((l, j) => pairs.push({ from: l, to: rout.outs[Math.min(j, n - 1)], inArm: rin, outArm: rout, turn: 0 }));
  if (arm) {
    const m = arm.outs.length;
    if (m > 0) rin.ins.forEach((l, j) => pairs.push({ from: l, to: arm.outs[Math.min(j, m - 1)], inArm: rin, outArm: arm, turn: 2 }));
    const c = arm.ins.length;
    arm.ins.forEach((l, j) => {
      for (const o of targetLanes(j, c, n, 0)) pairs.push({ from: l, to: rout.outs[o], inArm: arm, outArm: rout, turn: 2 });
    });
  }
  return pairs;
}

/** Outline around a ring node covering the entry and exit area. */
export function ringNodePolygon(node: RoadNode, halfWidth: number): number[] {
  const r = halfWidth + 2.4;
  const pts: number[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    pts.push(node.x + Math.cos(a) * r, node.y + Math.sin(a) * r);
  }
  return pts;
}
