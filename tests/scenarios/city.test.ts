import { describe, expect, it } from 'vitest';
import { World } from '../../src/game/World';
import { Zone } from '../../src/city/zones';
import { BState } from '../../src/city/buildings';
import { ROAD } from '../../src/roads/roadTypes';
import { generateMap } from '../../src/world/mapgen';
import { DX, DY } from '../../src/world/grid';
import { DAY_SECONDS } from '../../src/config';
import { Terrain } from '../../src/world/terrain';

/** A flat map with a street grid connected to the first highway exit. */
export function makeTown(sandbox = true): { world: World; cx: number; cy: number } {
  const map = generateMap({ seed: 11, size: 96 });
  map.terrain.fill(Terrain.Grass);
  // Farmland and rich ground patches for farms and factories.
  const world = new World({ seed: 11, size: 96, cityName: 'T', sandbox }, map);
  const W = map.w;
  const oc = map.outside[0];
  const ex = oc.x + DX[oc.dir] * oc.length;
  const ey = oc.y + DY[oc.dir] * oc.length;
  const road = (a: [number, number], b: [number, number], type: number = ROAD.street) => {
    const path: number[] = [];
    let [x, y] = a;
    path.push(y * W + x);
    while (x !== b[0] || y !== b[1]) {
      x += Math.sign(b[0] - x);
      y += Math.sign(b[1] - y);
      path.push(y * W + x);
    }
    const err = world.applyRoadPlan(world.planRoad(path, type, false));
    if (err && err !== 'Already built') throw new Error(err);
  };
  // Main road from the exit into the map.
  const cx = ex + DX[oc.dir] * 14;
  const cy = ey + DY[oc.dir] * 14;
  road([ex, ey], [cx, cy], ROAD.avenue);
  // A grid of streets around the centre.
  for (let k = -12; k <= 12; k += 6) {
    road([cx - 12, cy + k], [cx + 12, cy + k]);
    road([cx + k, cy - 12], [cx + k, cy + 12]);
  }
  for (let y = cy - 12; y <= cy + 12; y++) {
    for (let x = cx - 12; x <= cx + 12; x++) {
      const t = y * W + x;
      if (x > cx + 6 && y > cy) map.terrain[t] = Terrain.Farmland;
      if (x < cx - 6 && y > cy) map.terrain[t] = Terrain.Rich;
    }
  }
  const zone = (x0: number, y0: number, x1: number, y1: number, z: number) => {
    const tiles: number[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push(y * W + x);
    world.city.paintZone(tiles, z);
  };
  zone(cx - 12, cy - 12, cx + 12, cy - 1, Zone.Residential);
  zone(cx - 5, cy + 1, cx + 5, cy + 12, Zone.Commercial);
  zone(cx - 12, cy + 1, cx - 6, cy + 12, Zone.Industrial);
  zone(cx + 7, cy + 1, cx + 12, cy + 12, Zone.Farming);
  return { world, cx, cy };
}

describe('city simulation', () => {
  it('grows a town: residents, jobs, trips, freight and money flow', () => {
    const { world } = makeTown(false);
    const money0 = world.money;
    const city = world.city;
    let maxVehicles = 0;
    let trucks = 0;
    const days = 5;
    const steps = Math.round((DAY_SECONDS * days) / 0.1);
    for (let i = 0; i < steps; i++) {
      world.step(0.1);
      if (i % 50 === 0) {
        maxVehicles = Math.max(maxVehicles, world.traffic.count);
        trucks = Math.max(trucks, world.traffic.vehicles.filter((v) => v.kind === 1).length);
      }
    }
    const buildings = city.buildings.filter((b) => b && b.state === BState.Active);
    const byZone = [0, 0, 0, 0, 0];
    for (const b of buildings) byZone[b!.zone]++;
    console.log(
      `pop=${city.population} workers=${city.workers} employed=${city.employed} jobs=${city.jobs} buildings=${JSON.stringify(byZone)} ` +
        `demand=${JSON.stringify(city.demand)} money=${Math.round(world.money)} (start ${money0}) vehicles max=${maxVehicles} trucks=${trucks} ` +
        `trips=${city.tripsStarted} arrived=${world.traffic.stats.arrived} happiness=${city.happiness.toFixed(0)} commute=${city.commuteMinutes.toFixed(0)}min`,
    );
    expect(city.population).toBeGreaterThan(50);
    expect(byZone[Zone.Residential]).toBeGreaterThan(3);
    expect(byZone[Zone.Commercial] + byZone[Zone.Industrial] + byZone[Zone.Farming]).toBeGreaterThan(3);
    expect(city.employed).toBeGreaterThan(10);
    expect(world.traffic.stats.arrived).toBeGreaterThan(20);
    expect(trucks).toBeGreaterThan(0);
  }, 300_000);
});

describe('zoning and building rules', () => {
  it('zones only near roads with driveways, never on roads or cut corners', () => {
    const { world, cx, cy } = makeTown(true);
    const W = world.map.w;
    const city = world.city;
    const t = (x: number, y: number) => y * W + x;
    // Street along y = cy - 12; tiles right next to it are zoneable, road tiles are not.
    expect(city.zoneable[t(cx + 1, cy - 11)]).toBe(1);
    expect(city.zoneable[t(cx + 1, cy - 12)]).toBe(0);
    expect(city.canZone(t(cx + 1, cy - 12), Zone.Residential)).toBe(false);
    // Four tiles away from every road: too far.
    expect(city.zoneable[t(cx - 12 - 4, cy - 12 - 4)]).toBe(0);
    // A diagonal road cuts the corners of its two side tiles.
    const x0 = cx + 14;
    const y0 = cy - 14;
    const err = world.applyRoadPlan(world.planRoad([t(x0, y0), t(x0 + 1, y0 + 1), t(x0 + 2, y0 + 2)], ROAD.street, false));
    expect(err).toBeNull();
    expect(city.zoneable[t(x0 + 1, y0)]).toBe(0);
    expect(city.zoneable[t(x0, y0 + 1)]).toBe(0);
    expect(city.zoneable[t(x0 + 3, y0 + 1)]).toBe(1);
  });

  it('removing a road removes zoning that lost its access', () => {
    const { world, cx, cy } = makeTown(true);
    const W = world.map.w;
    const t = (x: number, y: number) => y * W + x;
    // A lone street far from the grid, zoned on one side.
    const path: number[] = [];
    for (let x = cx - 10; x <= cx + 10; x++) path.push(t(x, cy - 20));
    expect(world.applyRoadPlan(world.planRoad(path, ROAD.street, false))).toBeNull();
    const tiles: number[] = [];
    for (let x = cx - 8; x <= cx + 8; x++) tiles.push(t(x, cy - 21));
    expect(world.city.paintZone(tiles, Zone.Residential)).toBe(tiles.length);
    world.applyBulldoze(world.planBulldoze(path));
    expect(tiles.every((k) => world.city.zones[k] === 0)).toBe(true);
  });

  it('roads built through buildings demolish them', () => {
    const { world } = makeTown(true);
    for (let i = 0; i < 3000; i++) world.step(0.1);
    const b = world.city.buildings.find((x) => x !== null && x.state === BState.Active);
    expect(b).toBeTruthy();
    const W = world.map.w;
    const tile = b!.tiles[0];
    const x = tile % W;
    const y = Math.floor(tile / W);
    // A short road ending on the building tile, coming from its road side.
    const plan = world.planRoad([b!.roadTile, tile], ROAD.street, false);
    expect(plan.valid).toBe(true);
    expect(plan.demolish).toContain(b!.id);
    expect(world.applyRoadPlan(plan)).toBeNull();
    expect(world.city.buildings[b!.id]).toBeNull();
    expect(world.buildingAt[y * W + x]).toBe(-1);
  });
});
