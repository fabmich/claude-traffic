import { describe, expect, it } from 'vitest';
import { ROAD } from '../../src/roads/roadTypes';
import { CompileCache, compileNetwork } from '../../src/roads/compile';
import { JunctionSettings } from '../../src/roads/settings';
import { compile, layer, line, paint } from './helpers';

describe('compile performance', () => {
  it('compiles a large street grid quickly', () => {
    const n = 128;
    const l = layer(n, n);
    for (let k = 4; k < n - 4; k += 5) {
      paint(l, line([4, k], [n - 5, k]), k % 15 === 4 ? ROAD.avenue : ROAD.street);
      paint(l, line([k, 4], [k, n - 5]), ROAD.street);
    }
    const t0 = performance.now();
    const net = compile(l);
    const ms = performance.now() - t0;
    console.log(`grid: ${net.nodes.length} nodes, ${net.segments.length} segments, ${net.connectors.length} connectors in ${ms.toFixed(0)} ms`);
    expect(net.nodes.length).toBeGreaterThan(500);
    expect(ms).toBeLessThan(3000);
  });

  it('cached recompile after a small edit reuses unchanged junctions', () => {
    const n = 128;
    const l = layer(n, n);
    for (let k = 4; k < n - 4; k += 5) {
      paint(l, line([4, k], [n - 5, k]), ROAD.street);
      paint(l, line([k, 4], [k, n - 5]), ROAD.street);
    }
    const cache = new CompileCache();
    const settings = new JunctionSettings();
    const a = compileNetwork({ layer: l, settings, outside: [], cache });
    paint(l, line([6, 6], [8, 8]), ROAD.street);
    cache.hits = 0;
    cache.misses = 0;
    const t0 = performance.now();
    const b = compileNetwork({ layer: l, settings, outside: [], cache });
    const ms = performance.now() - t0;
    console.log(`cached recompile: ${ms.toFixed(0)} ms, hits ${cache.hits}, misses ${cache.misses}`);
    expect(cache.misses).toBeLessThan(10);
    expect(b.connectors.length).toBeGreaterThan(a.connectors.length - 1);
    // Cached and uncached compiles agree.
    const fresh = compileNetwork({ layer: l, settings, outside: [] });
    expect(b.connectors.map((c) => c.key).sort()).toEqual(fresh.connectors.map((c) => c.key).sort());
    const conflictsOf = (net: typeof b) => net.connectors.reduce((s, c) => s + c.conflicts.length, 0);
    expect(conflictsOf(b)).toBe(conflictsOf(fresh));
  });
});
