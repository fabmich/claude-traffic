import { TILE } from '../config';
import type { Arm, RoadNode } from './network';

/** Clockwise perpendicular of a direction vector in screen space (y down). */
const cwx = (_ux: number, uy: number): number => -uy;
const cwy = (ux: number, _uy: number): number => ux;

/** Desired distance from the node centre at which each arm's lanes start. */
export function computeArmTrims(node: RoadNode): void {
  const arms = node.arms;
  const m = arms.length;
  if (m === 0) return;
  if (node.outside) {
    for (const a of arms) a.trim = 0.5;
    return;
  }
  if (m === 1) {
    arms[0].trim = 1.5;
    return;
  }
  for (let i = 0; i < m; i++) {
    const a = arms[i];
    let t = 0;
    const neighbours = m === 2 ? [arms[1 - i]] : [arms[(i + m - 1) % m], arms[(i + 1) % m]];
    for (const b of neighbours) {
      // Both angular gaps to the neighbour (for m = 2 the neighbour is on both sides).
      const gaps = m === 2 ? [(b.dir - a.dir + 8) & 7, (a.dir - b.dir + 8) & 7] : [b === arms[(i + 1) % m] ? (b.dir - a.dir + 8) & 7 : (a.dir - b.dir + 8) & 7];
      for (const steps of gaps) {
        if (steps === 0 || steps >= 4) continue;
        const phi = (steps * Math.PI) / 4;
        const s = (b.halfWidth + a.halfWidth * Math.cos(phi)) / Math.sin(phi);
        t = Math.max(t, s);
      }
    }
    let trim = t + (m >= 3 ? 1.5 : 0.5);
    if (m === 2) {
      const other = arms[1 - i];
      const laneChange = a.nIn !== other.nOut || a.nOut !== other.nIn;
      trim = Math.max(trim, laneChange ? 6 : 2);
    } else {
      trim = Math.max(trim, 3);
    }
    const stepLen = (a.dir & 1 ? Math.SQRT2 : 1) * TILE;
    a.trim = Math.min(trim, stepLen * 0.62);
  }
}

function pushPt(out: number[], x: number, y: number): void {
  const n = out.length;
  if (n >= 2 && Math.abs(out[n - 2] - x) < 1e-6 && Math.abs(out[n - 1] - y) < 1e-6) return;
  out.push(x, y);
}

/** Outline polygon of the junction area (flat x, y list) plus curb polylines between arms. */
export function buildNodePolygon(node: RoadNode): { polygon: number[]; curbs: number[][] } {
  const arms = node.arms;
  const m = arms.length;
  const out: number[] = [];
  const curbs: number[][] = [];
  const cx = node.x;
  const cy = node.y;
  if (m === 0) return { polygon: out, curbs };

  const corner = (a: Arm, side: 1 | -1): [number, number] => [
    cx + a.ux * a.trim + side * cwx(a.ux, a.uy) * a.halfWidth,
    cy + a.uy * a.trim + side * cwy(a.ux, a.uy) * a.halfWidth,
  ];

  if (node.outside && m === 1) {
    // Road continues straight to the map edge behind the node.
    const a = arms[0];
    const [ax, ay] = corner(a, -1);
    const [bx, by] = corner(a, 1);
    const back = TILE * 0.5 + a.trim;
    pushPt(out, ax, ay);
    pushPt(out, bx, by);
    pushPt(out, bx - a.ux * back, by - a.uy * back);
    pushPt(out, ax - a.ux * back, ay - a.uy * back);
    curbs.push([bx, by, bx - a.ux * back, by - a.uy * back], [ax, ay, ax - a.ux * back, ay - a.uy * back]);
    return { polygon: out, curbs };
  }

  if (m === 1) {
    // Dead end: rounded turnaround bulb.
    const a = arms[0];
    const r = a.halfWidth;
    const [ax, ay] = corner(a, -1);
    const [bx, by] = corner(a, 1);
    pushPt(out, ax, ay);
    pushPt(out, bx, by);
    const curb: number[] = [bx, by];
    const start = Math.atan2(cwy(a.ux, a.uy), cwx(a.ux, a.uy));
    for (let k = 0; k <= 12; k++) {
      const ang = start + (Math.PI * k) / 12;
      const px = cx + Math.cos(ang) * r;
      const py = cy + Math.sin(ang) * r;
      pushPt(out, px, py);
      curb.push(px, py);
    }
    curb.push(ax, ay);
    curbs.push(curb);
    return { polygon: out, curbs };
  }

  const first = corner(arms[0], -1);
  pushPt(out, first[0], first[1]);
  for (let i = 0; i < m; i++) {
    const a = arms[i];
    const b = arms[(i + 1) % m];
    const [ax, ay] = corner(a, 1);
    const [bx, by] = corner(b, -1);
    pushPt(out, ax, ay);
    const curb: number[] = [ax, ay];
    const steps = (b.dir - a.dir + 8) & 7 || 8;
    if (steps < 4) {
      // Curb curve with control point where the two road edges meet.
      const den = a.ux * b.uy - a.uy * b.ux;
      let qx = (ax + bx) / 2;
      let qy = (ay + by) / 2;
      if (Math.abs(den) > 1e-6) {
        const s = ((bx - ax) * b.uy - (by - ay) * b.ux) / den;
        qx = ax + a.ux * s;
        qy = ay + a.uy * s;
      }
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        const u = 1 - t;
        const px = u * u * ax + 2 * u * t * qx + t * t * bx;
        const py = u * u * ay + 2 * u * t * qy + t * t * by;
        pushPt(out, px, py);
        curb.push(px, py);
      }
    } else if (steps > 4) {
      // Reflex corner: round it around the node centre.
      const r = Math.max(a.halfWidth, b.halfWidth);
      const p1x = cx + cwx(a.ux, a.uy) * a.halfWidth;
      const p1y = cy + cwy(a.ux, a.uy) * a.halfWidth;
      pushPt(out, p1x, p1y);
      curb.push(p1x, p1y);
      const a0 = Math.atan2(cwy(a.ux, a.uy), cwx(a.ux, a.uy));
      let a1 = Math.atan2(-cwy(b.ux, b.uy), -cwx(b.ux, b.uy));
      while (a1 <= a0) a1 += Math.PI * 2;
      const n = Math.max(3, Math.ceil((a1 - a0) / (Math.PI / 12)));
      for (let k = 0; k <= n; k++) {
        const ang = a0 + ((a1 - a0) * k) / n;
        const px = cx + Math.cos(ang) * r;
        const py = cy + Math.sin(ang) * r;
        pushPt(out, px, py);
        curb.push(px, py);
      }
      const p2x = cx - cwx(b.ux, b.uy) * b.halfWidth;
      const p2y = cy - cwy(b.ux, b.uy) * b.halfWidth;
      pushPt(out, p2x, p2y);
      curb.push(p2x, p2y);
    }
    curb.push(bx, by);
    curbs.push(curb);
    if (i < m - 1) pushPt(out, bx, by);
  }
  return { polygon: out, curbs };
}
