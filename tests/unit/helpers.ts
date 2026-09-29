import { RoadLayer } from '../../src/roads/roadLayer';
import { JunctionSettings } from '../../src/roads/settings';
import { compileNetwork } from '../../src/roads/compile';
import { dirFromDelta } from '../../src/world/grid';
import type { OutsideConnection } from '../../src/world/WorldMap';

export const W = 32;

export function layer(w = W, h = W): RoadLayer {
  return new RoadLayer(w, h);
}

/** Paints a road along a list of tile coordinates (each step must be to an 8-neighbour). */
export function paint(l: RoadLayer, pts: Array<[number, number]>, type: number): void {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const d = dirFromDelta(x1 - x0, y1 - y0);
    if (d < 0) throw new Error(`not adjacent: ${pts[i - 1]} -> ${pts[i]}`);
    l.setEdge(y0 * l.w + x0, d, type, true);
  }
}

/** Straight line of tiles from a to b (inclusive), 8-directional. */
export function line(a: [number, number], b: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [a];
  let [x, y] = a;
  while (x !== b[0] || y !== b[1]) {
    x += Math.sign(b[0] - x);
    y += Math.sign(b[1] - y);
    out.push([x, y]);
  }
  return out;
}

export function compile(l: RoadLayer, settings = new JunctionSettings(), outside: OutsideConnection[] = []) {
  return compileNetwork({ layer: l, settings, outside });
}
