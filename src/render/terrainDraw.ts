import { TILE } from '../config';
import { clamp } from '../core/math';
import { Simplex2 } from '../core/noise';
import { hash2, Rng } from '../core/rng';
import { Terrain } from '../world/terrain';
import type { WorldMap } from '../world/WorldMap';
import { mix, PAL, rgb, type RGB } from './palette';

/** Terrain class used for rounded borders: 0 water, 1 mountain, 2 other land. */
const cls = (t: number): number => (t === Terrain.Water ? 0 : t === Terrain.Mountain ? 1 : 2);

/** Precomputed per-tile base colours for a map (recomputed when terrain changes). */
export class TerrainColors {
  readonly colors: string[];
  private mountainLow: number;
  private noise: Simplex2;

  constructor(private map: WorldMap) {
    this.colors = new Array(map.tileCount);
    this.noise = new Simplex2(new Rng(map.seed ^ 0x2545f491));
    let mMin = 1;
    for (let i = 0; i < map.tileCount; i++) if (map.terrain[i] === Terrain.Mountain) mMin = Math.min(mMin, map.height[i]);
    this.mountainLow = mMin;
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) this.update(x, y);
  }

  update(x: number, y: number): void {
    this.colors[y * this.map.w + x] = rgb(this.baseRGB(x, y));
  }

  baseRGB(x: number, y: number): RGB {
    const map = this.map;
    const i = y * map.w + x;
    const t = map.terrain[i];
    const jitter = 1 + this.noise.noise(x / 9, y / 9) * 0.022 + (hash2(x, y, map.seed) - 0.5) * 0.012;
    switch (t) {
      case Terrain.Water: {
        const depth = clamp((map.waterDist[i] - 1) / 3, 0, 1);
        return scale(mix(PAL.waterShallow, PAL.waterDeep, depth), 1 + (jitter - 1) * 0.3);
      }
      case Terrain.Mountain: {
        const hh = map.height;
        const hx = (xx: number, yy: number) => hh[clamp(yy, 0, map.h - 1) * map.w + clamp(xx, 0, map.w - 1)];
        const gx = hx(x + 1, y) - hx(x - 1, y);
        const gy = hx(x, y + 1) - hx(x, y - 1);
        const shade = 1 + clamp((gx + gy) * 3.2, -0.22, 0.22);
        const tt = clamp((hh[i] - this.mountainLow) / (1 - this.mountainLow + 1e-6), 0, 1);
        if (tt > 0.78) return scale(PAL.snow, 0.94 + shade * 0.06);
        return scale(mix(PAL.rockLow, PAL.rockHigh, tt), shade * jitter);
      }
      case Terrain.Forest:
        return scale(PAL.forestFloor, jitter);
      case Terrain.Sand:
        return scale(PAL.sand, jitter);
      case Terrain.Farmland:
        return scale(PAL.farmland, jitter);
      case Terrain.Rich:
        return scale(PAL.rich, jitter);
      default:
        return scale(PAL.grass, jitter);
    }
  }
}

