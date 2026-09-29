import { describe, expect, it } from 'vitest';
import { RoadLayer } from '../../src/roads/roadLayer';
import { ROAD } from '../../src/roads/roadTypes';
import { JunctionSettings } from '../../src/roads/settings';
import type { Vehicle } from '../../src/sim/vehicle';
import { build, checkNoOverlap, destOn, line, paint, run, segAt, spawn, tile, W } from './sim';

describe('traffic simulation', () => {
  it('vehicles follow each other on a street without overlapping and all arrive', () => {
    const l = new RoadLayer(W, W);
    paint(l, line([2, 10], [40, 10]), ROAD.street);
    const { net, sim } = build(l);
    const seg = net.segments[0];
    let arrived = 0;
    for (let i = 0; i < 12; i++) {
      spawn(sim, seg, true, 20, destOn(seg, true, 0.95), (_v, ok) => ok && arrived++);
    }
    let worst = Infinity;
    run(sim, 240, () => (worst = Math.min(worst, checkNoOverlap(sim))));
    expect(arrived).toBe(12);
    expect(worst).toBeGreaterThan(-0.3);
  });

  it('crossroads with traffic from all sides has no deadlock', () => {
    const l = new RoadLayer(W, W);
    paint(l, line([4, 20], [36, 20]), ROAD.street);
    paint(l, line([20, 4], [20, 36]), ROAD.street);
    const { net, sim } = build(l);
    const arms = [
      segAt(net, l, [4, 20], [5, 20]),
      segAt(net, l, [36, 20], [35, 20]),
      segAt(net, l, [20, 4], [20, 5]),
      segAt(net, l, [20, 36], [20, 35]),
    ];
    // For each arm, the direction that travels towards the centre.
    const towards = (seg: (typeof arms)[number]) => seg.b.tile === tile(20, 20);
    let arrived = 0;
    let total = 0;
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          if (i === j) continue;
          const from = arms[i];
          const to = arms[j];
          spawn(sim, from, towards(from), 30 + round * 2, destOn(to, !towards(to), 0.5), (_v, ok) => ok && arrived++);
          total++;
        }
      }
    }
    let worst = Infinity;
    run(sim, 900, () => (worst = Math.min(worst, checkNoOverlap(sim))));
    expect(arrived).toBe(total);
    expect(worst).toBeGreaterThan(-0.3);
  });

  it('traffic lights alternate and let everybody through', () => {
    const l = new RoadLayer(W, W);
    paint(l, line([4, 20], [36, 20]), ROAD.avenue);
    paint(l, line([20, 4], [20, 36]), ROAD.avenue);
    const settings = new JunctionSettings();
    settings.ensure(tile(20, 20)).control = 'signals';
    const { net, sim } = build(l, settings);
    const node = net.nodeByTile.get(tile(20, 20))!;
    const ctrl = sim.control(node);
    expect(ctrl.signal).not.toBeNull();
    const w = segAt(net, l, [4, 20], [5, 20]);
    const e = segAt(net, l, [36, 20], [35, 20]);
    const n = segAt(net, l, [20, 4], [20, 5]);
    const s = segAt(net, l, [20, 36], [20, 35]);
    let arrived = 0;
    for (let k = 0; k < 8; k++) {
      spawn(sim, w, true, 20 + k, destOn(e, false, 0.5), (_v, ok) => ok && arrived++);
      spawn(sim, n, true, 20 + k, destOn(s, false, 0.5), (_v, ok) => ok && arrived++);
    }
    const phases = new Set<number>();
    let redRunning = 0;
    run(sim, 600, () => {
      phases.add(ctrl.signal!.phaseIdx);
      for (const c of node.connectors) {
        for (const v of c.vehicles) if (v.s < 0.8 && ctrl.lightFor(c) === 'red' && ctrl.signal!.state === 'green') redRunning++;
      }
    });
    expect(phases.size).toBeGreaterThanOrEqual(2);
    expect(redRunning).toBe(0);
    expect(arrived).toBe(16);
  });

  it('roundabout keeps traffic flowing', () => {
    const l = new RoadLayer(W, W);
    paint(l, line([4, 20], [36, 20]), ROAD.street);
    paint(l, line([20, 4], [20, 36]), ROAD.street);
    const settings = new JunctionSettings();
    settings.ensure(tile(20, 20)).control = 'roundabout';
    const { net, sim } = build(l, settings);
    expect(net.roundabouts.size).toBe(1);
    expect(net.nodeByTile.get(tile(20, 20))).toBeUndefined();
    const arms = [
      segAt(net, l, [4, 20], [5, 20]),
      segAt(net, l, [36, 20], [35, 20]),
      segAt(net, l, [20, 4], [20, 5]),
      segAt(net, l, [20, 36], [20, 35]),
    ];
    const towards = (seg: (typeof arms)[number]) => seg.b.ringOf === tile(20, 20);
    let arrived = 0;
    let total = 0;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          if (i === j) continue;
          spawn(sim, arms[i], towards(arms[i]), 30 + round, destOn(arms[j], !towards(arms[j]), 0.5), (_v, ok) => ok && arrived++);
          total++;
        }
      }
    }
    run(sim, 900);
    expect(arrived).toBe(total);
  });

  it('lane manager: inner lane left only, curb lane straight and right', () => {
    const l = new RoadLayer(W, W);
    paint(l, line([4, 20], [36, 20]), ROAD.avenue);
    paint(l, line([20, 4], [20, 36]), ROAD.avenue);
    const settings = new JunctionSettings();
    // West arm (dir 4): inner lane 1 -> north (left), curb lane 0 -> east (straight) and south (right).
    settings.ensure(tile(20, 20)).lanes = {
      '4:1': [[6, 1]],
      '4:0': [
        [0, 0],
        [0, 1],
        [2, 0],
      ],
    };
    const { net, sim } = build(l, settings);
    const w = segAt(net, l, [4, 20], [5, 20]);
    const e = segAt(net, l, [36, 20], [35, 20]);
    const n = segAt(net, l, [20, 4], [20, 5]);
    const s = segAt(net, l, [20, 36], [20, 35]);
    const used: Array<{ turn: string; lane: number }> = [];
    const node = net.nodeByTile.get(tile(20, 20))!;
    const seen = new Set<Vehicle>();
    const dests: Array<[string, typeof e]> = [
      ['left', n],
      ['straight', e],
      ['right', s],
    ];
    let arrived = 0;
    for (let k = 0; k < 15; k++) {
      const [name, seg] = dests[k % 3];
      spawn(sim, w, true, 15 + (k % 5) * 4, destOn(seg, false, 0.5), (_v, ok) => ok && arrived++);
      void name;
    }
    run(sim, 600, () => {
      for (const c of node.connectors) {
        for (const v of c.vehicles) {
          if (seen.has(v)) continue;
          seen.add(v);
          const turn = c.turn === 0 ? 'straight' : c.turn === 6 ? 'left' : c.turn === 2 ? 'right' : String(c.turn);
          used.push({ turn, lane: c.from.index });
        }
      }
    });
    expect(arrived).toBe(15);
    expect(used.length).toBe(15);
    for (const u of used) {
      if (u.turn === 'left') expect(u.lane).toBe(1);
      else expect(u.lane).toBe(0);
    }
  });
});
