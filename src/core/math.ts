export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Value at quantile q (0..1) of a numeric array (copy is sorted). */
export function quantile(values: ArrayLike<number>, q: number): number {
  const a = Float64Array.from(values as ArrayLike<number>);
  a.sort();
  if (a.length === 0) return 0;
  const i = clamp(Math.floor(q * (a.length - 1)), 0, a.length - 1);
  return a[i];
}

export function formatMoney(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

export function formatInt(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