function scale(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

// Corner order: NE, SE, SW, NW. Orthogonal neighbour offsets for each corner and quadrant origin.
const CORNER_H = [1, 1, -1, -1];
const CORNER_V = [-1, 1, 1, -1];

/** Paints terrain tiles of a chunk with rounded shorelines and decorative details. */
export function paintTerrain(
  ctx: CanvasRenderingContext2D,
  map: WorldMap,
  colors: TerrainColors,
  tx0: number,
  ty0: number,
  tx1: number,
  ty1: number,
  pxPerTile: number,
): void {
  const { w, h, terrain } = map;
  const half = TILE / 2;

  // Base fill.
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      ctx.fillStyle = colors.colors[y * w + x];
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
  }

  // Rounded borders between water / mountain / land.
  if (pxPerTile >= 8) {
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) {
        const c = cls(terrain[y * w + x]);
        for (let k = 0; k < 4; k++) {
          const hx = x + CORNER_H[k];
          const vy = y + CORNER_V[k];
          if (hx < 0 || hx >= w || vy < 0 || vy >= h) continue;
          const ch = cls(terrain[y * w + hx]);
          const cv = cls(terrain[vy * w + x]);
          if (ch === c || cv === c) continue;
          // Round this corner: fill the quadrant with the neighbour colour, then a quarter disc of our colour.
          const qx = x * TILE + (CORNER_H[k] > 0 ? half : 0);
          const qy = y * TILE + (CORNER_V[k] > 0 ? half : 0);
          ctx.fillStyle = colors.colors[y * w + hx];
          ctx.fillRect(qx, qy, half, half);
          ctx.fillStyle = colors.colors[y * w + x];
          const cxp = x * TILE + half;
          const cyp = y * TILE + half;
          const a0 = cornerAngle(k);
          ctx.beginPath();
          ctx.moveTo(cxp, cyp);
          ctx.arc(cxp, cyp, half, a0, a0 + Math.PI / 2);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }

  if (pxPerTile < 12) return;

  // Decorations.
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      const t = terrain[y * w + x];
      const bx = x * TILE;
      const by = y * TILE;
      if (t === Terrain.Farmland && pxPerTile >= 16) {
        const vertical = hash2(x >> 2, y >> 2, map.seed + 11) > 0.5;
        ctx.strokeStyle = PAL.farmStripe;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (let s = 3; s < TILE; s += 4) {
          if (vertical) {
            ctx.moveTo(bx + s, by + 1.5);
            ctx.lineTo(bx + s, by + TILE - 1.5);
          } else {
            ctx.moveTo(bx + 1.5, by + s);
            ctx.lineTo(bx + TILE - 1.5, by + s);
          }
        }
        ctx.stroke();
      } else if (t === Terrain.Rich) {
        const count = 3 + Math.floor(hash2(x, y, map.seed + 5) * 3);
        for (let k = 0; k < count; k++) {
          const px = bx + 3 + hash2(x * 7 + k, y, map.seed + 21) * (TILE - 6);
          const py = by + 3 + hash2(x, y * 7 + k, map.seed + 22) * (TILE - 6);
          const r = 1.1 + hash2(x + k, y - k, map.seed + 23) * 1.4;
          ctx.fillStyle = PAL.ore[k % PAL.ore.length];
          ctx.beginPath();
          ctx.moveTo(px, py - r);
          ctx.lineTo(px + r, py);
          ctx.lineTo(px, py + r);
          ctx.lineTo(px - r, py);
          ctx.closePath();
          ctx.fill();
        }
      } else if (t === Terrain.Mountain && pxPerTile >= 16) {
        // Small ridge strokes for texture.
        const hv = hash2(x, y, map.seed + 31);
        if (hv < 0.55) {
          ctx.strokeStyle = 'rgba(90, 84, 76, 0.22)';
          ctx.lineWidth = 1;
          const px = bx + 5 + hv * 12;
          const py = by + 16 - hv * 6;
          ctx.beginPath();
          ctx.moveTo(px - 4, py + 3);
          ctx.lineTo(px, py - 3);
          ctx.lineTo(px + 4, py + 3);
          ctx.stroke();
        }
      }
    }
  }

  // Trees last so canopies can overlap neighbouring tiles slightly.
  for (let y = Math.max(0, ty0 - 1); y < Math.min(h, ty1 + 1); y++) {
    for (let x = Math.max(0, tx0 - 1); x < Math.min(w, tx1 + 1); x++) {
      if (terrain[y * w + x] !== Terrain.Forest) continue;
      drawTrees(ctx, x, y, map.seed, pxPerTile >= 24);
    }
  }
}

function cornerAngle(k: number): number {
  // Quadrant angles in screen space (y down): NE = -90..0, SE = 0..90, SW = 90..180, NW = 180..270.
  return [-Math.PI / 2, 0, Math.PI / 2, Math.PI][k];
}

export function drawTrees(ctx: CanvasRenderingContext2D, x: number, y: number, seed: number, shadow: boolean): void {
  const bx = x * TILE;
  const by = y * TILE;
  const count = 3 + Math.floor(hash2(x, y, seed + 41) * 3);
  for (let k = 0; k < count; k++) {
    const px = bx + 4 + hash2(x * 13 + k, y * 3, seed + 42) * (TILE - 8);
    const py = by + 4 + hash2(x * 5, y * 11 + k, seed + 43) * (TILE - 8);
    const r = 3.4 + hash2(x + k * 3, y + k, seed + 44) * 2.4;
    if (shadow) {
      ctx.fillStyle = PAL.treeShadow;
      ctx.beginPath();
      ctx.arc(px + 1.2, py + 1.6, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = PAL.trees[Math.floor(hash2(x - k, y + k * 5, seed + 45) * PAL.trees.length)];
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
