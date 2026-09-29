/** Sampled 2D polyline with cumulative arc length, used for lanes, connectors and centerlines. */
export interface PointOut {
  x: number;
  y: number;
  /** Heading angle in radians. */
  a: number;
}

export class Polyline {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;
  readonly n: number;

  constructor(xs: ArrayLike<number>, ys: ArrayLike<number>) {
    const n = xs.length;
    this.n = n;
    this.xs = Float64Array.from(xs);
    this.ys = Float64Array.from(ys);
    this.cum = new Float64Array(n);
    let acc = 0;
    for (let i = 1; i < n; i++) {
      acc += Math.hypot(this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]);
      this.cum[i] = acc;
    }
    this.length = acc;
  }

  static fromFlat(pts: number[]): Polyline {
    const n = pts.length >> 1;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = pts[2 * i];
      ys[i] = pts[2 * i + 1];
    }
    return new Polyline(xs, ys);
  }

  /** Closest point to (x, y): arc length, distance and heading there. */
  project(x: number, y: number): { s: number; d: number; a: number } {
    let bs = 0;
    let bd = Infinity;
    let ba = 0;
    for (let i = 0; i < this.n - 1; i++) {
      const ax = this.xs[i];
      const ay = this.ys[i];
      const dx = this.xs[i + 1] - ax;
      const dy = this.ys[i + 1] - ay;
      const l2 = dx * dx + dy * dy;
      if (l2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
      if (d < bd) {
        bd = d;
        bs = this.cum[i] + t * (this.cum[i + 1] - this.cum[i]);
        ba = Math.atan2(dy, dx);
      }
    }
    return { s: bs, d: bd, a: ba };
  }

  /** Index i such that cum[i] <= s < cum[i + 1] (clamped). */
  locate(s: number, hint = -1): number {
    const cum = this.cum;
    const last = this.n - 2;
    if (last < 0) return 0;
    if (hint >= 0 && hint <= last && cum[hint] <= s && s <= cum[hint + 1]) return hint;
    if (hint >= 0 && hint < last && cum[hint + 1] <= s && s <= cum[hint + 2]) return hint + 1;
    let lo = 0;
    let hi = last;
    if (s <= 0) return 0;
    if (s >= cum[last + 1]) return last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Position and heading at arc length s. Returns the segment index used (for hints). */
  pointAt(s: number, out: PointOut, hint = -1): number {
    const i = this.locate(s, hint);
    const x0 = this.xs[i];
    const y0 = this.ys[i];
    if (this.n < 2) {
      out.x = x0;
      out.y = y0;
      out.a = 0;
      return 0;
    }
    const x1 = this.xs[i + 1];
    const y1 = this.ys[i + 1];
    const segLen = this.cum[i + 1] - this.cum[i];
    const t = segLen > 1e-9 ? Math.min(1, Math.max(0, (s - this.cum[i]) / segLen)) : 0;
    out.x = x0 + (x1 - x0) * t;
    out.y = y0 + (y1 - y0) * t;
    out.a = Math.atan2(y1 - y0, x1 - x0);
    return i;
  }

  startHeading(): number {
    return Math.atan2(this.ys[1] - this.ys[0], this.xs[1] - this.xs[0]);
  }

  endHeading(): number {
    const n = this.n;
    return Math.atan2(this.ys[n - 1] - this.ys[n - 2], this.xs[n - 1] - this.xs[n - 2]);
  }

  get x0(): number {
    return this.xs[0];
  }
  get y0(): number {
    return this.ys[0];
  }
  get x1(): number {
    return this.xs[this.n - 1];
  }
  get y1(): number {
    return this.ys[this.n - 1];
  }

  /** Sub-polyline between arc lengths s0 < s1. */
  slice(s0: number, s1: number): Polyline {
    s0 = Math.max(0, Math.min(this.length, s0));
    s1 = Math.max(s0, Math.min(this.length, s1));
    const p: PointOut = { x: 0, y: 0, a: 0 };
    const xs: number[] = [];
    const ys: number[] = [];
    const i0 = this.pointAt(s0, p);
    xs.push(p.x);
    ys.push(p.y);
    const i1 = this.locate(s1);
    for (let i = i0 + 1; i <= i1; i++) {
      if (this.cum[i] > s0 + 1e-6 && this.cum[i] < s1 - 1e-6) {
        xs.push(this.xs[i]);
        ys.push(this.ys[i]);
      }
    }
    this.pointAt(s1, p);
    xs.push(p.x);
    ys.push(p.y);
    if (xs.length === 1) {
      xs.push(p.x + 1e-3);
      ys.push(p.y);
    }
    return new Polyline(xs, ys);
  }

  reverse(): Polyline {
    const n = this.n;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = this.xs[n - 1 - i];
      ys[i] = this.ys[n - 1 - i];
    }
    return new Polyline(xs, ys);
  }

  /** Offsets every point by d along the right-hand normal (screen space, y down). */
  offset(d: number): Polyline {
    const n = this.n;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let tx: number;
      let ty: number;
      if (i === 0) {
        tx = this.xs[1] - this.xs[0];
        ty = this.ys[1] - this.ys[0];
      } else if (i === n - 1) {
        tx = this.xs[i] - this.xs[i - 1];
        ty = this.ys[i] - this.ys[i - 1];
      } else {
        const ax = this.xs[i] - this.xs[i - 1];
        const ay = this.ys[i] - this.ys[i - 1];
        const bx = this.xs[i + 1] - this.xs[i];
        const by = this.ys[i + 1] - this.ys[i];
        const la = Math.hypot(ax, ay) || 1;
        const lb = Math.hypot(bx, by) || 1;
        tx = ax / la + bx / lb;
        ty = ay / la + by / lb;
      }
      const l = Math.hypot(tx, ty) || 1;
      // Right normal of (tx, ty) in y-down screen space is (-ty, tx).
      xs[i] = this.xs[i] - (ty / l) * d;
      ys[i] = this.ys[i] + (tx / l) * d;
    }
    return new Polyline(xs, ys);
  }

  bbox(): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.xs[i] < x0) x0 = this.xs[i];
      if (this.xs[i] > x1) x1 = this.xs[i];
      if (this.ys[i] < y0) y0 = this.ys[i];
      if (this.ys[i] > y1) y1 = this.ys[i];
    }
    return { x0, y0, x1, y1 };
  }

  /** Traces the polyline into the current path of a canvas context. */
  trace(ctx: CanvasRenderingContext2D, from = 0): void {
    ctx.moveTo(this.xs[from], this.ys[from]);
    for (let i = from + 1; i < this.n; i++) ctx.lineTo(this.xs[i], this.ys[i]);
  }

  /** Minimum radius of curvature estimated from consecutive sample triples. */
  minRadius(): number {
    let r = Infinity;
    for (let i = 1; i < this.n - 1; i++) {
      const ax = this.xs[i - 1];
      const ay = this.ys[i - 1];
      const bx = this.xs[i];
      const by = this.ys[i];
      const cx = this.xs[i + 1];
      const cy = this.ys[i + 1];
      const ab = Math.hypot(bx - ax, by - ay);
      const bc = Math.hypot(cx - bx, cy - by);
      const ca = Math.hypot(ax - cx, ay - cy);
      const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
      if (cross < 1e-9) continue;
      const rr = (ab * bc * ca) / (2 * cross);
      if (rr < r) r = rr;
    }
    return r;
  }
}

