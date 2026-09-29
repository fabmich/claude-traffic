import { CHUNK, LANE_W, TILE } from '../config';
import type { Polyline } from '../core/polyline';
import { isLeftTurn, isRightTurn, type Network, type RoadNode, type Segment } from '../roads/network';
import { roadWidth } from '../roads/roadTypes';

const MARK = 'rgba(248, 248, 244, 0.92)';
const MARK_DIM = 'rgba(248, 248, 244, 0.75)';
const TUNNEL_OUTLINE = 'rgba(60, 50, 40, 0.45)';

function chunkKey(net: Network, tx0: number, ty0: number, cols: number): number {
  void net;
  return Math.floor(ty0 / CHUNK) * cols + Math.floor(tx0 / CHUNK);
}

/** Arc-length intervals of the segment drawn on the ground, excluding bridges and tunnel interiors. */
function groundRanges(seg: Segment): Array<[number, number]> {
  const L = seg.center.length;
  let ranges: Array<[number, number]> = [[Math.max(0, seg.trimA - 0.4), Math.min(L, L - seg.trimB + 0.4)]];
  for (const r of seg.spanRanges) {
    let cut0 = r.s0;
    let cut1 = r.s1;
    if (r.kind === 'tunnel') {
      // Keep the approach up to the portal visible.
      const half = (r.s1 - r.s0) / Math.max(1, Math.round((r.s1 - r.s0) / TILE)) / 2;
      cut0 = r.s0 + half;
      cut1 = r.s1 - half;
    }
    const next: Array<[number, number]> = [];
    for (const [a, b] of ranges) {
      if (cut1 <= a || cut0 >= b) {
        next.push([a, b]);
        continue;
      }
      if (cut0 > a) next.push([a, cut0]);
      if (cut1 < b) next.push([cut1, b]);
    }
    ranges = next;
  }
  return ranges.filter(([a, b]) => b - a > 0.05);
}

function strokeRange(ctx: CanvasRenderingContext2D, center: Polyline, s0: number, s1: number, width: number, color: string): void {
  const p = center.slice(s0, s1);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  p.trace(ctx);
  ctx.stroke();
}

/** Offsets (from the centreline, right positive in forward direction) of dashed lane dividers. */
function markingOffsets(seg: Segment): { dashed: number[]; solid: number[]; center: boolean } {
  const t = seg.type;
  const nF = seg.forward.length;
  const nB = seg.backward.length;
  const dashed: number[] = [];
  const solid: number[] = [];
  for (let k = 0; k < nF - 1; k++) dashed.push((seg.forward[k].offset + seg.forward[k + 1].offset) / 2);
  for (let k = 0; k < nB - 1; k++) dashed.push(-(seg.backward[k].offset + seg.backward[k + 1].offset) / 2);
  const center = nF > 0 && nB > 0 && t.median === 0;
  if (t.highway || t.median > 0) {
    // Edge lines along the outer lane borders and next to the median.
    if (nF > 0) solid.push(seg.forward[0].offset + LANE_W / 2, seg.forward[nF - 1].offset - LANE_W / 2);
    if (nB > 0) solid.push(-(seg.backward[0].offset + LANE_W / 2), -(seg.backward[nB - 1].offset - LANE_W / 2));
  }
  return { dashed, solid, center };
}

