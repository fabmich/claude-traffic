import { LANE_W, TILE } from '../config';
import type { Line, Stop } from '../transit/Transit';
import type { Transit } from '../transit/Transit';
import type { Renderer } from './Renderer';

/** Sidewalk position next to a stop (right of the curb lane). */
export function stopSign(stop: Stop): { x: number; y: number; nx: number; ny: number; tx: number; ty: number } {
  const tx = Math.cos(stop.angle);
  const ty = Math.sin(stop.angle);
  const nx = -ty;
  const ny = tx;
  const off = LANE_W * 0.5 + 2.2;
  return { x: stop.x + nx * off, y: stop.y + ny * off, nx, ny, tx, ty };
}

/** Bus route polylines of lines (all, or only the highlighted one drawn on top). */
export function drawLines(ctx: CanvasRenderingContext2D, r: Renderer, lines: Line[], highlight: Line | null): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const w = Math.max(1.6, 3.2 / r.camera.zoom);
  for (const line of lines) {
    const hl = line === highlight;
    ctx.strokeStyle = line.color;
    ctx.globalAlpha = highlight && !hl ? 0.3 : 0.8;
    ctx.lineWidth = hl ? w * 1.5 : w;
    ctx.setLineDash(line.broken ? [w * 2, w * 1.5] : []);
    for (const leg of line.legPaths) {
      for (const p of leg) {
        ctx.beginPath();
        p.trace(ctx);
        ctx.stroke();
      }
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** Bus stop signs with the colours of their lines and waiting passengers. */
export function drawStops(ctx: CanvasRenderingContext2D, r: Renderer, transit: Transit, selected: Stop | null): void {
  const tilePx = r.camera.zoom * TILE;
  if (tilePx < 6 || transit.stops.length === 0) return;
  const vis = r.camera.visibleRect(TILE);
  const detail = tilePx >= 22;
  for (const stop of transit.stops) {
    if (!stop.valid) continue;
    if (stop.x < vis.x0 || stop.x > vis.x1 || stop.y < vis.y0 || stop.y > vis.y1) continue;
    const g = stopSign(stop);
    const size = detail ? 2.6 : Math.max(2.4, 5 / r.camera.zoom);
    // Waiting passengers along the sidewalk.
    const n = stop.waiting.length;
    if (detail && n > 0) {
      const shown = Math.min(n, 12);
      ctx.fillStyle = '#35424d';
      for (let i = 0; i < shown; i++) {
        const row = Math.floor(i / 6);
        const k = (i % 6) + 1;
        ctx.beginPath();
        ctx.arc(g.x - g.tx * (k * 1.25 + 1.2) + g.nx * row * 1.2, g.y - g.ty * (k * 1.25 + 1.2) + g.ny * row * 1.2, 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Shelter sign.
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(stop.angle);
    ctx.fillStyle = 'rgba(20, 30, 40, 0.25)';
    ctx.fillRect(-size / 2 + 0.3, -size / 2 + 0.4, size, size);
    ctx.fillStyle = stop === selected ? '#2f7de1' : '#ffffff';
    ctx.strokeStyle = '#2d3a45';
    ctx.lineWidth = Math.max(0.25, 1 / r.camera.zoom);
    ctx.beginPath();
    ctx.roundRect(-size / 2, -size / 2, size, size, size * 0.2);
    ctx.fill();
    ctx.stroke();
    const lines = stop.lines;
    if (lines.length) {
      const bw = size / lines.length;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillStyle = lines[i].color;
        ctx.fillRect(-size / 2 + i * bw + size * 0.08, size * 0.12, bw - size * 0.16 / lines.length, size * 0.3);
      }
    }
    if (detail) {
      // A tiny bus glyph.
      ctx.fillStyle = stop === selected ? '#ffffff' : '#2d3a45';
      ctx.fillRect(-size * 0.28, -size * 0.34, size * 0.56, size * 0.36);
    }
    ctx.restore();
    if (detail && n > 12) r.label(`${n}`, g.x, g.y, { dy: -16, font: '600 10px system-ui, sans-serif' });
  }
}
