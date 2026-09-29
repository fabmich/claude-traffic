import { LANE_W } from '../config';
import { angleDiff } from '../core/polyline';
import type { JunctionControl } from '../sim/junctions';
import { VKind } from '../sim/params';
import type { TrafficSim } from '../sim/Traffic';
import type { Vehicle } from '../sim/vehicle';
import type { Renderer } from './Renderer';

const LIGHT_COLORS = { green: '#3ddc6e', amber: '#f7b531', red: '#ef4638' } as const;

/**
 * Draws vehicles of one layer: 'ground' (roads and tunnels) or 'upper' (bridges).
 * Uses direct transforms instead of save/restore for speed.
 */
export function drawVehicles(ctx: CanvasRenderingContext2D, r: Renderer, traffic: TrafficSim, layer: 'ground' | 'upper', selected: Vehicle | null): void {
  const cam = r.camera;
  const S = cam.zoom * r.dpr;
  const ox = (cam.viewW / 2) * r.dpr - cam.x * S;
  const oy = (cam.viewH / 2) * r.dpr - cam.y * S;
  const view = cam.visibleRect(20);
  const alpha = r.alpha;
  const dots = cam.zoom < 0.55;
  for (const v of traffic.vehicles) {
    if (layer === 'upper' ? v.layer !== 1 : v.layer === 1) continue;
    const x = v.px + (v.x - v.px) * alpha;
    const y = v.py + (v.y - v.py) * alpha;
    if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;
    const h = v.pHeading + angleDiff(v.pHeading, v.heading) * alpha;
    const c = Math.cos(h);
    const s = Math.sin(h);
    ctx.globalAlpha = v.layer === -1 ? 0.28 : 1;
    if (dots) {
      ctx.setTransform(S, 0, 0, S, ox, oy);
      ctx.fillStyle = v.color;
      const d = Math.max(2.6, 3.2 / cam.zoom) * (v.kind === VKind.Bus ? 1.6 : 1);
      ctx.fillRect(x - d / 2, y - d / 2, d, d);
      continue;
    }
    ctx.setTransform(S * c, S * s, -S * s, S * c, S * x + ox, S * y + oy);
    const L = v.length;
    const W = v.width;
    // Shadow.
    ctx.fillStyle = 'rgba(10, 20, 30, 0.22)';
    ctx.beginPath();
    ctx.roundRect(-L / 2 + 0.35, -W / 2 + 0.45, L, W, 0.6);
    ctx.fill();
    if (v.kind === VKind.Car) {
      ctx.fillStyle = v.color;
      ctx.beginPath();
      ctx.roundRect(-L / 2, -W / 2, L, W, 0.75);
      ctx.fill();
      ctx.fillStyle = 'rgba(25, 35, 45, 0.55)';
      ctx.fillRect(L * 0.06, -W / 2 + 0.25, L * 0.17, W - 0.5);
      ctx.fillRect(-L * 0.36, -W / 2 + 0.3, L * 0.11, W - 0.6);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fillRect(-L * 0.2, -W / 2 + 0.3, L * 0.24, W - 0.6);
    } else if (v.kind === VKind.Truck) {
      const cab = 2.4;
      ctx.fillStyle = v.color;
      ctx.beginPath();
      ctx.roundRect(-L / 2, -W / 2, L - cab - 0.3, W, 0.3);
      ctx.fill();
      ctx.fillStyle = '#4a6fa5';
      ctx.beginPath();
      ctx.roundRect(L / 2 - cab, -W / 2 + 0.05, cab, W - 0.1, 0.5);
      ctx.fill();
      ctx.fillStyle = 'rgba(25, 35, 45, 0.6)';
      ctx.fillRect(L / 2 - 0.9, -W / 2 + 0.3, 0.45, W - 0.6);
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 0.12;
      ctx.strokeRect(-L / 2, -W / 2, L - cab - 0.3, W);
    } else {
      ctx.fillStyle = v.color;
      ctx.beginPath();
      ctx.roundRect(-L / 2, -W / 2, L, W, 0.6);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(-L / 2 + 0.8, -0.35, L - 2, 0.7);
      ctx.fillStyle = 'rgba(25, 35, 45, 0.55)';
      ctx.fillRect(L / 2 - 1.1, -W / 2 + 0.25, 0.6, W - 0.5);
    }
    if (v.braking) {
      ctx.fillStyle = '#ff2d2d';
      ctx.fillRect(-L / 2 - 0.05, -W / 2 + 0.15, 0.3, 0.45);
      ctx.fillRect(-L / 2 - 0.05, W / 2 - 0.6, 0.3, 0.45);
    }
    if (v === selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.35;
      ctx.beginPath();
      ctx.roundRect(-L / 2 - 0.6, -W / 2 - 0.6, L + 1.2, W + 1.2, 1);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  r.applyWorldTransform();
}

/** Traffic light heads at signalised junctions. */
export function drawSignals(ctx: CanvasRenderingContext2D, r: Renderer, controls: JunctionControl[]): void {
  const view = r.camera.visibleRect(30);
  const z = r.camera.zoom;
  if (z < 0.5) return;
  const rad = Math.max(0.55, 2.2 / z);
  for (const ctrl of controls) {
    if (!ctrl.signal) continue;
    const n = ctrl.node;
    if (n.x < view.x0 || n.x > view.x1 || n.y < view.y0 || n.y > view.y1) continue;
    for (const arm of n.arms) {
      for (const lane of arm.ins) {
        const groups = new Map<string, 'green' | 'amber' | 'red'>();
        for (const c of lane.outs) groups.set(ctrl.groupOf.get(c) ?? '', ctrl.lightFor(c));
        if (groups.size === 0) continue;
        const p = lane.path;
        const h = p.endHeading();
        const nx = -Math.sin(h);
        const ny = Math.cos(h);
        const k = groups.size;
        let i = 0;
        for (const col of groups.values()) {
          const off = (i - (k - 1) / 2) * Math.min(LANE_W / k, rad * 2.1);
          const x = p.x1 + nx * off - Math.cos(h) * 0.9;
          const y = p.y1 + ny * off - Math.sin(h) * 0.9;
          ctx.fillStyle = 'rgba(20, 25, 30, 0.85)';
          ctx.beginPath();
          ctx.arc(x, y, rad * 1.25, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = LIGHT_COLORS[col];
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.fill();
          i++;
        }
      }
    }
  }
}

/** Colours every lane by the ratio of actual to allowed speed (green free flow, red jam). */
export function drawCongestion(ctx: CanvasRenderingContext2D, r: Renderer, traffic: TrafficSim): void {
  const view = r.camera.visibleRect(40);
  ctx.lineCap = 'round';
  for (const lane of traffic.net.lanes) {
    const p = lane.path;
    if (Math.max(p.x0, p.x1) < view.x0 - 200 || Math.min(p.x0, p.x1) > view.x1 + 200) continue;
    if (Math.max(p.y0, p.y1) < view.y0 - 200 || Math.min(p.y0, p.y1) > view.y1 + 200) continue;
    const q = Math.max(0, Math.min(1, lane.statSpeed));
    ctx.strokeStyle = congestionColor(q);
    ctx.lineWidth = LANE_W * 0.72;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    p.trace(ctx);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function congestionColor(q: number): string {
  // 0 red -> 0.5 yellow -> 1 green
  const r = q < 0.5 ? 232 : Math.round(232 - (q - 0.5) * 2 * 172);
  const g = q < 0.5 ? Math.round(69 + q * 2 * 125) : Math.round(194 + (q - 0.5) * 2 * 2);
  const b = q < 0.5 ? 60 : Math.round(48 + (q - 0.5) * 2 * 60);
  return `rgb(${r},${g},${b})`;
}
