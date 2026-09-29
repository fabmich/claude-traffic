import { describe, expect, it } from 'vitest';
import { planBulldoze, planRoad, type PlanContext } from '../../src/roads/placement';
import { RoadLayer } from '../../src/roads/roadLayer';
import { ROAD, ROAD_TYPES } from '../../src/roads/roadTypes';
import { Terrain } from '../../src/world/terrain';

const W = 24;
function ctx(): PlanContext {
  const terrain = new Uint8Array(W * W).fill(Terrain.Grass);
  // Vertical river at x = 10..11, mountain block x = 16..19, y = 0..9
  for (let y = 0; y < W; y++) {
    terrain[y * W + 10] = Terrain.Water;
    terrain[y * W + 11] = Terrain.Water;
  }
  for (let y = 0; y < 10; y++) for (let x = 16; x < 20; x++) terrain[y * W + x] = Terrain.Mountain;
  return { w: W, h: W, terrain, buildingAt: new Int32Array(W * W).fill(-1), roads: new RoadLayer(W, W) };
}
const row = (y: number, x0: number, x1: number) => {
  const out: number[] = [];
  for (let x = x0; x0 <= x1 ? x <= x1 : x >= x1; x += x0 <= x1 ? 1 : -1) out.push(y * W + x);
  return out;
};
function apply(c: PlanContext, plan: ReturnType<typeof planRoad>) {
  for (const e of plan.edges) c.roads.setEdge(e.tile, e.dir, e.type, e.flowOut);
  for (const s of plan.spans) c.roads.addSpan({ ...s, flags: 0, speed: 0, attr: 0 });
}

describe('road placement', () => {
  it('builds ground edges with per-tile cost', () => {
    const c = ctx();
    const plan = planRoad(c, row(15, 2, 6), ROAD.street, false);
    expect(plan.valid).toBe(true);
    expect(plan.edges.length).toBe(4);
    expect(plan.cost).toBe(4 * ROAD_TYPES[ROAD.street].cost);
  });

  it('auto-creates a straight bridge over water', () => {
    const c = ctx();
    const plan = planRoad(c, row(15, 7, 14), ROAD.street, false);
    expect(plan.valid).toBe(true);
    expect(plan.spans.length).toBe(1);
    expect(plan.spans[0].kind).toBe('bridge');
    expect(plan.spans[0].len).toBe(3); // tiles 9 -> 12 over water at 10, 11
  });

  it('auto-creates a tunnel through rock', () => {
    const c = ctx();
    const plan = planRoad(c, row(5, 13, 22), ROAD.street, false);
    expect(plan.valid).toBe(true);
    expect(plan.spans.map((s) => s.kind)).toEqual(['tunnel']);
    expect(plan.spans[0].len).toBe(5);
  });

  it('rejects bending over water and ending in water', () => {
    const c = ctx();
    const bend = [15 * W + 9, 15 * W + 10, 16 * W + 11, 16 * W + 12];
    expect(planRoad(c, bend, ROAD.street, false).valid).toBe(false);
    expect(planRoad(c, row(15, 7, 10), ROAD.street, false).valid).toBe(false);
  });

  it('does not let diagonals cross', () => {
    const c = ctx();
    apply(c, planRoad(c, [2 * W + 2, 3 * W + 3], ROAD.street, false));
    const cross = planRoad(c, [2 * W + 3, 3 * W + 2], ROAD.street, false);
    expect(cross.valid).toBe(false);
  });

  it('overpass creates a bridge over an existing road', () => {
    const c = ctx();
    apply(c, planRoad(c, row(15, 2, 8), ROAD.street, false));
    const col = [13 * W + 5, 14 * W + 5, 15 * W + 5, 16 * W + 5, 17 * W + 5];
    const plan = planRoad(c, col, ROAD.street, true);
    expect(plan.valid).toBe(true);
    expect(plan.spans[0].kind).toBe('bridge');
    expect(plan.edges.length).toBe(0);
  });

  it('upgrading costs less than building new and same type is a no-op', () => {
    const c = ctx();
    apply(c, planRoad(c, row(15, 2, 6), ROAD.street, false));
    expect(planRoad(c, row(15, 2, 6), ROAD.street, false).valid).toBe(false);
    const up = planRoad(c, row(15, 2, 6), ROAD.avenue, false);
    expect(up.valid).toBe(true);
    expect(up.cost).toBeLessThan(4 * ROAD_TYPES[ROAD.avenue].cost);
  });

  it('bulldoze refunds half and skips protected edges', () => {
    const c = ctx();
    apply(c, planRoad(c, row(15, 2, 6), ROAD.street, false));
    const e = c.roads.edgeIndex(15 * W + 2, 0);
    c.roads.protectedEdges.add(e);
    const plan = planBulldoze(c, row(15, 2, 6));
    expect(plan.protectedHit).toBe(true);
    expect(plan.edges.length).toBe(3);
    expect(plan.refund).toBe(Math.round(3 * ROAD_TYPES[ROAD.street].cost * 0.5));
  });
});
