import type { TrafficSim } from '../sim/Traffic';
import type { Network } from '../roads/network';
import type { Renderer } from './Renderer';
import { congestionColor } from './vehicleDraw';

/** Circles on junctions sized and coloured by the average waiting time of arriving lanes. */
export function drawJunctionDelays(ctx: CanvasRenderingContext2D, r: Renderer, traffic: TrafficSim): void {
  const view = r.camera.visibleRect(60);
  const z = r.camera.zoom;
  const groups = new Map<number, { x: number; y: number; wait: number; n: number }>();
  for (const node of traffic.net.nodes) {
    if (node.arms.length < 2 || node.outside) continue;
    const key = node.ringOf ?? node.tile;
    let g = groups.get(key);
    if (!g) {
      const rb = node.ringOf !== null ? traffic.net.roundabouts.get(node.ringOf) : null;
      g = { x: rb ? rb.x : node.x, y: rb ? rb.y : node.y, wait: 0, n: 0 };
      groups.set(key, g);
    }
    for (const a of node.arms) {
      if (a.dir >= 8) continue;
      for (const l of a.ins) {
        g.wait += l.statWait;
        g.n++;
      }
    }
  }
  for (const g of groups.values()) {
    if (g.x < view.x0 || g.x > view.x1 || g.y < view.y0 || g.y > view.y1 || g.n === 0) continue;
    const wait = g.wait / g.n;
    const q = Math.max(0, 1 - wait / 30);
    const rad = 5 + Math.min(40, wait) * 0.45;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = congestionColor(q);
    ctx.beginPath();
    ctx.arc(g.x, g.y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (z > 0.9 && wait >= 1) r.label(`${Math.round(wait)} s`, g.x, g.y, { bg: 'rgba(20,30,40,0.7)' });
  }
}

/** Round speed-limit signs in the middle of every road segment. */
export function drawSpeedSigns(ctx: CanvasRenderingContext2D, r: Renderer, net: Network): void {
  const cam = r.camera;
  const view = cam.visibleRect(20);
  if (cam.zoom < 0.35) return;
  const pt = { x: 0, y: 0, a: 0 };
  ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 10px system-ui, sans-serif';
  for (const seg of net.segments) {
    if (seg.type.hidden || seg.length < 20) continue;
    const b = seg.bbox;
    if (b.x1 < view.x0 || b.x0 > view.x1 || b.y1 < view.y0 || b.y0 > view.y1) continue;
    seg.center.pointAt(seg.center.length / 2, pt);
    const sx = cam.worldToScreenX(pt.x);
    const sy = cam.worldToScreenY(pt.y);
    const custom = Math.round(seg.speedLimit * 3.6) !== seg.type.speedKmh;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = custom ? '#d4453a' : '#9aa5ad';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1d2830';
    ctx.fillText(String(Math.round(seg.speedLimit * 3.6)), sx, sy + 0.5);
  }
  r.applyWorldTransform();
}
