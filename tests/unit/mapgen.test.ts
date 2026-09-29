import { describe, expect, it } from 'vitest';
import { generateMap } from '../../src/world/mapgen';
import { Terrain } from '../../src/world/terrain';

describe('map generation', () => {
  it('is deterministic for a seed', () => {
    const a = generateMap({ seed: 1234, size: 96 });
    const b = generateMap({ seed: 1234, size: 96 });
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
    expect(a.outside).toEqual(b.outside);
  });

  it('different seeds give different maps', () => {
    const a = generateMap({ seed: 1, size: 96 });
    const b = generateMap({ seed: 2, size: 96 });
    expect(Array.from(a.terrain)).not.toEqual(Array.from(b.terrain));
  });

  for (const seed of [7, 42, 99, 2024, 31337]) {
    for (const size of [96, 128]) {
      it(`has sensible terrain proportions (seed ${seed}, size ${size})`, () => {
        const map = generateMap({ seed, size });
        const counts = map.countTerrain();
        const frac = (t: number) => counts[t] / map.tileCount;
        expect(frac(Terrain.Water)).toBeGreaterThan(0.02);
        expect(frac(Terrain.Water)).toBeLessThan(0.2);
        expect(frac(Terrain.Mountain)).toBeGreaterThan(0.04);
        expect(frac(Terrain.Mountain)).toBeLessThan(0.14);
        expect(frac(Terrain.Farmland)).toBeGreaterThan(0.05);
        expect(frac(Terrain.Rich)).toBeGreaterThan(0.02);
        expect(frac(Terrain.Forest)).toBeGreaterThan(0.06);
        const buildable = frac(Terrain.Grass) + frac(Terrain.Forest) + frac(Terrain.Farmland) + frac(Terrain.Rich) + frac(Terrain.Sand);
        expect(buildable).toBeGreaterThan(0.65);
        expect(map.outside.length).toBeGreaterThanOrEqual(2);
        for (const oc of map.outside) {
          const t = map.terrainAt(oc.x, oc.y);
          expect(t).not.toBe(Terrain.Water);
          expect(t).not.toBe(Terrain.Mountain);
        }
      });
    }
  }
});