function drawSegmentBody(ctx: CanvasRenderingContext2D, seg: Segment, ranges: Array<[number, number]>, ppt: number): void {
  const t = seg.type;
  const width = roadWidth(t);
  for (const [a, b] of ranges) {
    strokeRange(ctx, seg.center, a, b, width, t.edgeColor);
    strokeRange(ctx, seg.center, a, b, width - 2 * t.shoulder + (t.highway ? 2 * t.shoulder : 0), t.asphalt);
    if (t.median > 0) strokeRange(ctx, seg.center, a, b, t.median, t.medianColor);
  }
  if (ppt < 14) return;
  const m = markingOffsets(seg);
  ctx.lineCap = 'butt';
  for (const [a, b] of ranges) {
    const base = seg.center.slice(a, b);
    ctx.lineWidth = 0.28;
    ctx.strokeStyle = MARK_DIM;
    ctx.setLineDash([2.6, 4.2]);
    for (const off of m.dashed) {
      ctx.beginPath();
      base.offset(off).trace(ctx);
      ctx.stroke();
    }
    if (m.center) {
      ctx.strokeStyle = MARK;
      ctx.beginPath();
      base.trace(ctx);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = MARK_DIM;
    ctx.lineWidth = 0.22;
    for (const off of m.solid) {
      ctx.beginPath();
      base.offset(off).trace(ctx);
      ctx.stroke();
    }
  }
}

function nodeAsphalt(node: RoadNode): { asphalt: string; edge: string; shoulder: number } {
  let best = node.arms[0].segment.type;
  for (const a of node.arms) if (a.segment.type.rank > best.rank) best = a.segment.type;
  let shoulder = 0;
  for (const a of node.arms) if (!a.segment.type.highway) shoulder = Math.max(shoulder, a.segment.type.shoulder);
  return { asphalt: best.asphalt, edge: node.arms.find((a) => !a.segment.type.highway)?.segment.type.edgeColor ?? best.asphalt, shoulder };
}

function drawNode(ctx: CanvasRenderingContext2D, node: RoadNode): void {
  if (node.polygon.length < 6) return;
  const style = nodeAsphalt(node);
  ctx.fillStyle = style.asphalt;
  ctx.beginPath();
  ctx.moveTo(node.polygon[0], node.polygon[1]);
  for (let i = 2; i < node.polygon.length; i += 2) ctx.lineTo(node.polygon[i], node.polygon[i + 1]);
  ctx.closePath();
  ctx.fill();
  // Slightly grow the fill to hide anti-aliasing seams against segment ends.
  ctx.strokeStyle = style.asphalt;
  ctx.lineWidth = 0.3;
  ctx.stroke();
  if (style.shoulder > 0) {
    // Sidewalks along the curbs, clipped to the junction so only the inner half shows.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(node.polygon[0], node.polygon[1]);
    for (let i = 2; i < node.polygon.length; i += 2) ctx.lineTo(node.polygon[i], node.polygon[i + 1]);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = style.edge;
    ctx.lineWidth = style.shoulder * 2;
    ctx.lineJoin = 'round';
    for (const c of node.curbs) {
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      for (let i = 2; i < c.length; i += 2) ctx.lineTo(c[i], c[i + 1]);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawStopLines(ctx: CanvasRenderingContext2D, node: RoadNode): void {
  if (node.arms.length < 3 && node.control === 'auto') return;
  ctx.strokeStyle = MARK;
  ctx.lineWidth = 0.45;
  ctx.lineCap = 'butt';
  for (const arm of node.arms) {
    for (const lane of arm.ins) {
      const p = lane.path;
      const h = p.endHeading();
      const nx = -Math.sin(h);
      const ny = Math.cos(h);
      const x = p.x1 - Math.cos(h) * 0.3;
      const y = p.y1 - Math.sin(h) * 0.3;
      ctx.beginPath();
      ctx.moveTo(x - nx * (LANE_W / 2 - 0.1), y - ny * (LANE_W / 2 - 0.1));
      ctx.lineTo(x + nx * (LANE_W / 2 - 0.1), y + ny * (LANE_W / 2 - 0.1));
      ctx.stroke();
    }
  }
}

/** Painted arrows showing which way each lane may turn. */
export function drawLaneArrows(ctx: CanvasRenderingContext2D, node: RoadNode, color = MARK): void {
  if (node.arms.length < 3 || node.outside) return;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 0.32;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const arm of node.arms) {
    for (const lane of arm.ins) {
      if (lane.length < 9) continue;
      const turns = new Set<number>();
      for (const c of lane.outs) turns.add(isRightTurn(c.turn) ? 1 : isLeftTurn(c.turn) ? -1 : c.turn === 4 ? 2 : 0);
      if (turns.size === 0) continue;
      const pt = { x: 0, y: 0, a: 0 };
      lane.path.pointAt(lane.length - 6.5, pt);
      drawArrowGlyph(ctx, pt.x, pt.y, pt.a, turns);
    }
  }
}

/** Arrow glyph in a local frame: x forward, y to the right (screen space). */
export function drawArrowGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, turns: Set<number>): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  const head = (hx: number, hy: number, ang: number): void => {
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0.9, 0);
    ctx.lineTo(-0.4, -0.65);
    ctx.lineTo(-0.4, 0.65);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  ctx.beginPath();
  ctx.moveTo(-2.2, 0);
  ctx.lineTo(0, 0);
  ctx.stroke();
  if (turns.has(0)) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(1.6, 0);
    ctx.stroke();
    head(1.8, 0, 0);
  }
  if (turns.has(1)) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(0.9, 0, 0.9, 0.9);
    ctx.stroke();
    head(0.9, 1.2, Math.PI / 2);
  }
  if (turns.has(-1)) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(0.9, 0, 0.9, -0.9);
    ctx.stroke();
    head(0.9, -1.2, -Math.PI / 2);
  }
  if (turns.has(2)) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(1.4, 0, 1.4, -1.3, 0.2, -1.3);
    ctx.stroke();
    head(-0.1, -1.3, Math.PI);
  }
  ctx.restore();
}

