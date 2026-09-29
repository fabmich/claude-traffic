import { TILE } from '../config';
import { Rng } from '../core/rng';
import { BState, Problem, type Building } from '../city/buildings';
import { Zone, ZONE_INFO } from '../city/zones';
import type { World } from '../game/World';
import { mix, PAL, rgb, type RGB } from './palette';
import type { Renderer } from './Renderer';

/** Shadow length per meter of height (the sun stands in the north-west). */
const SUN = 0.4;
const SHADOW = 'rgba(28, 44, 32, 0.24)';

const LAWN = '#bddb9b';
const PAVE = '#dddcd3';
const CONCRETE = '#d4d1c7';
const ASPHALT = '#9ea4a7';
const DIRT = '#dcc596';
const DRY = '#cdc79e';
const FARMYARD = '#dcd3ab';
const POOL = '#79c4e6';
const ROOF_HOUSE: RGB[] = [
  [222, 122, 98],
  [208, 104, 88],
  [230, 156, 96],
  [196, 132, 110],
  [128, 160, 196],
  [150, 145, 138],
  [183, 110, 108],
  [206, 152, 122],
];
const ROOF_FLAT: RGB[] = [
  [232, 224, 208],
  [218, 214, 206],
  [206, 216, 226],
  [228, 212, 198],
  [214, 222, 210],
];
const ROOF_SHOP: RGB[] = [
  [214, 226, 238],
  [232, 234, 238],
  [204, 216, 232],
  [236, 226, 214],
];
const ROOF_IND: RGB[] = [
  [166, 180, 190],
  [158, 172, 164],
  [182, 174, 160],
  [148, 164, 180],
  [176, 168, 176],
];
const CROPS: RGB[] = [
  [150, 196, 98],
  [178, 206, 104],
  [222, 204, 104],
  [196, 170, 96],
  [134, 182, 90],
];
const AWNINGS = ['#e0584d', '#3a8ee0', '#3fae6c', '#eab33b', '#8d6fd0', '#e0782f'];
const CONTAINERS = ['#d9634f', '#3f86c9', '#e0a83a', '#4ea36a', '#8f7bc2'];
const CAR_COLORS = ['#e8e6e0', '#3c4a5a', '#c8483c', '#4f7fc0', '#d9b44a', '#8a9aa6', '#2e2e34'];
const BARN: RGB = [196, 84, 70];
const SILO: RGB = [214, 216, 218];
const RUIN: RGB = [138, 128, 118];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Roof = 'hip' | 'gable' | 'flat' | 'saw';

interface Box {
  r: Rect;
  height: number;
  color: RGB;
  roof: Roof;
  /** Ridge (gable, hip) or saw teeth run along world x. */
  alongX: boolean;
  /** Small rooftop units (flat roofs). */
  units?: Rect[];
  /** Skylights (flat roofs). */
  skylights?: Rect[];
  /** Windows lit at night (fractions of the box). */
  windows: Array<[number, number]>;
}

interface Ground {
  r: Rect;
  color: string;
  kind: 'plain' | 'field' | 'parking' | 'pool';
  /** Field rows or parking stalls run along world x. */
  alongX?: boolean;
  crop?: RGB;
  cars?: Array<{ r: Rect; color: string }>;
}

interface Tank {
  x: number;
  y: number;
  r: number;
  height: number;
  color: RGB;
  chimney?: boolean;
}

interface Strip {
  r: Rect;
  color: string;
  /** Stripes run along world x. */
  alongX: boolean;
}

interface Layout {
  lot: Rect;
  yard: string;
  ground: Ground[];
  boxes: Box[];
  tanks: Tank[];
  trees: Array<{ x: number; y: number; r: number; c: string }>;
  strips: Strip[];
  props: Array<{ r: Rect; color: string; height: number }>;
}

/** Maps lot-local coordinates (u along the road, v away from it) to world space. */
class Lot {
  readonly X0: number;
  readonly Y0: number;
  readonly X1: number;
  readonly Y1: number;
  /** Length along the road and depth away from it (meters). */
  readonly lu: number;
  readonly lv: number;

  constructor(
    b: Building,
    readonly f = b.facing,
  ) {
    this.X0 = b.x0 * TILE;
    this.Y0 = b.y0 * TILE;
    this.X1 = (b.x1 + 1) * TILE;
    this.Y1 = (b.y1 + 1) * TILE;
    const wx = this.X1 - this.X0;
    const wy = this.Y1 - this.Y0;
    this.lu = this.uIsX ? wx : wy;
    this.lv = this.uIsX ? wy : wx;
  }

  /** True if the lot's u axis (along the road) is world x. */
  get uIsX(): boolean {
    return this.f === 2 || this.f === 6;
  }

  pt(u: number, v: number): [number, number] {
    switch (this.f) {
      case 6:
        return [this.X0 + u, this.Y0 + v];
      case 2:
        return [this.X1 - u, this.Y1 - v];
      case 0:
        return [this.X1 - v, this.Y0 + u];
      default:
        return [this.X0 + v, this.Y1 - u];
    }
  }

