import { compileNetwork } from '../../src/roads/compile';
import type { Network, Segment } from '../../src/roads/network';
import { RoadLayer } from '../../src/roads/roadLayer';
import { JunctionSettings } from '../../src/roads/settings';
import { VKind } from '../../src/sim/params';
import { TrafficSim } from '../../src/sim/Traffic';
import type { Destination, Vehicle } from '../../src/sim/vehicle';
import { dirFromDelta } from '../../src/world/grid';

export const W = 48;

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

export function paint(l: RoadLayer, pts: Array<[number, number]>, type: number, speedKmh = 0): void {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    l.setEdge(y0 * l.w + x0, dirFromDelta(x1 - x0, y1 - y0), type, true, speedKmh);
  }
}

export const tile = (x: number, y: number): number => y * W + x;

export function build(l: RoadLayer, settings = new JunctionSettings()): { net: Network; sim: TrafficSim; settings: JunctionSettings } {
  const net = compileNetwork({ layer: l, settings, outside: [] });
  const sim = new TrafficSim(net, settings, 7);
  sim.settings.despawnStuck = false;
  return { net, sim, settings };
}

/** Segment that contains the edge between two tiles. */
export function segAt(net: Network, l: RoadLayer, a: [number, number], b: [number, number]): Segment {
  const e = l.edgeIndex(tile(...a), dirFromDelta(b[0] - a[0], b[1] - a[1]));
  const seg = net.segmentAtEdge(e);
  if (!seg) throw new Error('no segment');
  return seg;
}

/** Destination / origin helpers on a segment travelling from tile a towards tile b. */
export function dirOf(seg: Segment, a: [number, number]): boolean {
  return seg.tiles[0] === tile(...a) || seg.a.tile === tile(...a);
}

export function destOn(seg: Segment, forward: boolean, frac = 0.6): Destination {
  const lanes = forward ? seg.forward : seg.backward;
  return { seg, forward, s: lanes[0].length * frac, tile: seg.tiles[0], outside: false };
}

export function spawn(sim: TrafficSim, seg: Segment, forward: boolean, s: number, dest: Destination, done?: (v: Vehicle, arrived: boolean) => void): void {
  const lanes = forward ? seg.forward : seg.backward;
  sim.request({ kind: VKind.Car, origins: [{ lane: lanes[0], s }], dests: [dest], onTrip: done });
}

export function checkNoOverlap(sim: TrafficSim): number {
  let worst = Infinity;
  for (const lane of sim.net.lanes) {
    for (let i = 1; i < lane.vehicles.length; i++) {
      const a = lane.vehicles[i - 1];
      const b = lane.vehicles[i];
      worst = Math.min(worst, a.s - a.length - b.s);
    }
  }
  for (const c of sim.net.connectors) {
    for (let i = 1; i < c.vehicles.length; i++) {
      const a = c.vehicles[i - 1];
      const b = c.vehicles[i];
      worst = Math.min(worst, a.s - a.length - b.s);
    }
  }
  return worst;
}

export function run(sim: TrafficSim, seconds: number, each?: () => void): void {
  const steps = Math.round(seconds / 0.1);
  for (let i = 0; i < steps; i++) {
    sim.step(0.1);
    each?.();
  }
}
