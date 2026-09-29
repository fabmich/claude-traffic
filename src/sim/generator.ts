import { Rng } from '../core/rng';
import type { Network } from '../roads/network';
import { VKind } from './params';
import type { SpawnOrigin, TrafficSim } from './Traffic';
import type { Destination } from './vehicle';

/**
 * Test traffic: random trips between outside connections and random road positions.
 * Useful for trying junction designs before the city has residents.
 */
export class TrafficGenerator {
  enabled = false;
  /** Vehicles per minute of simulated time. */
  rate = 30;
  private acc = 0;
  private rng: Rng;

  constructor(
    private traffic: () => TrafficSim,
    private network: () => Network,
    seed: number,
  ) {
    this.rng = new Rng(seed ^ 0x1234abcd);
  }

  step(dt: number): void {
    if (!this.enabled) return;
    this.acc += (dt * this.rate) / 60;
    let guard = 0;
    while (this.acc >= 1 && guard++ < 20) {
      this.acc -= 1;
      this.spawnOne();
    }
  }

  private randomPoint(net: Network, asDest: boolean): { origin?: SpawnOrigin; dest?: Destination } | null {
    const rng = this.rng;
    // Only use highway exits whose stub is connected to the rest of the network.
    const outside = net.nodes.filter((n) => {
      if (!n.outside || n.arms.length === 0) return false;
      const seg = n.arms[0].segment;
      const other = seg.a === n ? seg.b : seg.a;
      return other.arms.length >= 2;
    });
    if (outside.length && rng.chance(0.35)) {
      const n = rng.pick(outside);
      const arm = n.arms[0];
      if (asDest) {
        const lane = arm.ins[0];
        if (!lane) return null;
        return { dest: { seg: lane.segment, forward: lane.forward, s: lane.length, tile: n.tile, outside: true } };
      }
      const lane = arm.outs[0];
      if (!lane) return null;
      return { origin: { lane, s: 1 } };
    }
    const segs = net.segments.filter((s) => !s.type.highway && !s.type.hidden && s.length > 30);
    if (segs.length === 0) return null;
    const seg = rng.pick(segs);
    const forward = seg.forward.length > 0 && (seg.backward.length === 0 || rng.chance(0.5));
    const lanes = forward ? seg.forward : seg.backward;
    if (lanes.length === 0) return null;
    const lane = lanes[0];
    const s = 8 + rng.next() * Math.max(1, lane.length - 16);
    if (asDest) return { dest: { seg, forward, s, tile: seg.tiles[0], outside: false } };
    return { origin: { lane, s } };
  }

  spawnOne(): void {
    const net = this.network();
    const o = this.randomPoint(net, false);
    const d = this.randomPoint(net, true);
    if (!o?.origin || !d?.dest) return;
    if (o.origin.lane.segment === d.dest.seg) return;
    this.traffic().request({
      kind: this.rng.chance(0.12) ? VKind.Truck : VKind.Car,
      origins: [o.origin],
      dests: [d.dest],
    });
  }
}