  rect(u0: number, v0: number, u1: number, v1: number): Rect {
    const [ax, ay] = this.pt(u0, v0);
    const [bx, by] = this.pt(u1, v1);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }
}

function windowsFor(rng: Rng, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) out.push([0.15 + rng.next() * 0.7, 0.15 + rng.next() * 0.7]);
  return out;
}

function flatUnits(rng: Rng, r: Rect, n: number): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const w = 1.6 + rng.next() * 1.8;
    const h = 1.4 + rng.next() * 1.4;
    out.push({ x: r.x + 1.5 + rng.next() * Math.max(0.1, r.w - w - 3), y: r.y + 1.5 + rng.next() * Math.max(0.1, r.h - h - 3), w, h });
  }
  return out;
}

function parkingCars(rng: Rng, r: Rect, alongX: boolean, fill: number): Array<{ r: Rect; color: string }> {
  const cars: Array<{ r: Rect; color: string }> = [];
  const len = alongX ? r.w : r.h;
  const depth = alongX ? r.h : r.w;
  const stalls = Math.floor((len - 1) / 2.7);
  const rows = depth >= 11 ? 2 : 1;
  for (let row = 0; row < rows; row++) {
    for (let i = 0; i < stalls; i++) {
      if (rng.next() > fill) continue;
      const a = 0.9 + i * 2.7 + 0.45;
      const b = row === 0 ? 0.6 : depth - 5.1;
      const car = alongX ? { x: r.x + a, y: r.y + b, w: 1.8, h: 4.4 } : { x: r.x + b, y: r.y + a, w: 4.4, h: 1.8 };
      cars.push({ r: car, color: CAR_COLORS[rng.int(CAR_COLORS.length)] });
    }
  }
  return cars;
}