function drawTunnels(ctx: CanvasRenderingContext2D, seg: Segment): void {
  for (const r of seg.spanRanges) {
    if (r.kind !== 'tunnel') continue;
    const steps = Math.max(1, Math.round((r.s1 - r.s0) / TILE));
    const half = (r.s1 - r.s0) / steps / 2;
    const w = roadWidth(seg.type);
    // Hidden interior as a translucent dashed outline.
    const inner = seg.center.slice(r.s0 + half, r.s1 - half);
    ctx.strokeStyle = TUNNEL_OUTLINE;
    ctx.lineWidth = w * 0.7;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    inner.trace(ctx);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = 'rgba(50, 40, 30, 0.55)';
    ctx.beginPath();
    inner.offset(w / 2 - 0.5).trace(ctx);
    ctx.stroke();
    ctx.beginPath();
    inner.offset(-(w / 2 - 0.5)).trace(ctx);
    ctx.stroke();
    ctx.setLineDash([]);
    // Portals.
    const pt = { x: 0, y: 0, a: 0 };
    for (const s of [r.s0 + half, r.s1 - half]) {
      seg.center.pointAt(s, pt);
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pt.a);
      ctx.fillStyle = '#3b3530';
      ctx.fillRect(-1.2, -w / 2 - 0.6, 2.4, w + 1.2);
      ctx.fillStyle = '#8a8076';
      ctx.fillRect(-1.6, -w / 2 - 1.2, 0.8, w + 2.4);
      ctx.fillRect(0.8, -w / 2 - 1.2, 0.8, w + 2.4);
      ctx.restore();
    }
  }
}

/** Ground-level roads for one render chunk. */
export function paintRoadsGround(ctx: CanvasRenderingContext2D, net: Network, mapW: number, tx0: number, ty0: number, ppt: number): void {
  const cols = Math.ceil(mapW / CHUNK);
  const key = chunkKey(net, tx0, ty0, cols);
  const segs = net.chunkSegs.get(key) ?? [];
  const nodes = net.chunkNodes.get(key) ?? [];
  if (segs.length === 0 && nodes.length === 0) return;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  const ranges = new Map<Segment, Array<[number, number]>>();
  for (const seg of segs) ranges.set(seg, groundRanges(seg));
  // Bodies of lower-rank roads first so bigger roads overlap them.
  const sorted = [...segs].sort((a, b) => a.type.rank - b.type.rank);
  for (const seg of sorted) drawSegmentBody(ctx, seg, ranges.get(seg)!, ppt);
  for (const node of nodes) drawNode(ctx, node);
  for (const seg of segs) drawTunnels(ctx, seg);
  if (ppt >= 14) for (const node of nodes) drawStopLines(ctx, node);
  if (ppt >= 28) for (const node of nodes) drawLaneArrows(ctx, node);
}

/** Bridges (drawn above ground vehicles). Returns false if the chunk has none. */
export function paintRoadsElevated(ctx: CanvasRenderingContext2D, net: Network, mapW: number, tx0: number, ty0: number, ppt: number): boolean {
  const cols = Math.ceil(mapW / CHUNK);
  const segs = net.chunkSegs.get(chunkKey(net, tx0, ty0, cols)) ?? [];
  let drew = false;
  for (const seg of segs) {
    for (const r of seg.spanRanges) {
      if (r.kind !== 'bridge') continue;
      drew = true;
      const t = seg.type;
      const w = roadWidth(t);
      const a = Math.max(seg.trimA, r.s0 - 2);
      const b = Math.min(seg.center.length - seg.trimB, r.s1 + 2);
      const part = seg.center.slice(a, b);
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      // Shadow.
      ctx.save();
      ctx.translate(1.6, 2.4);
      ctx.strokeStyle = 'rgba(20, 30, 40, 0.28)';
      ctx.lineWidth = w + 1;
      ctx.beginPath();
      part.trace(ctx);
      ctx.stroke();
      ctx.restore();
      // Deck with railings.
      ctx.strokeStyle = '#e4e0d8';
      ctx.lineWidth = w + 1.2;
      ctx.beginPath();
      part.trace(ctx);
      ctx.stroke();
      ctx.strokeStyle = t.asphalt;
      ctx.lineWidth = w - 0.6;
      ctx.beginPath();
      part.trace(ctx);
      ctx.stroke();
      if (t.median > 0) {
        ctx.strokeStyle = '#cfc9bc';
        ctx.lineWidth = t.median;
        ctx.beginPath();
        part.trace(ctx);
        ctx.stroke();
      }
      if (ppt >= 14) {
        const m = markingOffsets(seg);
        ctx.lineWidth = 0.28;
        ctx.strokeStyle = MARK_DIM;
        ctx.setLineDash([2.6, 4.2]);
        for (const off of m.dashed) {
          ctx.beginPath();
          part.offset(off).trace(ctx);
          ctx.stroke();
        }
        if (m.center) {
          ctx.beginPath();
          part.trace(ctx);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.strokeStyle = '#9a948a';
        ctx.lineWidth = 0.35;
        for (const off of [w / 2 + 0.3, -(w / 2 + 0.3)]) {
          ctx.beginPath();
          part.offset(off).trace(ctx);
          ctx.stroke();
        }
      }
    }
  }
  return drew;
}
