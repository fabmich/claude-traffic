import type { Rng } from './rng';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1]);

/** Seeded 2D simplex noise, output roughly in [-1, 1]. */
export class Simplex2 {
  private perm = new Uint8Array(512);
  private pm12 = new Uint8Array(512);

  constructor(rng: Rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.pm12[i] = this.perm[i] % 12;
    }
  }

  noise(xin: number, yin: number): number {
    const perm = this.perm;
    const pm12 = this.pm12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1 = 0;
    let j1 = 1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi = pm12[ii + perm[jj]] * 2;
      t0 *= t0;
      n += t0 * t0 * (GRAD[gi] * x0 + GRAD[gi + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi = pm12[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1;
      n += t1 * t1 * (GRAD[gi] * x1 + GRAD[gi + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi = pm12[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2;
      n += t2 * t2 * (GRAD[gi] * x2 + GRAD[gi + 1] * y2);
    }
    return 70 * n;
  }
}

/** Fractal Brownian motion, normalized to roughly [-1, 1]. */
export function fbm(n: Simplex2, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * n.noise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal noise in [0, 1]; high values form sharp ridges. */
export function ridged(n: Simplex2, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const r = 1 - Math.abs(n.noise(x * freq, y * freq));
    sum += amp * r * r;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