/** Deterministic geometry of a building for its template, level and orientation. */
function layout(b: Building): Layout {
  const rng = new Rng(b.seed);
  const lot = new Lot(b);
  const L = b.level;
  const lotRect: Rect = { x: lot.X0, y: lot.Y0, w: lot.X1 - lot.X0, h: lot.Y1 - lot.Y0 };
  const out: Layout = { lot: lotRect, yard: LAWN, ground: [], boxes: [], tanks: [], trees: [], strips: [], props: [] };
  const j = (a: number): number => (rng.next() * 2 - 1) * a;
  const pick = <T>(arr: readonly T[]): T => arr[rng.int(arr.length)];
  const along = (ridgeAlongU: boolean): boolean => (ridgeAlongU ? lot.uIsX : !lot.uIsX);
  const tree = (u: number, v: number, r: number): void => {
    const [x, y] = lot.pt(u, v);
    out.trees.push({ x, y, r, c: pick(PAL.trees) });
  };
  const lu = lot.lu;
  const lv = lot.lv;

  switch (b.template.key) {
    case 'house': {
      const W = [10, 12, 13.5][L - 1] + j(0.8);
      const D = [9, 10, 11.5][L - 1] + j(0.5);
      const u0 = (lu - W) / 2 + j(2.2);
      const v0 = 5.5 + j(1);
      const drive = rng.chance(0.5) ? u0 + W - 3.2 : u0 + 0.6;
      out.ground.push({ r: lot.rect(drive, 0.6, drive + 2.6, v0), color: PAVE, kind: 'plain' });
      const roof: Roof = rng.chance(0.55) ? 'hip' : 'gable';
      out.boxes.push({ r: lot.rect(u0, v0, u0 + W, v0 + D), height: [5, 6.5, 8][L - 1], color: pick(ROOF_HOUSE), roof, alongX: along(W >= D), windows: windowsFor(rng, 2 + L) });
      const back = v0 + D;
      if (L === 3 && lv - back > 8) out.ground.push({ r: lot.rect(lu / 2 - 3 + j(3), back + 2.5, lu / 2 + 3 + j(3), back + 5.5), color: POOL, kind: 'pool' });
      else if (lv - back > 6) tree(3 + rng.next() * (lu - 6), back + 3.5 + rng.next() * (lv - back - 6), 2.4 + rng.next());
      if (rng.chance(0.5)) tree(rng.chance(0.5) ? 2.8 : lu - 2.8, 3 + rng.next() * 2, 2 + rng.next() * 0.8);
      break;
    }
    case 'townhouses': {
      const n = [3, 4, 4][L - 1];
      const D = [11, 12, 13.5][L - 1];
      const v0 = 5.5;
      const uw = (lu - 5) / n;
      const base = pick(ROOF_HOUSE);
      for (let i = 0; i < n; i++) {
        const u0 = 2.5 + i * uw;
        const c = mix(base, pick(ROOF_HOUSE), 0.25);
        out.boxes.push({ r: lot.rect(u0, v0, u0 + uw, v0 + D), height: [7, 8, 9][L - 1], color: c, roof: 'gable', alongX: along(false), windows: windowsFor(rng, 2) });
        out.ground.push({ r: lot.rect(u0 + uw / 2 - 0.8, 0.6, u0 + uw / 2 + 0.8, v0), color: PAVE, kind: 'plain' });
      }
      if (lv - v0 - D > 6) for (let i = 0; i < n; i += 2) tree(2.5 + (i + 0.5) * uw, v0 + D + 3.5, 2.2 + rng.next() * 0.8);
      break;
    }
    case 'apartments': {
      const inset = [7, 5, 4][L - 1];
      const v0 = [8, 7, 6][L - 1];
      const v1 = [30, 33, 36][L - 1];
      const r = lot.rect(inset, v0, lu - inset, v1);
      out.boxes.push({ r, height: [14, 20, 30][L - 1], color: pick(ROOF_FLAT), roof: 'flat', alongX: true, units: flatUnits(rng, r, 3 + L), windows: windowsFor(rng, 6 + L * 3) });
      const park = lot.rect(3, v1 + 2, lu - 3, lv - 1.5);
      out.ground.push({ r: park, color: ASPHALT, kind: 'parking', alongX: lot.uIsX, cars: parkingCars(rng, park, lot.uIsX, 0.55) });
      out.ground.push({ r: lot.rect(lu / 2 - 1.2, 0.6, lu / 2 + 1.2, v0), color: PAVE, kind: 'plain' });
      for (let i = 0; i < 4; i++) tree(5 + i * ((lu - 10) / 3), 3.4, 2 + rng.next() * 0.7);
      break;
    }
    case 'shop':
    case 'store': {
      out.yard = PAVE;
      const big = b.template.key === 'store';
      const W = big ? [30, 32, 34][L - 1] : [13, 15, 17][L - 1];
      const D = big ? [11, 12.5, 14][L - 1] : [10, 11.5, 13][L - 1];
      const u0 = big ? 3 : (lu - W) / 2 + j(1.5);
      const v0 = 5;
      const r = lot.rect(u0, v0, u0 + W, v0 + D);
      out.boxes.push({ r, height: big ? 7 + L : 5 + L, color: pick(ROOF_SHOP), roof: 'flat', alongX: true, units: flatUnits(rng, r, big ? 3 : 1), windows: windowsFor(rng, big ? 6 : 3) });
      out.strips.push({ r: lot.rect(u0 + 0.5, v0 - 1.8, u0 + W - 0.5, v0), color: pick(AWNINGS), alongX: !lot.uIsX });
      if (big) {
        const park = lot.rect(u0 + W + 1.5, 1.5, lu - 1.5, lv - 1.5);
        out.ground.push({ r: park, color: ASPHALT, kind: 'parking', alongX: !lot.uIsX, cars: parkingCars(rng, park, !lot.uIsX, 0.6) });
      } else if (lv - v0 - D > 5) tree(lu / 2 + j(5), v0 + D + 3, 2 + rng.next() * 0.6);
      break;
    }
    case 'mall': {
      out.yard = PAVE;
      const park = lot.rect(2, 1.5, lu - 2, 16.5);
      out.ground.push({ r: park, color: ASPHALT, kind: 'parking', alongX: lot.uIsX, cars: parkingCars(rng, park, lot.uIsX, 0.7) });
      const r = lot.rect(4, 19, lu - 4, lv - 3);
      const sky: Rect[] = [];
      for (let i = 0; i < 4; i++) sky.push(lot.rect(9 + i * ((lu - 22) / 3), 25, 13 + i * ((lu - 22) / 3), lv - 9));
      out.boxes.push({ r, height: 9 + L * 2, color: pick(ROOF_SHOP), roof: 'flat', alongX: true, skylights: sky, windows: windowsFor(rng, 10) });
      out.strips.push({ r: lot.rect(lu / 2 - 7, 17, lu / 2 + 7, 19), color: pick(AWNINGS), alongX: !lot.uIsX });
      break;
    }
    case 'workshop': {
      out.yard = CONCRETE;
      const D = [16, 20, 24][L - 1];
      const r = lot.rect(3.5, 5, lu - 3.5, 5 + D);
      out.boxes.push({ r, height: 6 + L, color: pick(ROOF_IND), roof: 'gable', alongX: along(false), windows: windowsFor(rng, 3) });
      for (let i = 0; i < 2 + L; i++) {
        const u = 2 + rng.next() * (lu - 8);
        const v = 5 + D + 2 + rng.next() * Math.max(1, lv - D - 12);
        out.props.push({ r: rng.chance(0.5) ? lot.rect(u, v, u + 2.4, v + 6) : lot.rect(u, v, u + 2.2, v + 2.2), color: rng.chance(0.5) ? pick(CONTAINERS) : '#b98d5c', height: 2.5 });
      }
      break;
    }
    case 'factory':
    case 'plant': {
      out.yard = CONCRETE;
      const plant = b.template.key === 'plant';
      const D = [22, 24, 27][L - 1];
      const hallW = plant ? 38 : lu - 8;
      const r = lot.rect(4, 6, 4 + hallW, 6 + D);
      out.boxes.push({ r, height: plant ? 12 + L : 9 + L, color: pick(ROOF_IND), roof: plant ? 'flat' : 'saw', alongX: lot.uIsX, units: plant ? flatUnits(rng, r, 4) : undefined, windows: windowsFor(rng, 5) });
      const [cx, cy] = lot.pt(4 + hallW - 3, 6 + D + 3.5);
      out.tanks.push({ x: cx, y: cy, r: 1.5, height: 22, color: [150, 144, 140], chimney: true });
      if (plant) {
        const n = 1 + L;
        for (let i = 0; i < n; i++) {
          const [tx, ty] = lot.pt(hallW + 13 + (i % 2) * 14, 13 + Math.floor(i / 2) * 15);
          out.tanks.push({ x: tx, y: ty, r: 5.6, height: 10, color: SILO });
        }
      }
      for (let i = 0; i < 3 + L; i++) {
        const u = 3 + rng.next() * (lu - 10);
        const v = 6 + D + 2 + rng.next() * Math.max(1, lv - D - 14);
        out.props.push({ r: lot.rect(u, v, u + 2.4, v + 6), color: pick(CONTAINERS), height: 2.6 });
      }
      break;
    }
    case 'farm':
    case 'bigfarm': {
      out.yard = FARMYARD;
      const big = b.template.key === 'bigfarm';
      const yardU = big ? 30 : 24;
      const yardV = 16;
      out.ground.push({ r: lot.rect(1, 1, yardU, yardV), color: FARMYARD, kind: 'plain' });
      const crop = pick(CROPS);
      out.ground.push({ r: lot.rect(yardU + 1.5, 1, lu - 1, yardV), color: rgb(crop), kind: 'field', crop, alongX: !lot.uIsX });
      if (big) {
        const mid = lu / 2;
        out.ground.push({ r: lot.rect(1, yardV + 1.5, mid - 0.75, lv - 1), color: '', kind: 'field', crop: pick(CROPS), alongX: lot.uIsX });
        out.ground.push({ r: lot.rect(mid + 0.75, yardV + 1.5, lu - 1, lv - 1), color: '', kind: 'field', crop: pick(CROPS), alongX: !lot.uIsX });
      } else out.ground.push({ r: lot.rect(1, yardV + 1.5, lu - 1, lv - 1), color: '', kind: 'field', crop: pick(CROPS), alongX: rng.chance(0.5) });
      out.boxes.push({ r: lot.rect(3, 3, 15, 12), height: 6, color: BARN, roof: 'gable', alongX: along(true), windows: windowsFor(rng, 1) });
      const silos = (big ? 2 : 1) + (L >= 2 ? 1 : 0);
      for (let i = 0; i < silos; i++) {
        const [sx, sy] = lot.pt(18.5 + i * 5.5, 6.5);
        out.tanks.push({ x: sx, y: sy, r: 2.4, height: 10, color: SILO });
      }
      if (big) out.boxes.push({ r: lot.rect(5, 12.5, 12, 15.5), height: 4, color: pick(ROOF_HOUSE), roof: 'hip', alongX: along(true), windows: windowsFor(rng, 2) });
      break;
    }
  }
  for (const g of out.ground) if (g.kind === 'field' && g.crop && !g.color) g.color = rgb(g.crop);
  return out;
}

