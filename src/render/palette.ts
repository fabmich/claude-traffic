/** Flat pastel palette (Mini Motorways inspired). RGB triples for computed shades. */
export type RGB = readonly [number, number, number];

export const PAL = {
  background: '#1d2830',
  grass: [178, 214, 150] as RGB,
  forestFloor: [160, 203, 136] as RGB,
  trees: ['#6ea55a', '#62994f', '#7cb368', '#588f47'],
  treeShadow: 'rgba(40, 70, 35, 0.28)',
  sand: [236, 225, 186] as RGB,
  waterShallow: [140, 197, 232] as RGB,
  waterDeep: [98, 162, 216] as RGB,
  rockLow: [178, 170, 158] as RGB,
  rockHigh: [140, 132, 122] as RGB,
  snow: [245, 244, 240] as RGB,
  farmland: [214, 204, 128] as RGB,
  farmStripe: 'rgba(150, 128, 60, 0.28)',
  rich: [192, 178, 210] as RGB,
  ore: ['#8a6fb0', '#7a60a0', '#a68cc8'],
  grid: 'rgba(40, 60, 40, 0.12)',
} as const;

export function rgb(c: RGB, k = 1): string {
  return `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
