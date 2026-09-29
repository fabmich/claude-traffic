import { describe, expect, it } from 'vitest';
import { Zone } from '../../src/city/zones';
import { BState } from '../../src/city/buildings';
import { ROAD } from '../../src/roads/roadTypes';
import { DAY_SECONDS } from '../../src/config';
import { makeTown } from './town';

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