/** Samples a cubic Bézier curve into a polyline. */
export function cubicBezier(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  segments: number,
): Polyline {
  const xs = new Float64Array(segments + 1);
  const ys = new Float64Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    xs[i] = a * x0 + b * x1 + c * x2 + d * x3;
    ys[i] = a * y0 + b * y1 + c * y2 + d * y3;
  }
  return new Polyline(xs, ys);
}

/**
 * First intersection of two polylines, as arc lengths along each (or null).
 * Ignores touching at the very start points (shared origins).
 */
export function intersectPolylines(a: Polyline, b: Polyline): { sa: number; sb: number } | null {
  const ba = a.bbox();
  const bb = b.bbox();
  if (ba.x1 < bb.x0 || bb.x1 < ba.x0 || ba.y1 < bb.y0 || bb.y1 < ba.y0) return null;
  let best: { sa: number; sb: number } | null = null;
  for (let i = 0; i < a.n - 1; i++) {
    const ax0 = a.xs[i];
    const ay0 = a.ys[i];
    const ax1 = a.xs[i + 1];
    const ay1 = a.ys[i + 1];
    const minx = Math.min(ax0, ax1);
    const maxx = Math.max(ax0, ax1);
    const miny = Math.min(ay0, ay1);
    const maxy = Math.max(ay0, ay1);
    for (let j = 0; j < b.n - 1; j++) {
      const bx0 = b.xs[j];
      const by0 = b.ys[j];
      const bx1 = b.xs[j + 1];
      const by1 = b.ys[j + 1];
      if (Math.max(bx0, bx1) < minx || Math.min(bx0, bx1) > maxx || Math.max(by0, by1) < miny || Math.min(by0, by1) > maxy) continue;
      const dxa = ax1 - ax0;
      const dya = ay1 - ay0;
      const dxb = bx1 - bx0;
      const dyb = by1 - by0;
      const den = dxa * dyb - dya * dxb;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((bx0 - ax0) * dyb - (by0 - ay0) * dxb) / den;
      const u = ((bx0 - ax0) * dya - (by0 - ay0) * dxa) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const sa = a.cum[i] + t * (a.cum[i + 1] - a.cum[i]);
      const sb = b.cum[j] + u * (b.cum[j + 1] - b.cum[j]);
      if (sa < 0.05 && sb < 0.05) continue;
      if (!best || sa < best.sa) best = { sa, sb };
    }
  }
  return best;
}

/** Minimum distance between two polylines' sample points (cheap approximation). */
export function minPointDistance(a: Polyline, b: Polyline): { d: number; sa: number; sb: number } {
  let d = Infinity;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.n; i++) {
    for (let j = 0; j < b.n; j++) {
      const dd = Math.hypot(a.xs[i] - b.xs[j], a.ys[i] - b.ys[j]);
      if (dd < d) {
        d = dd;
        sa = a.cum[i];
        sb = b.cum[j];
      }
    }
  }
  return { d, sa, sb };
}

export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
