import { describe, expect, it } from 'vitest';
import { World } from '../../src/game/World';
import { ROAD } from '../../src/roads/roadTypes';
import { generateMap } from '../../src/world/mapgen';
import { SIGNAL_COST } from '../../src/config';

function flatWorld(sandbox = false): World {
  const map = generateMap({ seed: 5, size: 96 });
  map.terrain.fill(0);
  return new World({ seed: 5, size: 96, cityName: 'Test', sandbox }, map);
}

function road(w: World, a: [number, number], b: [number, number], type: number): void {
  const path: number[] = [];
  let [x, y] = a;
  path.push(y * w.map.w + x);
  while (x !== b[0] || y !== b[1]) {
    x += Math.sign(b[0] - x);
    y += Math.sign(b[1] - y);
    path.push(y * w.map.w + x);
  }
  const err = w.applyRoadPlan(w.planRoad(path, type, false));
  if (err) throw new Error(err);
}

describe('traffic management operations', () => {
  it('traffic lights cost money and need 3+ roads', () => {
    const w = flatWorld();
    road(w, [20, 30], [50, 30], ROAD.street);
    road(w, [35, 15], [35, 45], ROAD.street);
    const tile = 30 * w.map.w + 35;
    const money = w.money;
    expect(w.setJunctionControl(tile, 'signals')).toBeNull();
    expect(w.money).toBe(money - SIGNAL_COST);
    expect(w.traffic.control(w.network.nodeByTile.get(tile)!).kind).toBe('signals');
    // Straight road middle: not a junction with 3 roads.
    expect(w.setJunctionControl(30 * w.map.w + 25, 'signals')).not.toBeNull();
  });

  it('roundabout conversion replaces the node with a ring', () => {
    const w = flatWorld(true);
    road(w, [20, 30], [50, 30], ROAD.street);
    road(w, [35, 15], [35, 45], ROAD.street);
    const tile = 30 * w.map.w + 35;
    expect(w.setJunctionControl(tile, 'roundabout')).toBeNull();
    expect(w.network.roundabouts.has(tile)).toBe(true);
    expect(w.junctionArmCount(tile)).toBe(4);
    expect(w.setJunctionControl(tile, 'auto')).toBeNull();
    expect(w.network.roundabouts.has(tile)).toBe(false);
    expect(w.network.nodeByTile.get(tile)?.arms.length).toBe(4);
  });

  it('lane targets persist and reset', () => {
    const w = flatWorld(true);
    road(w, [20, 30], [50, 30], ROAD.avenue);
    road(w, [35, 15], [35, 45], ROAD.avenue);
    const tile = 30 * w.map.w + 35;
    w.setLaneTargets(tile, 4, 1, [[6, 1]]);
    const node = w.network.nodeByTile.get(tile)!;
    const lane = node.armByDir(4)!.ins[1];
    expect(lane.outs.map((c) => c.turn)).toEqual([6]);
    w.resetJunctionLanes(tile);
    const lane2 = w.network.nodeByTile.get(tile)!.armByDir(4)!.ins[1];
    expect(lane2.outs.length).toBeGreaterThan(1);
  });

  it('speed limits and one-way reversal apply to whole segments', () => {
    const w = flatWorld(true);
    road(w, [20, 30], [40, 30], ROAD.street);
    const seg = w.network.segments.find((s) => s.type.id === ROAD.street)!;
    w.setSegmentAttrs(seg.key, { speedKmh: 30, truckBan: true });
    const seg2 = w.network.segByKey.get(seg.key)!;
    expect(Math.round(seg2.speedLimit * 3.6)).toBe(30);
    expect(seg2.truckBan).toBe(true);

    road(w, [20, 40], [40, 40], ROAD.oneway);
    const ow = w.network.segments.find((s) => s.type.id === ROAD.oneway)!;
    const before = ow.forward.length;
    w.reverseOneWay(ow.key);
    const after = w.network.segByKey.get(ow.key)!;
    expect(after.forward.length).toBe(before === 0 ? 2 : 0);
  });
});
