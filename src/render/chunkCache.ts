import { CHUNK, TILE } from '../config';
import type { Camera } from './camera';

/**
 * Paints the tile range [tx0, tx1) x [ty0, ty1) of one chunk. The context is transformed so that
 * one unit is one world meter and clipped to the chunk. Returns false if nothing was drawn.
 */
export type ChunkPainter = (
  ctx: CanvasRenderingContext2D,
  tx0: number,
  ty0: number,
  tx1: number,
  ty1: number,
  pxPerTile: number,
) => boolean;

interface Entry {
  canvas: HTMLCanvasElement | null;
  lod: number;
  version: number;
  lastUsed: number;
  pixels: number;
}

const LODS = [4, 8, 16, 32, 64, 128];

/** Offscreen cache of a static map layer, split into chunks and rendered at power-of-two resolutions. */
export class ChunkLayer {
  readonly cols: number;
  readonly rows: number;
  private versions: Uint32Array;
  private entries = new Map<number, Entry>();
  private pixelsUsed = 0;
  private frame = 0;

  constructor(
    private tilesW: number,
    private tilesH: number,
    private paint: ChunkPainter,
    private pixelBudget = 24_000_000,
  ) {
    this.cols = Math.ceil(tilesW / CHUNK);
    this.rows = Math.ceil(tilesH / CHUNK);
    this.versions = new Uint32Array(this.cols * this.rows).fill(1);
  }

  /** Marks chunks overlapping the inclusive tile rectangle as stale. */
  invalidateTiles(tx0: number, ty0: number, tx1: number, ty1: number): void {
    const cx0 = Math.max(0, Math.floor(tx0 / CHUNK));
    const cy0 = Math.max(0, Math.floor(ty0 / CHUNK));
    const cx1 = Math.min(this.cols - 1, Math.floor(tx1 / CHUNK));
    const cy1 = Math.min(this.rows - 1, Math.floor(ty1 / CHUNK));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.versions[cy * this.cols + cx]++;
  }

  invalidateAll(): void {
    for (let i = 0; i < this.versions.length; i++) this.versions[i]++;
  }

  /** Draws the visible chunks. Stale chunks are re-rendered within `budgetMs`; older versions fill in. */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number, budgetMs = 8): void {
    this.frame++;
    const start = performance.now();
    const ppt = cam.zoom * dpr * TILE;
    let li = LODS.length - 1;
    for (let i = 0; i < LODS.length; i++) {
      if (LODS[i] >= ppt * 0.85) {
        li = i;
        break;
      }
    }
    const r = cam.visibleRect(TILE);
    const span = CHUNK * TILE;
    const cx0 = Math.max(0, Math.floor(r.x0 / span));
    const cy0 = Math.max(0, Math.floor(r.y0 / span));
    const cx1 = Math.min(this.cols - 1, Math.floor(r.x1 / span));
    const cy1 = Math.min(this.rows - 1, Math.floor(r.y1 / span));
    const scale = cam.zoom * dpr;
    const ox = (cam.viewW / 2) * dpr - cam.x * scale;
    const oy = (cam.viewH / 2) * dpr - cam.y * scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const ci = cy * this.cols + cx;
        const ver = this.versions[ci];
        let e = this.entries.get(this.key(li, ci));
        if (!e || e.version !== ver) {
          const fallback = e ?? this.bestOther(ci, li);
          if (!fallback || performance.now() - start < budgetMs) {
            e = this.render(li, cx, cy, ver);
          } else {
            e = fallback;
          }
        }
        e.lastUsed = this.frame;
        if (!e.canvas) continue;
        const x0 = Math.floor(ox + cx * span * scale);
        const y0 = Math.floor(oy + cy * span * scale);
        const tw = Math.min(CHUNK, this.tilesW - cx * CHUNK);
        const th = Math.min(CHUNK, this.tilesH - cy * CHUNK);
        const x1 = Math.ceil(ox + (cx * span + tw * TILE) * scale);
        const y1 = Math.ceil(oy + (cy * span + th * TILE) * scale);
        ctx.drawImage(e.canvas, x0, y0, x1 - x0, y1 - y0);
      }
    }
    this.evict();
  }

  dispose(): void {
    this.entries.clear();
    this.pixelsUsed = 0;
  }

  private key(li: number, ci: number): number {
    return li * this.cols * this.rows + ci;
  }

  private bestOther(ci: number, li: number): Entry | undefined {
    let best: Entry | undefined;
    for (let d = 1; d < LODS.length; d++) {
      for (const l of [li + d, li - d]) {
        if (l < 0 || l >= LODS.length) continue;
        const e = this.entries.get(this.key(l, ci));
        if (e && (!best || e.version > best.version)) best = e;
      }
      if (best) return best;
    }
    return best;
  }

  private render(li: number, cx: number, cy: number, version: number): Entry {
    const lod = LODS[li];
    const ci = cy * this.cols + cx;
    const k = this.key(li, ci);
    const tx0 = cx * CHUNK;
    const ty0 = cy * CHUNK;
    const tw = Math.min(CHUNK, this.tilesW - tx0);
    const th = Math.min(CHUNK, this.tilesH - ty0);
    let e = this.entries.get(k);
    let canvas = e?.canvas ?? null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = tw * lod;
      canvas.height = th * lod;
    }
    const c = canvas.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    const s = lod / TILE;
    c.setTransform(s, 0, 0, s, -tx0 * TILE * s, -ty0 * TILE * s);
    c.save();
    c.beginPath();
    c.rect(tx0 * TILE, ty0 * TILE, tw * TILE, th * TILE);
    c.clip();
    const drew = this.paint(c, tx0, ty0, tx0 + tw, ty0 + th, lod);
    c.restore();
    if (e) {
      if (!drew && e.canvas) this.pixelsUsed -= e.pixels;
      if (drew && !e.canvas) this.pixelsUsed += canvas.width * canvas.height;
      e.canvas = drew ? canvas : null;
      e.pixels = drew ? canvas.width * canvas.height : 0;
      e.version = version;
    } else {
      e = { canvas: drew ? canvas : null, lod, version, lastUsed: this.frame, pixels: drew ? canvas.width * canvas.height : 0 };
      this.entries.set(k, e);
      this.pixelsUsed += e.pixels;
    }
    return e;
  }

  private evict(): void {
    if (this.pixelsUsed <= this.pixelBudget) return;
    const list = [...this.entries.entries()].filter(([, e]) => e.lastUsed < this.frame);
    list.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, e] of list) {
      if (this.pixelsUsed <= this.pixelBudget * 0.8) break;
      this.entries.delete(k);
      this.pixelsUsed -= e.pixels;
    }
  }
}
