import { TILE } from '../../config';
import { Zone, ZONE_INFO } from '../../city/zones';
import type { Game } from '../../game/Game';
import type { Renderer } from '../../render/Renderer';
import type { PointerInfo, Tool } from '../tool';

/** Drag a rectangle to paint (or remove) zoning on tiles near roads. */
export class ZoneTool implements Tool {
  readonly id = 'zone';
  readonly showGrid = true;
  zone: number = Zone.Residential;
  private start: { x: number; y: number } | null = null;
  private end: { x: number; y: number } | null = null;
  private hover: PointerInfo | null = null;

  constructor(private game: Game) {}

  private clampTile(p: PointerInfo): { x: number; y: number } {
    const map = this.game.world!.map;
    return { x: Math.max(0, Math.min(map.w - 1, p.tx)), y: Math.max(0, Math.min(map.h - 1, p.ty)) };
  }

  pointerDown(p: PointerInfo): void {
    const world = this.game.world;
    if (!world || !world.map.inBounds(p.tx, p.ty)) return;
    this.start = this.clampTile(p);
    this.end = this.start;
  }

  pointerMove(p: PointerInfo): void {
    this.hover = p;
    if (this.start && this.game.world) this.end = this.clampTile(p);
  }

  pointerUp(p: PointerInfo): void {
    const world = this.game.world;
    if (!this.start || !world) return;
    this.pointerMove(p);
    const tiles = this.tiles();
    this.start = this.end = null;
    const n = world.city.paintZone(tiles, this.zone);
    if (n === 0 && this.zone !== Zone.None) {
      const ui = this.game.ui;
      if (this.zone === Zone.Farming) ui.toast('Farming zones only grow on farmland (yellow striped ground) within 3 tiles of a road', 'warn');
      else ui.toast('Zones must be within 3 tiles of a road with driveways (not a highway), on land', 'warn');
    }
  }

  cancel(): boolean {
    if (this.start) {
      this.start = this.end = null;
      return true;
    }
    return false;
  }

  /** Tiles in the dragged rectangle (or under the cursor). */
  private tiles(): number[] {
    const world = this.game.world;
    if (!world) return [];
    const w = world.map.w;
    let a = this.start;
    let b = this.end;
    if (!a || !b) {
      const hv = this.hover;
      if (!hv || !world.map.inBounds(hv.tx, hv.ty)) return [];
      a = b = { x: hv.tx, y: hv.ty };
    }
    const out: number[] = [];
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) out.push(y * w + x);
    return out;
  }

  drawOverlay(ctx: CanvasRenderingContext2D, r: Renderer): void {
    const world = this.game.world;
    if (!world) return;
    const city = world.city;
    const w = world.map.w;
    const zone = this.zone;
    const info = ZONE_INFO[zone];
    // Zoneable land in view.
    if (r.camera.zoom * TILE >= 6) {
      const vis = r.camera.visibleRect(TILE);
      const x0 = Math.max(0, Math.floor(vis.x0 / TILE));
      const y0 = Math.max(0, Math.floor(vis.y0 / TILE));
      const x1 = Math.min(world.map.w - 1, Math.floor(vis.x1 / TILE));
      const y1 = Math.min(world.map.h - 1, Math.floor(vis.y1 / TILE));
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1 / r.camera.zoom;
      ctx.beginPath();
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const t = y * w + x;
          if (city.zoneable[t] && !city.zones[t] && world.buildingAt[t] < 0 && (zone === Zone.None || city.canZone(t, zone))) ctx.rect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4);
        }
      }
      ctx.stroke();
    }
    const tiles = this.tiles();
    if (tiles.length === 0) return;
    let ok = 0;
    for (const t of tiles) {
      const x = (t % w) * TILE;
      const y = Math.floor(t / w) * TILE;
      if (city.canZone(t, zone)) {
        ok++;
        ctx.fillStyle = zone === Zone.None ? 'rgba(230, 60, 50, 0.35)' : info.fill.replace(/[\d.]+\)$/, '0.6)');
        ctx.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
      } else if (this.start) {
        ctx.fillStyle = 'rgba(40, 40, 40, 0.12)';
        ctx.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
      }
    }
    if (this.start && this.end) {
      const x0 = Math.min(this.start.x, this.end.x) * TILE;
      const y0 = Math.min(this.start.y, this.end.y) * TILE;
      const x1 = (Math.max(this.start.x, this.end.x) + 1) * TILE;
      const y1 = (Math.max(this.start.y, this.end.y) + 1) * TILE;
      ctx.strokeStyle = zone === Zone.None ? '#e0584d' : info.color;
      ctx.lineWidth = 2 / r.camera.zoom;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      const label = zone === Zone.None ? `Remove zoning · ${ok} tiles` : `${info.name} · ${ok} tiles`;
      r.label(label, (x0 + x1) / 2, y0, { dy: -18 });
    }
  }
}
