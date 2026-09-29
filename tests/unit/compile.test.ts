import { describe, expect, it } from 'vitest';
import { ROAD } from '../../src/roads/roadTypes';
import { JunctionSettings } from '../../src/roads/settings';
import { compile, layer, line, paint, W } from './helpers';

const tile = (x: number, y: number) => y * W + x;

describe('network compile', () => {
  it('straight street gives one segment between two dead ends', () => {
    const l = layer();
    paint(l, line([2, 5], [10, 5]), ROAD.street);
    const net = compile(l);
    expect(net.segments.length).toBe(1);
    expect(net.nodes.length).toBe(2);
    const seg = net.segments[0];
    expect(seg.forward.length).toBe(1);
    expect(seg.backward.length).toBe(1);
    expect(seg.center.length).toBeCloseTo(8 * 24, 5);
    // Dead ends have a U-turn connector each.
    for (const n of net.nodes) {
      expect(n.isDeadEnd).toBe(true);
      expect(n.connectors.length).toBe(1);
      expect(n.connectors[0].turn).toBe(4);
    }
    // Lane 0 forward is on the right side (south when heading east).
    expect(seg.forward[0].path.y0).toBeGreaterThan(seg.center.ys[0]);
  });

  it('corner without junction stays one smooth segment', () => {
    const l = layer();
    paint(l, [...line([2, 5], [8, 5]), ...line([8, 6], [8, 12])], ROAD.street);
    const net = compile(l);
    expect(net.segments.length).toBe(1);
    expect(net.nodes.length).toBe(2);
    const seg = net.segments[0];
    // Rounded corner is shorter than the Manhattan path.
    expect(seg.center.length).toBeLessThan(13 * 24);
    expect(seg.center.length).toBeGreaterThan(12 * 24);
  });

  it('crossroads has four arms with right, straight and left connections', () => {
    const l = layer();
    paint(l, line([2, 8], [14, 8]), ROAD.street);
    paint(l, line([8, 2], [8, 14]), ROAD.street);
    const net = compile(l);
    const center = net.nodeByTile.get(tile(8, 8))!;
    expect(center.arms.length).toBe(4);
    expect(net.segments.length).toBe(4);
    expect(center.connectors.length).toBe(12);
    const turns = center.connectors.map((c) => c.turn).sort();
    expect(turns).toEqual([0, 0, 0, 0, 2, 2, 2, 2, 6, 6, 6, 6]);
    // Crossing straight movements conflict with each other.
    const ew = center.connectors.find((c) => c.inArm.dir === 4 && c.turn === 0)!;
    const ns = center.connectors.find((c) => c.inArm.dir === 6 && c.turn === 0)!;
    expect(ew.conflicts.some((x) => x.other === ns && x.kind === 'cross')).toBe(true);
    // A right turn does not cross the opposite right turn.
    const r1 = center.connectors.find((c) => c.inArm.dir === 4 && c.turn === 2)!;
    const r2 = center.connectors.find((c) => c.inArm.dir === 0 && c.turn === 2)!;
    expect(r1.conflicts.some((x) => x.other === r2)).toBe(false);
    expect(center.polygon.length).toBeGreaterThan(16);
  });

  it('two-lane approach gets right+straight and straight+left by default', () => {
    const l = layer();
    paint(l, line([2, 8], [14, 8]), ROAD.avenue);
    paint(l, line([8, 2], [8, 14]), ROAD.avenue);
    const net = compile(l);
    const center = net.nodeByTile.get(tile(8, 8))!;
    const arm = center.arms.find((a) => a.dir === 4)!; // arriving from the west, heading east
    const lane0 = arm.ins[0].outs.map((c) => c.turn).sort();
    const lane1 = arm.ins[1].outs.map((c) => c.turn).sort();
    expect(lane0).toEqual([0, 2]); // right + straight (2 lanes map 1:1 onto 2 lanes)
    expect(lane1).toContain(6);
    expect(lane1).toContain(0);
    expect(lane0).not.toContain(6);
    expect(lane1).not.toContain(2);
  });

  it('road type change creates a transition node with merge conflicts', () => {
    const l = layer();
    paint(l, line([2, 5], [8, 5]), ROAD.street);
    paint(l, line([8, 5], [14, 5]), ROAD.avenue);
    const net = compile(l);
    const mid = net.nodeByTile.get(tile(8, 5))!;
    expect(mid.arms.length).toBe(2);
    // Street -> avenue fans out into both lanes, avenue -> street merges.
    const streetArm = mid.arms.find((a) => a.dir === 4)!;
    expect(streetArm.ins[0].outs.length).toBe(2);
    const aveArm = mid.arms.find((a) => a.dir === 0)!;
    const merges = aveArm.ins.flatMap((ln) => ln.outs).flatMap((c) => c.conflicts).filter((x) => x.kind === 'merge');
    expect(merges.length).toBeGreaterThan(0);
  });

  it('keys are stable across recompiles and custom lane settings apply', () => {
    const l = layer();
    paint(l, line([2, 8], [14, 8]), ROAD.street);
    paint(l, line([8, 2], [8, 14]), ROAD.street);
    const a = compile(l);
    const b = compile(l);
    expect(a.lanes.map((x) => x.key)).toEqual(b.lanes.map((x) => x.key));
    expect(a.connectors.map((x) => x.key)).toEqual(b.connectors.map((x) => x.key));

    const settings = new JunctionSettings();
    // Lane arriving from the west (arm dir 4, lane 0): only allow the left turn (north, dir 6).
    settings.ensure(tile(8, 8)).lanes = { '4:0': [[6, 0]] };
    const c = compile(l, settings);
    const center = c.nodeByTile.get(tile(8, 8))!;
    const outs = center.arms.find((x) => x.dir === 4)!.ins[0].outs;
    expect(outs.length).toBe(1);
    expect(outs[0].turn).toBe(6);
  });

  it('bridge span becomes part of a straight segment', () => {
    const l = layer();
    paint(l, line([2, 5], [4, 5]), ROAD.street);
    l.addSpan({ kind: 'bridge', a: tile(4, 5), b: tile(9, 5), dir: 0, len: 5, type: ROAD.street, flags: 0, speed: 0, attr: 0 });
    paint(l, line([9, 5], [12, 5]), ROAD.street);
    const net = compile(l);
    expect(net.segments.length).toBe(1);
    const seg = net.segments[0];
    expect(seg.spanRanges.length).toBe(1);
    expect(seg.spanRanges[0].s1 - seg.spanRanges[0].s0).toBeCloseTo(5 * 24, 3);
  });

  it('one-way street has lanes only in the drag direction', () => {
    const l = layer();
    paint(l, line([10, 5], [2, 5]), ROAD.oneway); // dragged westwards
    const net = compile(l);
    const seg = net.segments[0];
    // Canonical segment starts at the lower tile (west end), so traffic flows backward.
    expect(seg.forward.length).toBe(0);
    expect(seg.backward.length).toBe(2);
    expect(seg.backward[0].path.x0).toBeGreaterThan(seg.backward[0].path.x1);
  });

  it('closed ring without junctions still compiles', () => {
    const l = layer();
    paint(l, [...line([4, 4], [8, 4]), ...line([8, 5], [8, 8]), ...line([7, 8], [4, 8]), ...line([4, 7], [4, 4])], ROAD.street);
    const net = compile(l);
    expect(net.segments.length).toBe(1);
    expect(net.nodes.length).toBe(1);
  });
});
