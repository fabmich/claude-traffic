import { describe, expect, it } from 'vitest';
import { DAY_SECONDS, LANE_W, TILE } from '../../src/config';
import { VKind } from '../../src/sim/params';
import { Stop } from '../../src/transit/Transit';
import { makeTown } from './town';

/** World point on the curb side of a street tile for a travel direction (0 E, 2 S, 4 W, 6 N). */
function curb(tx: number, ty: number, dir: number): [number, number, number] {
  const cx = (tx + 0.5) * TILE;
  const cy = (ty + 0.5) * TILE;
  const off = LANE_W / 2;
  const heading = [0, 0, Math.PI / 2, 0, Math.PI, 0, -Math.PI / 2][dir];
  // Right-hand side of the travel direction (y points down).
  const nx = -Math.sin(heading);
  const ny = Math.cos(heading);
  return [cx + nx * off, cy + ny * off, heading];
}

describe('buses', () => {
  it('a line through the town carries passengers', () => {
    const { world, cx, cy } = makeTown(true);
    const transit = world.transit;
    const spots: Array<[number, number, number]> = [
      [cx - 9, cy - 6, 0],
      [cx, cy - 3, 2],
      [cx, cy + 3, 2],
      [cx, cy + 9, 2],
      [cx, cy + 3, 6],
      [cx, cy - 3, 6],
      [cx - 3, cy - 6, 4],
      [cx - 9, cy - 6, 4],
    ];
    const stops: Stop[] = [];
    for (const [x, y, d] of spots) {
      const [wx, wy, h] = curb(x, y, d);
      const s = transit.addStop(wx, wy, h);
      expect(s, `stop at ${x - cx},${y - cy} dir ${d}: ${String(s)}`).toBeInstanceOf(Stop);
      stops.push(s as Stop);
    }
    const line = transit.createLine(stops);
    expect(line.broken).toBe(false);
    expect(line.target).toBeGreaterThan(0);
    transit.setBusCount(line, 3);
    let dwelled = 0;
    let maxBuses = 0;
    const steps = Math.round((DAY_SECONDS * 2.5) / 0.1);
    for (let i = 0; i < steps; i++) {
      world.step(0.1);
      if (i % 20 === 0) {
        const buses = world.traffic.vehicles.filter((v) => v.kind === VKind.Bus);
        maxBuses = Math.max(maxBuses, buses.length);
        dwelled += buses.filter((v) => v.dwell > 0).length;
      }
    }
    const pax = transit.passengers;
    const riders = line.riders + line.ridersYesterday;
    console.log(
      `buses max=${maxBuses} dwell samples=${dwelled} riders=${riders} (today ${line.riders}) waiting=${pax.waiting} riding=${pax.riding} ` +
        `modes=${JSON.stringify(world.city.modeCounts)} pop=${world.city.population} cycle=${Math.round(line.cycle)}s headway=${Math.round(line.headway)}s fares=${Math.round(world.city.budgetToday.fares + world.city.budgetYesterday.fares)}`,
    );
    expect(maxBuses).toBeGreaterThanOrEqual(3);
    expect(dwelled).toBeGreaterThan(10);
    expect(riders).toBeGreaterThan(20);
    expect(world.city.modeCounts.bus + world.city.budgetYesterday.fares).toBeGreaterThan(0);
  }, 300_000);

  it('stops need a street side and keep their distance', () => {
    const { world, cx, cy } = makeTown(true);
    const transit = world.transit;
    const [x, y, h] = curb(cx - 9, cy - 6, 0);
    expect(transit.addStop(x, y, h)).toBeInstanceOf(Stop);
    expect(typeof transit.addStop(x + 8, y, h)).toBe('string');
    // Far away from any road.
    expect(typeof transit.addStop(x, y + TILE * 3, h)).toBe('string');
  });
});