const cache = new WeakMap<Building, { level: number; lay: Layout }>();

function layoutOf(b: Building): Layout {
  const c = cache.get(b);
  if (c && c.level === b.level) return c.lay;
  const lay = layout(b);
  cache.set(b, { level: b.level, lay });
  return lay;
}

// ---------------------------------------------------------------- primitives

function sweepRect(ctx: CanvasRenderingContext2D, r: Rect, d: number): void {
  ctx.moveTo(r.x, r.y);
  ctx.lineTo(r.x + r.w, r.y);
  ctx.lineTo(r.x + r.w + d, r.y + d);
  ctx.lineTo(r.x + r.w + d, r.y + r.h + d);
  ctx.lineTo(r.x + d, r.y + r.h + d);
  ctx.lineTo(r.x, r.y + r.h);
  ctx.closePath();
}

function sweepCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, d: number): void {
  const a = Math.PI / 4;
  ctx.moveTo(x + r * Math.cos(a - Math.PI / 2), y + r * Math.sin(a - Math.PI / 2));
  ctx.arc(x + d, y + d, r, a - Math.PI / 2, a + Math.PI / 2);
  ctx.arc(x, y, r, a + Math.PI / 2, a + (Math.PI * 3) / 2);
  ctx.closePath();
}

function poly(ctx: CanvasRenderingContext2D, color: string, pts: number[]): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

