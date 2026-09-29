import { TILE } from '../config';
import type { World } from '../game/World';
import { Camera } from './camera';
import { ChunkLayer } from './chunkCache';
import { PAL } from './palette';
import { paintTerrain, TerrainColors } from './terrainDraw';

/** A function that draws on top of the map in world coordinates (1 unit = 1 meter). */
export type WorldDrawer = (ctx: CanvasRenderingContext2D, r: Renderer) => void;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly camera = new Camera();
  dpr = 1;
  /** Interpolation factor between the previous and current simulation step. */
  alpha = 0;
  showGrid = false;
  /** Extra painters for the static ground layer (roads, buildings...), called after terrain. */
  groundPainters: Array<(ctx: CanvasRenderingContext2D, tx0: number, ty0: number, tx1: number, ty1: number, ppt: number) => void> = [];
  /** Dynamic drawers called every frame in world space, in order. */
  dynamicDrawers: WorldDrawer[] = [];
  /** Drawers above everything else (tool previews, selection). */
  overlayDrawers: WorldDrawer[] = [];
  private world: World | null = null;
  private ground: ChunkLayer | null = null;
  terrainColors: TerrainColors | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;
  }

  setWorld(world: World): void {
    this.world = world;
    this.ground?.dispose();
    this.terrainColors = new TerrainColors(world.map);
    const colors = this.terrainColors;
    this.ground = new ChunkLayer(world.map.w, world.map.h, (ctx, tx0, ty0, tx1, ty1, ppt) => {
      paintTerrain(ctx, world.map, colors, tx0, ty0, tx1, ty1, ppt);
      for (const p of this.groundPainters) p(ctx, tx0, ty0, tx1, ty1, ppt);
      return true;
    });
  }

  /** Marks the static ground layer stale in an inclusive tile rectangle. */
  invalidateTiles(tx0: number, ty0: number, tx1: number, ty1: number): void {
    this.ground?.invalidateTiles(tx0, ty0, tx1, ty1);
  }

  invalidateAll(): void {
    this.ground?.invalidateAll();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.dpr = dpr;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.camera.setView(w, h);
  }

  /** Sets the context transform so that drawing units are world meters. */
  applyWorldTransform(ctx: CanvasRenderingContext2D = this.ctx): void {
    const cam = this.camera;
    const s = cam.zoom * this.dpr;
    ctx.setTransform(s, 0, 0, s, (cam.viewW / 2) * this.dpr - cam.x * s, (cam.viewH / 2) * this.dpr - cam.y * s);
  }

  /** CSS pixels per meter. */
  get pxPerMeter(): number {
    return this.camera.zoom;
  }

  render(): void {
    const ctx = this.ctx;
    const world = this.world;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PAL.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!world || !this.ground) return;

    const mw = world.map.widthMeters;
    const mh = world.map.heightMeters;
    this.applyWorldTransform();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 30 * this.dpr;
    ctx.fillStyle = '#b2d696';
    ctx.fillRect(0, 0, mw, mh);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    this.ground.draw(ctx, this.camera, this.dpr);

    this.applyWorldTransform();
    for (const d of this.dynamicDrawers) d(ctx, this);

    // Night tint.
    const light = world.clock.daylight;
    if (light < 1) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(20, 30, 70, ${(1 - light) * 0.35})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.applyWorldTransform();
    }

    if (this.showGrid && this.camera.zoom * TILE >= 10) this.drawGrid(ctx, world);
    for (const d of this.overlayDrawers) d(ctx, this);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, world: World): void {
    const r = this.camera.visibleRect();
    const x0 = Math.max(0, Math.floor(r.x0 / TILE));
    const y0 = Math.max(0, Math.floor(r.y0 / TILE));
    const x1 = Math.min(world.map.w, Math.ceil(r.x1 / TILE));
    const y1 = Math.min(world.map.h, Math.ceil(r.y1 / TILE));
    ctx.strokeStyle = PAL.grid;
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      ctx.moveTo(x * TILE, y0 * TILE);
      ctx.lineTo(x * TILE, y1 * TILE);
    }
    for (let y = y0; y <= y1; y++) {
      ctx.moveTo(x0 * TILE, y * TILE);
      ctx.lineTo(x1 * TILE, y * TILE);
    }
    ctx.stroke();
  }
}
