import { START_MONEY, TILE } from '../config';
import { Emitter } from '../core/events';
import { Rng } from '../core/rng';
import { CompileCache, compileNetwork } from '../roads/compile';
import type { Network } from '../roads/network';
import { planBulldoze, planRoad, type BulldozePlan, type PlanContext, type RoadPlan } from '../roads/placement';
import { RoadLayer } from '../roads/roadLayer';
import { ROAD } from '../roads/roadTypes';
import { JunctionSettings } from '../roads/settings';
import { DX, DY } from '../world/grid';
import { generateMap } from '../world/mapgen';
import type { WorldMap } from '../world/WorldMap';
import { Clock } from './clock';

export interface NewGameOptions {
  seed: number;
  size: number;
  cityName: string;
  sandbox: boolean;
}

export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type WorldEvents = {
  /** The road network was recompiled; rects are tile areas whose drawing changed. */
  network: TileRect[];
  money: number;
};

/**
 * All simulation state of one game, independent of DOM and rendering so it can run headless in tests.
 */
export class World {
  readonly options: NewGameOptions;
  readonly map: WorldMap;
  readonly clock = new Clock();
  readonly rng: Rng;
  readonly events = new Emitter<WorldEvents>();
  readonly roads: RoadLayer;
  readonly junctions = new JunctionSettings();
  /** Building id per tile (-1 = none). */
  readonly buildingAt: Int32Array;
  network: Network;
  money: number;
  private compileCache = new CompileCache();
  private segSigs = new Map<string, TileRect>();
  private nodeSigs = new Map<string, TileRect>();

  constructor(options: NewGameOptions, map?: WorldMap) {
    this.options = options;
    this.map = map ?? generateMap({ seed: options.seed, size: options.size });
    this.rng = new Rng(options.seed ^ 0x5bd1e995);
    this.money = START_MONEY;
    this.roads = new RoadLayer(this.map.w, this.map.h);
    this.buildingAt = new Int32Array(this.map.tileCount).fill(-1);
    this.buildOutsideStubs();
    this.network = this.compile();
    this.rememberSignatures();
  }

  get sandbox(): boolean {
    return this.options.sandbox;
  }

  get planContext(): PlanContext {
    return { w: this.map.w, h: this.map.h, terrain: this.map.terrain, buildingAt: this.buildingAt, roads: this.roads };
  }

  canAfford(cost: number): boolean {
    return this.sandbox || this.money >= cost;
  }

  spend(cost: number): void {
    if (this.sandbox) return;
    this.money -= cost;
    this.events.emit('money', this.money);
  }

  earn(amount: number): void {
    if (this.sandbox) return;
    this.money += amount;
    this.events.emit('money', this.money);
  }

  planRoad(path: number[], typeId: number, overpass: boolean): RoadPlan {
    return planRoad(this.planContext, path, typeId, overpass);
  }

  /** Builds a validated road plan. Returns an error message or null on success. */
  applyRoadPlan(plan: RoadPlan): string | null {
    if (!plan.valid) return plan.reason;
    if (!this.canAfford(plan.cost)) return 'Not enough money';
    for (const e of plan.edges) {
      const idx = this.roads.edgeIndex(e.tile, e.dir);
      const attr = idx >= 0 ? this.roads.attr[idx] : 0;
      const speed = idx >= 0 && e.existing === e.type ? this.roads.speed[idx] : 0;
      this.roads.setEdge(e.tile, e.dir, e.type, e.flowOut, speed, attr);
    }
    for (const s of plan.spans) this.roads.addSpan({ kind: s.kind, a: s.a, b: s.b, dir: s.dir, len: s.len, type: s.type, flags: 0, speed: 0, attr: 0 });
    this.spend(plan.cost);
    this.rebuildNetwork();
    return null;
  }

  planBulldoze(tiles: number[]): BulldozePlan {
    return planBulldoze(this.planContext, tiles);
  }

  applyBulldoze(plan: BulldozePlan): void {
    for (const e of plan.edges) this.roads.removeEdge(e.tile, e.dir);
    for (const id of plan.spans) this.roads.removeSpan(id);
    this.earn(plan.refund);
    if (plan.edges.length || plan.spans.length) this.rebuildNetwork();
  }

  private compile(): Network {
    return compileNetwork({ layer: this.roads, settings: this.junctions, outside: this.map.outside, cache: this.compileCache });
  }

  /** Recompiles the road network and reports which tile areas changed visually. */
  rebuildNetwork(): void {
    const oldSeg = this.segSigs;
    const oldNode = this.nodeSigs;
    this.network = this.compile();
    this.rememberSignatures();
    const dirty: TileRect[] = [];
    for (const [sig, r] of this.segSigs) if (!oldSeg.has(sig)) dirty.push(r);
    for (const [sig, r] of oldSeg) if (!this.segSigs.has(sig)) dirty.push(r);
    for (const [sig, r] of this.nodeSigs) if (!oldNode.has(sig)) dirty.push(r);
    for (const [sig, r] of oldNode) if (!this.nodeSigs.has(sig)) dirty.push(r);
    this.events.emit('network', dirty);
  }

  private rememberSignatures(): void {
    this.segSigs = new Map();
    this.nodeSigs = new Map();
    for (const s of this.network.segments) {
      const sig = `${s.key}|${s.type.id}|${s.tiles.join(',')}|${s.trimA.toFixed(2)}|${s.trimB.toFixed(2)}|${s.speedLimit.toFixed(2)}|${s.truckBan}|${s.busLane}|${s.forward.length}/${s.backward.length}`;
      this.segSigs.set(sig, {
        x0: Math.floor(s.bbox.x0 / TILE) - 1,
        y0: Math.floor(s.bbox.y0 / TILE) - 1,
        x1: Math.floor(s.bbox.x1 / TILE) + 1,
        y1: Math.floor(s.bbox.y1 / TILE) + 1,
      });
    }
    const w = this.map.w;
    for (const n of this.network.nodes) {
      const arms = n.arms.map((a) => `${a.dir}:${a.segment.type.id}:${a.trim.toFixed(2)}:${a.nIn}/${a.nOut}`).join(',');
      const lanes = n.connectors.length;
      const sig = `${n.tile}|${arms}|${n.control}|${lanes}`;
      const x = n.tile % w;
      const y = (n.tile - x) / w;
      this.nodeSigs.set(sig, { x0: x - 2, y0: y - 2, x1: x + 2, y1: y + 2 });
    }
  }

  /** Pre-built highway stubs at the outside connections. */
  private buildOutsideStubs(): void {
    const w = this.map.w;
    for (const oc of this.map.outside) {
      for (let k = 0; k < oc.length; k++) {
        const t = (oc.y + DY[oc.dir] * k) * w + oc.x + DX[oc.dir] * k;
        this.roads.setEdge(t, oc.dir, ROAD.highway, true);
        this.roads.protectedEdges.add(this.roads.edgeIndex(t, oc.dir));
      }
    }
  }

  /** Advances the simulation by dt simulated seconds. */
  step(dt: number): void {
    this.clock.advance(dt);
  }
}