function drawRoof(ctx: CanvasRenderingContext2D, b: Box, color: RGB, detail: boolean): void {
  const { x, y, w, h } = b.r;
  if (!detail) {
    ctx.fillStyle = rgb(color);
    ctx.fillRect(x, y, w, h);
    return;
  }
  switch (b.roof) {
    case 'hip': {
      if (w >= h) {
        const i = h / 2;
        const cy = y + h / 2;
        poly(ctx, rgb(color, 1.07), [x, y, x + w, y, x + w - i, cy, x + i, cy]);
        poly(ctx, rgb(color, 0.82), [x, y + h, x + w, y + h, x + w - i, cy, x + i, cy]);
        poly(ctx, rgb(color, 0.98), [x, y, x + i, cy, x, y + h]);
        poly(ctx, rgb(color, 0.88), [x + w, y, x + w - i, cy, x + w, y + h]);
      } else {
        const i = w / 2;
        const cx = x + w / 2;
        poly(ctx, rgb(color, 0.98), [x, y, cx, y + i, cx, y + h - i, x, y + h]);
        poly(ctx, rgb(color, 0.86), [x + w, y, cx, y + i, cx, y + h - i, x + w, y + h]);
        poly(ctx, rgb(color, 1.07), [x, y, x + w, y, cx, y + i]);
        poly(ctx, rgb(color, 0.82), [x, y + h, x + w, y + h, cx, y + h - i]);
      }
      break;
    }
    case 'gable': {
      ctx.fillStyle = rgb(color, 1.05);
      if (b.alongX) {
        ctx.fillRect(x, y, w, h / 2);
        ctx.fillStyle = rgb(color, 0.84);
        ctx.fillRect(x, y + h / 2, w, h / 2);
      } else {
        ctx.fillRect(x, y, w / 2, h);
        ctx.fillStyle = rgb(color, 0.87);
        ctx.fillRect(x + w / 2, y, w / 2, h);
      }
      break;
    }
    case 'saw': {
      ctx.fillStyle = rgb(color, 0.92);
      ctx.fillRect(x, y, w, h);
      const len = b.alongX ? h : w;
      const n = Math.max(2, Math.round(len / 4));
      const step = len / n;
      for (let k = 0; k < n; k++) {
        ctx.fillStyle = rgb(color, 1.08);
        if (b.alongX) ctx.fillRect(x, y + k * step, w, step * 0.55);
        else ctx.fillRect(x + k * step, y, step * 0.55, h);
        ctx.fillStyle = 'rgba(150, 190, 215, 0.9)';
        if (b.alongX) ctx.fillRect(x, y + k * step + step * 0.55, w, step * 0.14);
        else ctx.fillRect(x + k * step + step * 0.55, y, step * 0.14, h);
      }
      break;
    }
    default: {
      ctx.fillStyle = rgb(color, 1.04);
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = rgb(color, 0.94);
      ctx.fillRect(x + 0.9, y + 0.9, w - 1.8, h - 1.8);
      if (b.skylights) {
        ctx.fillStyle = 'rgba(160, 200, 225, 0.95)';
        for (const s of b.skylights) ctx.fillRect(s.x, s.y, s.w, s.h);
      }
      if (b.units) {
        for (const u of b.units) {
          ctx.fillStyle = 'rgba(28, 44, 32, 0.18)';
          ctx.fillRect(u.x + 0.5, u.y + 0.5, u.w, u.h);
          ctx.fillStyle = rgb(color, 1.12);
          ctx.fillRect(u.x, u.y, u.w, u.h);
        }
      }
    }
  }
  ctx.strokeStyle = rgb(color, 0.7);
  ctx.lineWidth = 0.35;
  ctx.strokeRect(x, y, w, h);
}

