import { TILE } from '../../config';
import { formatMoney } from '../../core/math';
import type { Game } from '../../game/Game';
import { drawLines, stopSign } from '../../render/transitDraw';
import type { Renderer } from '../../render/Renderer';
import type { Segment } from '../../roads/network';
import { TRANSIT, type Line, type Stop } from '../../transit/Transit';
import type { PointerInfo, Tool } from '../tool';

/** A place for a stop under the pointer: an existing stop or a new one on a road side. */
export type StopCandidate = { stop: Stop } | { x: number; y: number; heading: number; error: string | null };

/** Finds the stop, or the road side where a new stop would go, under a world point. */
export function stopCandidate(game: Game, wx: number, wy: number): StopCandidate | null {
  const world = game.world;
  if (!world) return null;
  const transit = world.transit;
  const existing = transit.stopAt(wx, wy, 7 + 4 / game.renderer.camera.zoom);
  if (existing) return { stop: existing };
  let best: Segment | null = null;
  let bd = TILE * 0.6;
  let proj = { s: 0, d: 0, a: 0 };
  for (const seg of world.network.segments) {
    if (seg.type.hidden) continue;
    const b = seg.bbox;
    if (wx < b.x0 - 16 || wx > b.x1 + 16 || wy < b.y0 - 16 || wy > b.y1 + 16) continue;
    const pr = seg.center.project(wx, wy);
    if (pr.d < bd) {
      bd = pr.d;
      best = seg;
      proj = pr;
    }
  }
  if (!best) return null;
  // Right-hand traffic: forward lanes are on the right of the centreline direction.
  const pt = { x: 0, y: 0, a: 0 };
  best.center.pointAt(proj.s, pt);
  const side = (wx - pt.x) * -Math.sin(pt.a) + (wy - pt.y) * Math.cos(pt.a);
  let forward = side >= 0;
  if ((forward ? best.forward : best.backward).length === 0) forward = !forward;
  const lanes = forward ? best.forward : best.backward;
  if (lanes.length === 0) return null;
  const lp = lanes[0].path.project(wx, wy);
  lanes[0].path.pointAt(lp.s, pt);
  const heading = pt.a;
  const error = best.type.access ? transit.canPlaceStop(pt.x, pt.y, heading) : 'Buses do not stop on highways';
  return { x: pt.x, y: pt.y, heading, error };
}

function drawCandidate(ctx: CanvasRenderingContext2D, r: Renderer, cand: StopCandidate | null, verb: string): void {
  if (!cand) return;
  if ('stop' in cand) {
    const g = stopSign(cand.stop);
    ctx.strokeStyle = '#2f7de1';
    ctx.lineWidth = Math.max(0.5, 2 / r.camera.zoom);
    ctx.beginPath();
    ctx.arc(g.x, g.y, 3.2, 0, Math.PI * 2);
    ctx.stroke();
    r.label(`${verb} ${cand.stop.name}`, g.x, g.y, { dy: -22 });
    return;
  }
  const ok = !cand.error;
  const nx = -Math.sin(cand.heading);
  const ny = Math.cos(cand.heading);
  const x = cand.x + nx * 3.8;
  const y = cand.y + ny * 3.8;
  ctx.fillStyle = ok ? 'rgba(60, 170, 90, 0.85)' : 'rgba(220, 70, 60, 0.85)';
  ctx.beginPath();
  ctx.arc(x, y, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(cand.x - Math.cos(cand.heading) * 5, cand.y - Math.sin(cand.heading) * 5);
  ctx.lineTo(cand.x + Math.cos(cand.heading) * 5, cand.y + Math.sin(cand.heading) * 5);
  ctx.stroke();
  // Direction arrow head.
  ctx.beginPath();
  const hx = cand.x + Math.cos(cand.heading) * 5;
  const hy = cand.y + Math.sin(cand.heading) * 5;
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - Math.cos(cand.heading - 0.5) * 2, hy - Math.sin(cand.heading - 0.5) * 2);
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - Math.cos(cand.heading + 0.5) * 2, hy - Math.sin(cand.heading + 0.5) * 2);
  ctx.stroke();
  r.label(ok ? `New stop · ${formatMoney(TRANSIT.stopCost)}` : cand.error!, x, y, { dy: -22, bg: ok ? undefined : 'rgba(170, 40, 35, 0.9)' });
}

/** Places bus stops on the side of streets (click an existing stop to inspect it). */
export class StopTool implements Tool {
  readonly id = 'stop';
  private hover: PointerInfo | null = null;

  constructor(private game: Game) {}

  pointerMove(p: PointerInfo): void {
    this.hover = p;
  }

  pointerDown(p: PointerInfo): void {
    const world = this.game.world;
    if (!world) return;
    const cand = stopCandidate(this.game, p.wx, p.wy);
    if (!cand) return;
    if ('stop' in cand) {
      this.game.events.emit('openStop', cand.stop);
      return;
    }
    if (cand.error) {
      this.game.ui.toast(cand.error, 'warn');
      return;
    }
    const res = world.transit.addStop(cand.x, cand.y, cand.heading);
    if (typeof res === 'string') this.game.ui.toast(res, 'warn');
  }

