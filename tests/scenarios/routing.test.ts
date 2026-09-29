import { describe, expect, it } from 'vitest';
import { RoadLayer } from '../../src/roads/roadLayer';
import { ROAD } from '../../src/roads/roadTypes';
import { VKind } from '../../src/sim/params';
import { dsOf } from '../../src/sim/routing';
import { build, destOn, line, paint, segAt, W } from './sim';

function detourNetwork(directKmh: number) {
  const l = new RoadLayer(W, W);
  // Direct street y = 10 from x = 2 to x = 30 (junctions at x = 4 and x = 28).
  paint(l, line([2, 10], [4, 10]), ROAD.street);
  paint(l, line([4, 10], [28, 10]), ROAD.street, directKmh);
  paint(l, line([28, 10], [30, 10]), ROAD.street);
  // Detour: up to the highway at y = 2, along it, and back down.
  paint(l, line([4, 10], [4, 2]), ROAD.street);
  paint(l, line([4, 2], [28, 2]), ROAD.highway);
  paint(l, line([28, 2], [28, 10]), ROAD.street);
  return { l, ...build(l) };
}

describe('route choice', () => {
  it('prefers the direct street when it is faster', () => {
    const { l, net, sim } = detourNetwork(0);
    const start = segAt(net, l, [2, 10], [3, 10]);
    const end = segAt(net, l, [29, 10], [30, 10]);
    const fwdStart = start.tiles[0] === 10 * W + 2;
    const fwdEnd = end.tiles[0] === 10 * W + 28;
    const res = sim.router.route(VKind.Car, [{ ds: dsOf(start, fwdStart), s: 5 }], [destOn(end, fwdEnd)], 1, 36)!;
    expect(res).not.toBeNull();
    const usesHighway = res.legs.some((leg) => leg.seg.type.id === ROAD.highway);
    expect(usesHighway).toBe(false);
  });

  it('takes the longer highway when the direct street is slow', () => {
    const { l, net, sim } = detourNetwork(30);
    const start = segAt(net, l, [2, 10], [3, 10]);
    const end = segAt(net, l, [29, 10], [30, 10]);
    const fwdStart = start.tiles[0] === 10 * W + 2;
    const fwdEnd = end.tiles[0] === 10 * W + 28;
    const res = sim.router.route(VKind.Car, [{ ds: dsOf(start, fwdStart), s: 5 }], [destOn(end, fwdEnd)], 1, 36)!;
    expect(res).not.toBeNull();
    const usesHighway = res.legs.some((leg) => leg.seg.type.id === ROAD.highway);
    expect(usesHighway).toBe(true);
  });

  it('trucks avoid truck-banned roads', () => {
    const l = new RoadLayer(W, W);
    paint(l, line([2, 10], [4, 10]), ROAD.street);
    paint(l, line([4, 10], [28, 10]), ROAD.street);
    paint(l, line([28, 10], [30, 10]), ROAD.street);
    paint(l, line([4, 10], [4, 4]), ROAD.street);
    paint(l, line([4, 4], [28, 4]), ROAD.street);
    paint(l, line([28, 4], [28, 10]), ROAD.street);
    // Ban trucks on the direct middle part.
    for (let x = 4; x < 28; x++) l.attr[l.edgeIndex(10 * W + x, 0)] = 1;
    const { net, sim } = build(l);
    const start = segAt(net, l, [2, 10], [3, 10]);
    const end = segAt(net, l, [29, 10], [30, 10]);
    const fs = start.tiles[0] === 10 * W + 2;
    const fe = end.tiles[0] === 10 * W + 28;
    const car = sim.router.route(VKind.Car, [{ ds: dsOf(start, fs), s: 5 }], [destOn(end, fe)], 1, 36)!;
    const truck = sim.router.route(VKind.Truck, [{ ds: dsOf(start, fs), s: 5 }], [destOn(end, fe)], 1, 25)!;
    expect(car.legs.some((g) => g.seg.truckBan)).toBe(true);
    expect(truck.legs.some((g) => g.seg.truckBan)).toBe(false);
  });
});