function drawTank(ctx: CanvasRenderingContext2D, t: Tank, color: RGB, detail: boolean): void {
  ctx.fillStyle = rgb(color, 0.92);
  ctx.beginPath();
  ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
  ctx.fill();
  if (!detail) return;
  ctx.fillStyle = rgb(color, 1.08);
  ctx.beginPath();
  ctx.arc(t.x - t.r * 0.18, t.y - t.r * 0.18, t.r * 0.72, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = t.chimney ? 'rgba(40, 40, 44, 0.85)' : rgb(color, 0.86);
  ctx.beginPath();
  ctx.arc(t.x, t.y, t.r * (t.chimney ? 0.55 : 0.22), 0, Math.PI * 2);
  ctx.fill();
}

function drawGround(ctx: CanvasRenderingContext2D, g: Ground, ppt: number, state: number): void {
  const r = g.r;
  const fallow = state === BState.Abandoned;
  const color = fallow && g.kind === 'field' ? '#c2a878' : g.color;
  ctx.fillStyle = color;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (ppt < 20) return;
  if (g.kind === 'field') {
    ctx.strokeStyle = fallow ? 'rgba(110, 85, 50, 0.3)' : `rgba(${g.crop ? g.crop.map((c) => Math.round(c * 0.72)).join(',') : '90,110,60'}, 0.7)`;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    if (g.alongX) {
      for (let y = r.y + 1.1; y < r.y + r.h; y += 2.2) {
        ctx.moveTo(r.x + 0.5, y);
        ctx.lineTo(r.x + r.w - 0.5, y);
      }
    } else {
      for (let x = r.x + 1.1; x < r.x + r.w; x += 2.2) {
        ctx.moveTo(x, r.y + 0.5);
        ctx.lineTo(x, r.y + r.h - 0.5);
      }
    }
    ctx.stroke();
  } else if (g.kind === 'parking') {
    ctx.strokeStyle = 'rgba(245, 245, 240, 0.75)';
    ctx.lineWidth = 0.18;
    ctx.beginPath();
    const len = g.alongX ? r.w : r.h;
    const depth = g.alongX ? r.h : r.w;
    const rows = depth >= 11 ? [0, depth - 5.6] : [0];
    for (const off of rows) {
      for (let a = 0.9; a <= len - 0.8; a += 2.7) {
        if (g.alongX) {
          ctx.moveTo(r.x + a, r.y + off + 0.3);
          ctx.lineTo(r.x + a, r.y + off + 5.3);
        } else {
          ctx.moveTo(r.x + off + 0.3, r.y + a);
          ctx.lineTo(r.x + off + 5.3, r.y + a);
        }
      }
    }
    ctx.stroke();
    if (state === BState.Active && g.cars) {
      for (const c of g.cars) {
        ctx.fillStyle = c.color;
        ctx.beginPath();
        ctx.roundRect(c.r.x, c.r.y, c.r.w, c.r.h, 0.6);
        ctx.fill();
      }
    }
  } else if (g.kind === 'pool') {
    ctx.strokeStyle = '#f4f4ee';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
}

function drawStrip(ctx: CanvasRenderingContext2D, s: Strip, ppt: number): void {
  const r = s.r;
  ctx.fillStyle = s.color;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (ppt < 20) return;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  const len = s.alongX ? r.h : r.w;
  for (let a = 0.6; a < len; a += 1.2) {
    if (s.alongX) ctx.fillRect(r.x, r.y + a, r.w, 0.6);
    else ctx.fillRect(r.x + a, r.y, 0.6, r.h);
  }
}

function drawCracks(ctx: CanvasRenderingContext2D, r: Rect, seed: number): void {
  const rng = new Rng(seed ^ 0x9e3779b9);
  ctx.strokeStyle = 'rgba(60, 50, 44, 0.55)';
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  for (let k = 0; k < 2; k++) {
    let x = r.x + rng.next() * r.w;
    let y = r.y + rng.next() * r.h * 0.3;
    ctx.moveTo(x, y);
    for (let i = 0; i < 4; i++) {
      x = Math.max(r.x, Math.min(r.x + r.w, x + (rng.next() - 0.5) * r.w * 0.5));
      y = Math.min(r.y + r.h, y + r.h * 0.22);
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

function drawBuilding(ctx: CanvasRenderingContext2D, b: Building, ppt: number): void {
  const lay = layoutOf(b);
  const detail = ppt >= 10;
  const lot = lay.lot;
  const state = b.state;
  const inset = 0.6;
  if (state === BState.Construction) {
    ctx.fillStyle = DIRT;
    ctx.fillRect(lot.x + inset, lot.y + inset, lot.w - inset * 2, lot.h - inset * 2);
    for (const bx of lay.boxes) {
      ctx.fillStyle = '#e6e2d8';
      ctx.fillRect(bx.r.x, bx.r.y, bx.r.w, bx.r.h);
      if (!detail) continue;
      ctx.strokeStyle = 'rgba(140, 100, 60, 0.85)';
      ctx.lineWidth = 0.4;
      ctx.setLineDash([1.2, 0.8]);
      ctx.strokeRect(bx.r.x + 0.3, bx.r.y + 0.3, bx.r.w - 0.6, bx.r.h - 0.6);
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let x = bx.r.x + 3; x < bx.r.x + bx.r.w - 1; x += 3) {
        ctx.moveTo(x, bx.r.y + 0.5);
        ctx.lineTo(x, bx.r.y + bx.r.h - 0.5);
      }
      ctx.stroke();
    }
    for (const t of lay.tanks) {
      ctx.strokeStyle = 'rgba(140, 100, 60, 0.85)';
      ctx.lineWidth = 0.4;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    const main = lay.boxes[0];
    if (detail && main && main.height >= 9) {
      // Tower crane.
      const cx = main.r.x + main.r.w * 0.3;
      const cy = main.r.y + main.r.h * 0.4;
      ctx.strokeStyle = 'rgba(28, 44, 32, 0.25)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(cx + 5, cy + 5);
      ctx.lineTo(cx + 5 + main.r.w * 0.6, cy + 5 - 2);
      ctx.stroke();
      ctx.strokeStyle = '#e8b53a';
      ctx.beginPath();
      ctx.moveTo(cx - 4, cy + 1);
      ctx.lineTo(cx + main.r.w * 0.6, cy - 2);
      ctx.stroke();
      ctx.fillStyle = '#d9a42c';
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
    }
    return;
  }
  const abandoned = state === BState.Abandoned;
  ctx.fillStyle = abandoned ? DRY : lay.yard;
  ctx.fillRect(lot.x + inset, lot.y + inset, lot.w - inset * 2, lot.h - inset * 2);
  for (const g of lay.ground) drawGround(ctx, g, ppt, state);
  // One combined shadow path so overlapping shadows do not darken twice.
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  for (const bx of lay.boxes) sweepRect(ctx, bx.r, bx.height * SUN);
  for (const t of lay.tanks) sweepCircle(ctx, t.x, t.y, t.r, t.height * SUN);
  for (const p of lay.props) sweepRect(ctx, p.r, p.height * SUN);
  ctx.fill();
  for (const p of lay.props) {
    ctx.fillStyle = abandoned ? rgb(RUIN) : p.color;
    ctx.fillRect(p.r.x, p.r.y, p.r.w, p.r.h);
  }
  for (const bx of lay.boxes) {
    const color = abandoned ? mix(bx.color, RUIN, 0.7) : bx.color;
    drawRoof(ctx, bx, color, detail);
    if (abandoned && detail) drawCracks(ctx, bx.r, b.seed);
  }
  for (const t of lay.tanks) drawTank(ctx, t, abandoned ? mix(t.color, [150, 110, 90], 0.5) : t.color, detail);
  if (!abandoned) for (const s of lay.strips) drawStrip(ctx, s, ppt);
  if (detail) {
    for (const t of lay.trees) {
      ctx.fillStyle = PAL.treeShadow;
      ctx.beginPath();
      ctx.arc(t.x + 1.2, t.y + 1.6, t.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = abandoned ? '#a3a36a' : t.c;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Ground-layer painter for zones and buildings of one chunk. */
export function paintCity(ctx: CanvasRenderingContext2D, world: World, tx0: number, ty0: number, tx1: number, ty1: number, ppt: number): boolean {
  const city = world.city;
  const w = world.map.w;
  const h = world.map.h;
  let drew = false;
  const zoneDetail = ppt >= 16;
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      const t = y * w + x;
      const z = city.zones[t];
      if (!z || world.buildingAt[t] >= 0) continue;
      const info = ZONE_INFO[z];
      ctx.fillStyle = info.fill;
      ctx.fillRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
      if (zoneDetail) {
        ctx.strokeStyle = info.color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 0.6;
        ctx.strokeRect(x * TILE + 1.5, y * TILE + 1.5, TILE - 3, TILE - 3);
        ctx.globalAlpha = 1;
      }
      drew = true;
    }
  }
  // Buildings touching the chunk (with a margin for shadows cast from the north-west).
  const seen = new Set<number>();
  for (let y = Math.max(0, ty0 - 1); y < Math.min(h, ty1 + 1); y++) {
    for (let x = Math.max(0, tx0 - 1); x < Math.min(w, tx1 + 1); x++) {
      const id = world.buildingAt[y * w + x];
      if (id < 0 || seen.has(id)) continue;
      seen.add(id);
      const b = city.buildings[id];
      if (!b) continue;
      drawBuilding(ctx, b, ppt);
      drew = true;
    }
  }
  return drew;
}

/** Tile check used by the terrain painter to skip trees under roads and buildings. */
export function occupiedTile(world: World, t: number): boolean {
  return world.buildingAt[t] >= 0 || world.roads.hasGroundRoad(t);
}

// ---------------------------------------------------------------- dynamic layers

/** Warm window lights at night. */
export function drawBuildingLights(ctx: CanvasRenderingContext2D, r: Renderer, world: World): void {
  const dark = 1 - world.clock.daylight;
  if (dark < 0.25 || r.camera.zoom * TILE < 8) return;
  const vis = r.camera.visibleRect(TILE);
  const alpha = Math.min(1, (dark - 0.25) / 0.45);
  ctx.fillStyle = `rgba(255, 214, 120, ${0.85 * alpha})`;
  for (const b of world.city.buildings) {
    if (!b || b.state !== BState.Active) continue;
    if ((b.x1 + 1) * TILE < vis.x0 || b.x0 * TILE > vis.x1 || (b.y1 + 1) * TILE < vis.y0 || b.y0 * TILE > vis.y1) continue;
    if (b.zone === Zone.Residential && b.people.length === 0) continue;
    const lay = layoutOf(b);
    for (const bx of lay.boxes) {
      const s = Math.min(1.6, Math.min(bx.r.w, bx.r.h) * 0.12);
      for (let i = 0; i < bx.windows.length; i++) {
        // Some lights switch off late at night.
        if (dark > 0.8 && (i + b.id) % 3 === 0) continue;
        const [fx, fy] = bx.windows[i];
        ctx.fillRect(bx.r.x + fx * bx.r.w - s / 2, bx.r.y + fy * bx.r.h - s / 2, s, s);
      }
    }
  }
}

const PROBLEM_ORDER = [Problem.NoRoad, Problem.NoConnection, Problem.NoJobs, Problem.Unhappy, Problem.NoWorkers, Problem.NoGoods, Problem.NoInputs, Problem.NoCustomers, Problem.LongCommute];
const SEVERE = Problem.NoRoad | Problem.NoConnection | Problem.Unhappy | Problem.NoJobs;

/** The most important problem a building currently shows (0 = none). */
export function topProblem(b: Building): number {
  const p = b.shownProblems;
  if (!p) return 0;
  for (const k of PROBLEM_ORDER) if (p & k) return k;
  return 0;
}

function glyph(ctx: CanvasRenderingContext2D, p: number): void {
  ctx.beginPath();
  switch (p) {
    case Problem.NoRoad:
      ctx.moveTo(-3, 5);
      ctx.lineTo(-1.5, -5);
      ctx.moveTo(3, 5);
      ctx.lineTo(1.5, -5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-5, -5);
      ctx.lineTo(5, 5);
      break;
    case Problem.NoConnection:
      ctx.moveTo(-5, 0);
      ctx.lineTo(3, 0);
      ctx.moveTo(0, -3.5);
      ctx.lineTo(3.5, 0);
      ctx.lineTo(0, 3.5);
      ctx.moveTo(5.5, -4.5);
      ctx.lineTo(5.5, 4.5);
      break;
    case Problem.Unhappy:
      ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
      ctx.moveTo(-2.8, 3.2);
      ctx.quadraticCurveTo(0, 0.6, 2.8, 3.2);
      ctx.moveTo(-2, -1.6);
      ctx.lineTo(-2, -1.4);
      ctx.moveTo(2, -1.6);
      ctx.lineTo(2, -1.4);
      break;
    case Problem.NoJobs:
      ctx.rect(-5, -2, 10, 7);
      ctx.moveTo(-2, -2);
      ctx.lineTo(-2, -4.5);
      ctx.lineTo(2, -4.5);
      ctx.lineTo(2, -2);
      ctx.moveTo(-5, 1.2);
      ctx.lineTo(5, 1.2);
      break;
    case Problem.NoWorkers:
      ctx.arc(0, -2.6, 2.4, 0, Math.PI * 2);
      ctx.moveTo(-4.5, 5.5);
      ctx.quadraticCurveTo(0, -1.5, 4.5, 5.5);
      break;
    case Problem.NoGoods:
      ctx.rect(-4.5, -3.5, 9, 8);
      ctx.moveTo(-4.5, -0.5);
      ctx.lineTo(4.5, -0.5);
      ctx.moveTo(0, -3.5);
      ctx.lineTo(0, -0.5);
      break;
    case Problem.NoInputs:
      ctx.moveTo(0, 5.5);
      ctx.lineTo(0, -5);
      for (const y of [-3, 0, 3]) {
        ctx.moveTo(0, y + 1.5);
        ctx.lineTo(-2.8, y - 0.8);
        ctx.moveTo(0, y + 1.5);
        ctx.lineTo(2.8, y - 0.8);
      }
      break;
    case Problem.NoCustomers:
      ctx.moveTo(-4.5, -3);
      ctx.lineTo(4.5, -3);
      ctx.lineTo(3.5, 5);
      ctx.lineTo(-3.5, 5);
      ctx.closePath();
      ctx.moveTo(-2, -3);
      ctx.arc(0, -3, 2, Math.PI, 0);
      break;
    default:
      ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
      ctx.moveTo(0, -3.2);
      ctx.lineTo(0, 0);
      ctx.lineTo(2.4, 1.6);
  }
  ctx.stroke();
}

/** Floating problem badges above buildings (no road, no workers, no goods...). */
export function drawProblemIcons(ctx: CanvasRenderingContext2D, r: Renderer, world: World, time: number): void {
  const cam = r.camera;
  const tilePx = cam.zoom * TILE;
  if (tilePx < 7) return;
  const vis = cam.visibleRect(TILE);
  const scale = Math.min(1, 0.6 + tilePx / 60);
  ctx.save();
  ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const b of world.city.buildings) {
    if (!b) continue;
    const p = topProblem(b);
    if (!p) continue;
    if ((b.x1 + 1) * TILE < vis.x0 || b.x0 * TILE > vis.x1 || (b.y1 + 1) * TILE < vis.y0 || b.y0 * TILE > vis.y1) continue;
    const sx = cam.worldToScreenX(b.cx);
    const sy = cam.worldToScreenY(b.cy) - 10 * scale + Math.sin(time * 2.4 + b.id) * 1.6;
    ctx.setTransform(r.dpr * scale, 0, 0, r.dpr * scale, sx * r.dpr, sy * r.dpr);
    ctx.fillStyle = 'rgba(20, 30, 40, 0.25)';
    ctx.beginPath();
    ctx.arc(1, 2, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = SEVERE & p ? '#d4453a' : '#e08a1e';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 1.6;
    glyph(ctx, p);
  }
  ctx.restore();
  r.applyWorldTransform();
}

/** Tints every building by its happiness (views menu). */
export function drawHappinessOverlay(ctx: CanvasRenderingContext2D, r: Renderer, world: World): void {
  const vis = r.camera.visibleRect(TILE);
  for (const b of world.city.buildings) {
    if (!b || b.state !== BState.Active) continue;
    if ((b.x1 + 1) * TILE < vis.x0 || b.x0 * TILE > vis.x1 || (b.y1 + 1) * TILE < vis.y0 || b.y0 * TILE > vis.y1) continue;
    const k = Math.max(0, Math.min(1, (b.happiness - 20) / 65));
    const red: RGB = [222, 70, 58];
    const yellow: RGB = [236, 190, 60];
    const green: RGB = [62, 168, 88];
    const c = k < 0.5 ? mix(red, yellow, k * 2) : mix(yellow, green, (k - 0.5) * 2);
    ctx.fillStyle = `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, 0.62)`;
    ctx.fillRect(b.x0 * TILE + 1, b.y0 * TILE + 1, (b.x1 - b.x0 + 1) * TILE - 2, (b.y1 - b.y0 + 1) * TILE - 2);
  }
}
