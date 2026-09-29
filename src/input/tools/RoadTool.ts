import { TILE } from '../../config';
import { formatMoney } from '../../core/math';
import type { Game } from '../../game/Game';
import type { RoadPlan } from '../../roads/placement';
import { ROAD, ROAD_TYPES, roadWidth } from '../../roads/roadTypes';
import type { Renderer } from '../../render/Renderer';
import type { PointerInfo, Tool } from '../tool';
import { TilePath } from './tilePath';

/** Drag to build roads; crossing water or rock creates bridges and tunnels automatically. */
export class RoadTool implements Tool {
  readonly id = 'road';
  readonly showGrid = true;
  typeId: number = ROAD.street;
  overpass = false;
  private path: TilePath | null = null;
  private dragging = false;
  private plan: RoadPlan | null = null;
  private hover: PointerInfo | null = null;
  private ctrlHeld = false;

  constructor(private game: Game) {}

  deactivate(): void {
    this.dragging = false;
    this.plan = null;
    this.path = null;
  }

  pointerDown(p: PointerInfo): void {
    const world = this.game.world;
    if (!world || !world.map.inBounds(p.tx, p.ty)) return;
    this.path = new TilePath(world.map.w, world.map.h);
    this.path.begin(p.tx, p.ty);
    this.dragging = true;
    this.ctrlHeld = p.ctrl;
    this.replan(p);
  }

  pointerMove(p: PointerInfo): void {
    this.hover = p;
    if (!this.dragging || !this.path) return;
    this.ctrlHeld = p.ctrl;
    if (p.shift || this.overpass || p.ctrl) this.path.straight(p.tx, p.ty);
    else this.path.follow(p.tx, p.ty);
    this.replan(p);
  }

  pointerUp(p: PointerInfo): void {
    if (!this.dragging) return;
    this.pointerMove(p);
    this.dragging = false;
    const world = this.game.world;
    const plan = this.plan;
    this.plan = null;
    this.path = null;
    if (!world || !plan || plan.path.length < 2) return;
    const err = world.applyRoadPlan(plan);
    if (err && err !== 'Already built') this.game.ui.toast(err, 'warn');
  }

  cancel(): boolean {
    if (this.dragging) {
      this.dragging = false;
      this.plan = null;
      this.path = null;
      return true;
    }
    return false;
  }

  private replan(p: PointerInfo): void {
    const world = this.game.world;
    if (!world || !this.path) return;
    this.plan = world.planRoad(this.path.tiles, this.typeId, this.overpass || this.ctrlHeld || p.ctrl);
  }

  drawOverlay(ctx: CanvasRenderingContext2D, r: Renderer): void {
    const world = this.game.world;
    if (!world) return;
    const w = world.map.w;
    const hv = this.hover;
    if (!this.dragging && hv && world.map.inBounds(hv.tx, hv.ty)) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.fillRect(hv.tx * TILE, hv.ty * TILE, TILE, TILE);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 1.2 / r.camera.zoom;
      ctx.strokeRect(hv.tx * TILE, hv.ty * TILE, TILE, TILE);
    }
    const plan = this.plan;
    if (!plan || plan.path.length === 0) return;
    const type = ROAD_TYPES[this.typeId];
    const width = roadWidth(type);
    const cx = (t: number) => ((t % w) + 0.5) * TILE;
    const cy = (t: number) => (Math.floor(t / w) + 0.5) * TILE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const ok = plan.valid;
    ctx.strokeStyle = ok ? 'rgba(70, 150, 255, 0.55)' : 'rgba(230, 70, 60, 0.55)';
    ctx.lineWidth = width;
    ctx.beginPath();
    plan.path.forEach((t, i) => (i === 0 ? ctx.moveTo(cx(t), cy(t)) : ctx.lineTo(cx(t), cy(t))));
    ctx.stroke();
    for (const s of plan.spans) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = s.kind === 'bridge' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(90, 60, 30, 0.95)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx(s.a), cy(s.a));
      ctx.lineTo(cx(s.b), cy(s.b));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (type.lanesB === 0 && plan.path.length >= 2) {
      // Direction chevrons for one-way roads.
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      for (let i = 1; i < plan.path.length; i++) {
        const ax = cx(plan.path[i - 1]);
        const ay = cy(plan.path[i - 1]);
        const bx = cx(plan.path[i]);
        const by = cy(plan.path[i]);
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const a = Math.atan2(by - ay, bx - ax);
        ctx.beginPath();
        ctx.moveTo(mx - Math.cos(a - 0.6) * 3, my - Math.sin(a - 0.6) * 3);
        ctx.lineTo(mx, my);
        ctx.lineTo(mx - Math.cos(a + 0.6) * 3, my - Math.sin(a + 0.6) * 3);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(230, 60, 50, 0.35)';
    for (const t of plan.bad) ctx.fillRect((t % w) * TILE, Math.floor(t / w) * TILE, TILE, TILE);
    const last = plan.path[plan.path.length - 1];
    let text: string;
    if (!plan.valid) text = plan.reason;
    else {
      const extras = plan.spans.map((s) => `${s.kind} ${s.len}`).join(', ');
      text = `${formatMoney(plan.cost)}${extras ? ` · ${extras}` : ''}`;
      if (!world.canAfford(plan.cost)) text += ' · not enough money';
    }
    r.label(text, cx(last), cy(last), { dy: -26, bg: plan.valid && world.canAfford(plan.cost) ? 'rgba(20, 30, 40, 0.82)' : 'rgba(170, 40, 35, 0.9)' });
  }
}
