import { TILE } from '../../config';
import { formatMoney } from '../../core/math';
import type { Game } from '../../game/Game';
import type { Renderer } from '../../render/Renderer';
import type { PointerInfo, Tool } from '../tool';
import { TilePath } from './tilePath';

/** Drag over tiles to remove roads, bridges, tunnels and buildings. */
export class BulldozeTool implements Tool {
  readonly id = 'bulldoze';
  readonly showGrid = true;
  private path: TilePath | null = null;
  private dragging = false;
  private hover: PointerInfo | null = null;

  constructor(private game: Game) {}

  pointerDown(p: PointerInfo): void {
    const world = this.game.world;
    if (!world || !world.map.inBounds(p.tx, p.ty)) return;
    this.path = new TilePath(world.map.w, world.map.h);
    this.path.begin(p.tx, p.ty);
    this.dragging = true;
  }

  pointerMove(p: PointerInfo): void {
    this.hover = p;
    if (this.dragging && this.path) {
      if (p.shift) this.path.straight(p.tx, p.ty);
      else this.path.follow(p.tx, p.ty);
    }
  }

  pointerUp(p: PointerInfo): void {
    if (!this.dragging || !this.path) return;
    this.pointerMove(p);
    const world = this.game.world;
    const tiles = this.path.tiles;
    this.dragging = false;
    this.path = null;
    if (!world) return;
    const plan = world.planBulldoze(tiles);
    if (plan.protectedHit && plan.edges.length === 0 && plan.spans.length === 0 && plan.buildings.length === 0) {
      this.game.ui.toast('Highway connections to the outside world cannot be removed', 'warn');
      return;
    }
    world.applyBulldoze(plan);
  }

  cancel(): boolean {
    if (this.dragging) {
      this.dragging = false;
      this.path = null;
      return true;
    }
    return false;
  }

  drawOverlay(ctx: CanvasRenderingContext2D, r: Renderer): void {
    const world = this.game.world;
    if (!world) return;
    const w = world.map.w;
    const tiles = this.dragging && this.path ? this.path.tiles : this.hover && world.map.inBounds(this.hover.tx, this.hover.ty) ? [this.hover.ty * w + this.hover.tx] : [];
    if (tiles.length === 0) return;
    ctx.fillStyle = 'rgba(230, 60, 50, 0.32)';
    ctx.strokeStyle = 'rgba(230, 60, 50, 0.9)';
    ctx.lineWidth = 1.2 / r.camera.zoom;
    for (const t of tiles) {
      const x = (t % w) * TILE;
      const y = Math.floor(t / w) * TILE;
      ctx.fillRect(x, y, TILE, TILE);
      ctx.strokeRect(x, y, TILE, TILE);
    }
    if (this.dragging) {
      const plan = world.planBulldoze(tiles);
      const last = tiles[tiles.length - 1];
      if (plan.refund > 0) r.label(`+${formatMoney(plan.refund)} refund`, ((last % w) + 0.5) * TILE, (Math.floor(last / w) + 0.5) * TILE, { dy: -26 });
    }
  }
}
