import { describe, expect, it } from 'vitest';
import { DAY_SECONDS, LANE_W, TILE } from '../../src/config';
import { loadWorld, packSave, saveWorld, unpackSave } from '../../src/game/save';
import { Stop } from '../../src/transit/Transit';
import { makeTown } from './town';

describe('save games', () => {
  it('round-trips a running city with junction settings and a bus line', async () => {
    const { world, cx, cy } = makeTown(false);
    const W = world.map.w;
    expect(world.setJunctionControl(cy * W + cx, 'signals')).toBeNull();
    const stops: Stop[] = [];
    for (const [x, y, h] of [
      [cx - 9, cy - 6, 0],
      [cx, cy + 3, Math.PI / 2],
      [cx, cy - 3, -Math.PI / 2],
    ] as Array<[number, number, number]>) {
      const s = world.transit.addStop((x + 0.5) * TILE - Math.sin(h) * (LANE_W / 2), (y + 0.5) * TILE + Math.cos(h) * (LANE_W / 2), h);
      expect(s).toBeInstanceOf(Stop);
      stops.push(s as Stop);
    }
    world.transit.createLine(stops);
    for (let i = 0; i < DAY_SECONDS / 0.1; i++) world.step(0.1);

    const data = saveWorld(world);
    const text = await packSave(data);
    expect(text.length).toBeLessThan(400_000);
    const back = loadWorld(await unpackSave(text));

    expect(back.city.population).toBe(world.city.population);
    expect(back.city.buildings.filter(Boolean).length).toBe(world.city.buildings.filter(Boolean).length);
    expect(Array.from(back.city.zones)).toEqual(Array.from(world.city.zones));
    expect(Array.from(back.roads.type)).toEqual(Array.from(world.roads.type));
    expect(back.network.segments.length).toBe(world.network.segments.length);
    expect(back.traffic.control(back.network.nodeByTile.get(cy * W + cx)!).kind).toBe('signals');
    expect(back.money).toBeCloseTo(world.money, 5);
    expect(back.clock.day).toBe(world.clock.day);
    expect(back.transit.lines.length).toBe(1);
    expect(back.transit.lines[0].stops.every((s) => s.valid)).toBe(true);
    expect(Array.from(back.buildingAt)).toEqual(Array.from(world.buildingAt));
    // Jobs survive: every employed citizen is on the staff list of their workplace.
    for (const c of back.city.citizens) if (c?.job) expect(c.job.people).toContain(c.id);

    // The loaded game keeps running: buses come back and the city keeps working.
    let buses = 0;
    for (let i = 0; i < (DAY_SECONDS * 0.4) / 0.1; i++) {
      back.step(0.1);
      if (i % 50 === 0) buses = Math.max(buses, back.traffic.vehicles.filter((v) => v.kind === 2).length);
    }
    expect(buses).toBeGreaterThan(0);
    expect(back.city.population).toBeGreaterThan(world.city.population * 0.8);
  }, 120_000);
});