  drawOverlay(ctx: CanvasRenderingContext2D, r: Renderer): void {
    const world = this.game.world;
    if (!world) return;
    drawLines(ctx, r, world.transit.lines, null);
    const hv = this.hover;
    if (hv) drawCandidate(ctx, r, stopCandidate(this.game, hv.wx, hv.wy), 'Inspect');
  }
}

/** Draws a bus line by clicking stops (or road sides, which adds stops) in order. */
export class LineTool implements Tool {
  readonly id = 'line';
  stops: Stop[] = [];
  /** Line being edited (null = a new line). */
  editing: Line | null = null;
  private hover: PointerInfo | null = null;

  constructor(private game: Game) {}

  /** Starts drawing a new line, or re-drawing the stops of an existing one. */
  begin(line: Line | null): void {
    this.editing = line;
    this.stops = line ? [...line.stops] : [];
    this.game.setTool(this);
    this.game.events.emit('lineDraft', this.stops.length);
  }

  deactivate(): void {
    this.stops = [];
    this.editing = null;
    this.game.events.emit('lineDraft', 0);
  }

  pointerMove(p: PointerInfo): void {
    this.hover = p;
  }

  pointerDown(p: PointerInfo): void {
    const world = this.game.world;
    if (!world) return;
    const cand = stopCandidate(this.game, p.wx, p.wy);
    if (!cand) return;
    let stop: Stop;
    if ('stop' in cand) {
      stop = cand.stop;
      if (stop === this.stops[0] && this.stops.length >= 2) {
        this.finish();
        return;
      }
      if (this.stops.includes(stop)) {
        this.game.ui.toast('This stop is already on the line. Click the first stop to close the loop.', 'warn');
        return;
      }
    } else {
      if (cand.error) {
        this.game.ui.toast(cand.error, 'warn');
        return;
      }
      const res = world.transit.addStop(cand.x, cand.y, cand.heading);
      if (typeof res === 'string') {
        this.game.ui.toast(res, 'warn');
        return;
      }
      stop = res;
    }
    const last = this.stops[this.stops.length - 1];
    if (last && !world.transit.legRoute(last, stop)) {
      this.game.ui.toast('Buses cannot drive from the previous stop to this one', 'warn');
      return;
    }
    this.stops.push(stop);
    this.game.events.emit('lineDraft', this.stops.length);
  }

  keyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      this.finish();
      return true;
    }
    if (e.key === 'Backspace') {
      this.stops.pop();
      this.game.events.emit('lineDraft', this.stops.length);
      return true;
    }
    return false;
  }

  cancel(): boolean {
    if (this.stops.length >= 2) {
      this.finish();
      return true;
    }
    return false;
  }

  /** Creates or updates the line (the route loops back from the last stop to the first). */
  finish(): void {
    const world = this.game.world;
    if (!world) return;
    if (this.stops.length < 2) {
      this.game.ui.toast('A line needs at least two stops', 'warn');
      return;
    }
    const stops = this.stops;
    let line = this.editing;
    if (line) world.transit.setLineStops(line, stops);
    else line = world.transit.createLine(stops);
    if (line.broken) this.game.ui.toast(`${line.name}: buses cannot drive the whole loop. Check the dashed parts.`, 'warn');
    this.stops = [];
    this.editing = null;
    this.game.setTool(null);
    this.game.events.emit('openLine', line);
  }

  drawOverlay(ctx: CanvasRenderingContext2D, r: Renderer): void {
    const world = this.game.world;
    if (!world) return;
    const transit = world.transit;
    drawLines(
      ctx,
      r,
      transit.lines.filter((l) => l !== this.editing),
      null,
    );
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.editing?.color ?? '#2f7de1';
    ctx.lineWidth = Math.max(1.8, 3.6 / r.camera.zoom);
    const drawLeg = (a: Stop, b: Stop, dashed: boolean): void => {
      const paths = transit.legPath(a, b);
      if (!paths) return;
      ctx.setLineDash(dashed ? [4, 3] : []);
      for (const p of paths) {
        ctx.beginPath();
        p.trace(ctx);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    };
    for (let i = 1; i < this.stops.length; i++) drawLeg(this.stops[i - 1], this.stops[i], false);
    if (this.stops.length >= 2) {
      ctx.globalAlpha = 0.5;
      drawLeg(this.stops[this.stops.length - 1], this.stops[0], true);
      ctx.globalAlpha = 1;
    }
    this.stops.forEach((s, i) => {
      const g = stopSign(s);
      r.label(String(i + 1), g.x, g.y, { dy: -14, bg: '#2f7de1', font: '700 11px system-ui, sans-serif' });
    });
    const hv = this.hover;
    if (!hv) return;
    const cand = stopCandidate(this.game, hv.wx, hv.wy);
    const last = this.stops[this.stops.length - 1];
    if (cand && 'stop' in cand && last && cand.stop !== last) {
      ctx.globalAlpha = 0.6;
      drawLeg(last, cand.stop, true);
      ctx.globalAlpha = 1;
    }
    drawCandidate(ctx, r, cand, cand && 'stop' in cand && cand.stop === this.stops[0] && this.stops.length >= 2 ? 'Close the loop at' : 'Add');
  }
}
