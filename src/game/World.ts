import { ROUNDABOUT_COST, ROUNDABOUT_LARGE_COST, SIGNAL_COST, START_MONEY, TILE } from '../config';
import { City } from '../city/City';
import { Emitter } from '../core/events';
import { Rng } from '../core/rng';
import { CompileCache, compileNetwork } from '../roads/compile';
import type { ControlKind, Network, RoadNode } from '../roads/network';
import { planBulldoze, planRoad, type BulldozePlan, type PlanContext, type RoadPlan } from '../roads/placement';
import { ringSpec } from '../roads/roundabout';
import { ATTR_BUS_LANE, ATTR_TRUCK_BAN, EDGE_ONEWAY_REV, RoadLayer } from '../roads/roadLayer';
import { ROAD } from '../roads/roadTypes';
import { armsSignature, JunctionSettings, type JunctionSetting, type SignalPlanSetting, type SignKind } from '../roads/settings';
import { TrafficGenerator } from '../sim/generator';
import { TrafficSim } from '../sim/Traffic';
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
  /** Zones or buildings changed in these tile areas. */
  tiles: TileRect[];
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
  readonly traffic: TrafficSim;
  readonly generator: TrafficGenerator;
  readonly city: City;
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
    this.traffic = new TrafficSim(this.network, this.junctions, options.seed);
    this.generator = new TrafficGenerator(
      () => this.traffic,
      () => this.network,
      options.seed,
    );
    this.city = new City(this);
    this.city.events.on('tiles', (rects) => this.events.emit('tiles', rects));
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
    for (const id of plan.demolish) this.city?.removeBuilding(id);
    for (const e of plan.edges) {
      const idx = this.roads.edgeIndex(e.tile, e.dir);
      const attr = idx >= 0 ? this.roads.attr[idx] : 0;
      const speed = idx >= 0 && e.existing === e.type ? this.roads.speed[idx] : 0;
      this.roads.setEdge(e.tile, e.dir, e.type, e.flowOut, speed, attr);
    }
    for (const s of plan.spans) this.roads.addSpan({ kind: s.kind, a: s.a, b: s.b, dir: s.dir, len: s.len, type: s.type, flags: 0, speed: 0, attr: 0 });
    const touched: number[] = [];
    for (const e of plan.edges) touched.push(e.tile, this.roads.neighbor(e.tile, e.dir));
    for (const s of plan.spans) touched.push(s.a, s.b);
    this.city?.onRoadsBuilt(touched);
    this.spend(plan.cost);
    this.rebuildNetwork();
    return null;
  }

  planBulldoze(tiles: number[]): BulldozePlan {
    return planBulldoze(this.planContext, tiles);
  }

  applyBulldoze(plan: BulldozePlan): void {
    for (const id of plan.buildings) this.city.removeBuilding(id);
    for (const e of plan.edges) this.roads.removeEdge(e.tile, e.dir);
    for (const id of plan.spans) this.roads.removeSpan(id);
    this.earn(plan.refund);
    if (plan.edges.length || plan.spans.length) this.rebuildNetwork();
  }

  /** Changes the settings of a junction (signs, lights, lanes...) and recompiles. */
  updateJunction(tile: number, fn: (s: JunctionSetting) => void): void {
    fn(this.junctions.ensure(tile));
    this.cleanupSetting(tile);
    this.rebuildNetwork();
  }

  /** Nodes that make up the junction at a tile (one, or the ring nodes of a roundabout). */
  junctionNodes(tile: number): RoadNode[] {
    const rb = this.network.roundabouts.get(tile);
    if (rb) return rb.nodes;
    const n = this.network.nodeByTile.get(tile);
    return n ? [n] : [];
  }

  /** Number of roads meeting at a junction (ring nodes each carry one road). */
  junctionArmCount(tile: number): number {
    const nodes = this.junctionNodes(tile);
    if (nodes.length === 0) return 0;
    if (nodes[0].ringOf !== null) return nodes.length;
    return nodes[0].arms.length;
  }

  /** Tiles whose square overlaps a circle (world meters). */
  tilesInCircle(cx: number, cy: number, r: number): number[] {
    const out: number[] = [];
    const { w, h } = this.map;
    for (let y = Math.max(0, Math.floor((cy - r) / TILE)); y <= Math.min(h - 1, Math.floor((cy + r) / TILE)); y++) {
      for (let x = Math.max(0, Math.floor((cx - r) / TILE)); x <= Math.min(w - 1, Math.floor((cx + r) / TILE)); x++) {
        const nx = Math.max(x * TILE, Math.min(cx, (x + 1) * TILE));
        const ny = Math.max(y * TILE, Math.min(cy, (y + 1) * TILE));
        if (Math.hypot(nx - cx, ny - cy) < r) out.push(y * w + x);
      }
    }
    return out;
  }

  controlCost(control: ControlKind, large = false): number {
    if (control === 'signals') return SIGNAL_COST;
    if (control === 'roundabout') return large ? ROUNDABOUT_LARGE_COST : ROUNDABOUT_COST;
    return 0;
  }

  /** Switches a junction's traffic control. Returns an error message or null. */
  setJunctionControl(tile: number, control: ControlKind, large = false): string | null {
    const nodes = this.junctionNodes(tile);
    if (nodes.length === 0) return 'Click on a junction';
    if (nodes[0].outside) return 'Highway exits cannot be changed';
    const arms = this.junctionArmCount(tile);
    if ((control === 'signals' || control === 'allstop' || control === 'priority') && arms < 3) return 'This needs a junction of at least 3 roads';
    if (control === 'roundabout') {
      if (arms > 8) return 'Too many roads for a roundabout';
      const r = (large || arms > 4 ? 20 : 8.8) + 10;
      const cx = nodes[0].ringOf !== null ? this.network.roundabouts.get(tile)!.x : nodes[0].x;
      const cy = nodes[0].ringOf !== null ? this.network.roundabouts.get(tile)!.y : nodes[0].y;
      for (const n of this.network.nodes) {
        if (n.tile === tile || n.ringOf === tile) continue;
        if (Math.hypot(n.x - cx, n.y - cy) < r) return 'Too close to another junction';
      }
    }
    const cur = this.junctions.get(tile);
    const curKind = cur?.control ?? 'auto';
    if (curKind === control && (control !== 'roundabout' || !!cur?.roundaboutLarge === large)) return null;
    const cost = this.controlCost(control, large);
    if (!this.canAfford(cost)) return 'Not enough money';
    this.spend(cost);
    const s = this.junctions.ensure(tile);
    if (control === 'auto') delete s.control;
    else s.control = control;
    if (control === 'roundabout') {
      s.roundaboutLarge = large;
      delete s.lanes;
      delete s.lanesSig;
      delete s.signs;
      // The ring of a large roundabout covers the neighbouring tiles.
      const spec = ringSpec(arms, large);
      const n0 = nodes[0];
      const c = n0.ringOf !== null ? this.network.roundabouts.get(tile)! : n0;
      for (const t of this.tilesInCircle(c.x, c.y, spec.radius + spec.halfWidth + 1)) {
        const b = this.buildingAt[t];
        if (b >= 0) this.city.removeBuilding(b);
      }
    } else delete s.roundaboutLarge;
    if (control !== 'signals') delete s.signalPlan;
    if (control !== 'priority') delete s.signs;
    this.cleanupSetting(tile);
    this.rebuildNetwork();
    return null;
  }

  setSign(tile: number, armDir: number, kind: SignKind): void {
    const s = this.junctions.ensure(tile);
    s.control = 'priority';
    s.signs = { ...(s.signs ?? {}), [armDir]: kind };
    this.rebuildNetwork();
  }

  setSignalPlan(tile: number, plan: SignalPlanSetting): void {
    const s = this.junctions.ensure(tile);
    s.control = 'signals';
    s.signalPlan = plan;
    this.rebuildNetwork();
  }

  /** Sets (or clears with null) the custom targets of one incoming lane. */
  setLaneTargets(tile: number, inDir: number, laneIdx: number, targets: Array<[number, number]> | null): void {
    const node = this.network.nodeByTile.get(tile);
    if (!node) return;
    const s = this.junctions.ensure(tile);
    const sig = armsSignature(node.arms);
    const lanes = s.lanesSig === sig ? { ...(s.lanes ?? {}) } : {};
    const key = `${inDir}:${laneIdx}`;
    if (targets) lanes[key] = targets;
    else delete lanes[key];
    if (Object.keys(lanes).length) {
      s.lanes = lanes;
      s.lanesSig = sig;
    } else {
      delete s.lanes;
      delete s.lanesSig;
    }
    this.cleanupSetting(tile);
    this.rebuildNetwork();
  }

  resetJunctionLanes(tile: number): void {
    const s = this.junctions.get(tile);
    if (!s) return;
    delete s.lanes;
    delete s.lanesSig;
    this.cleanupSetting(tile);
    this.rebuildNetwork();
  }

  private cleanupSetting(tile: number): void {
    const s = this.junctions.get(tile);
    if (s && Object.values(s).every((v) => v === undefined)) this.junctions.delete(tile);
  }

  /** Changes speed limit, truck ban or bus lanes on every tile of a road segment. */
  setSegmentAttrs(key: string, attrs: { speedKmh?: number; truckBan?: boolean; busLane?: boolean }): void {
    const seg = this.network.segByKey.get(key);
    if (!seg) return;
    const edit = (speed: number, attr: number): [number, number] => {
      if (attrs.speedKmh !== undefined) speed = attrs.speedKmh;
      if (attrs.truckBan !== undefined) attr = attrs.truckBan ? attr | ATTR_TRUCK_BAN : attr & ~ATTR_TRUCK_BAN;
      if (attrs.busLane !== undefined) attr = attrs.busLane ? attr | ATTR_BUS_LANE : attr & ~ATTR_BUS_LANE;
      return [speed, attr];
    };
    for (const e of seg.edges) [this.roads.speed[e], this.roads.attr[e]] = edit(this.roads.speed[e], this.roads.attr[e]);
    for (const id of seg.spanIds) {
      const sp = this.roads.spans.get(id);
      if (sp) [sp.speed, sp.attr] = edit(sp.speed, sp.attr);
    }
    this.roads.version++;
    this.rebuildNetwork();
  }

  /** Flips the driving direction of a one-way road segment. */
  reverseOneWay(key: string): void {
    const seg = this.network.segByKey.get(key);
    if (!seg || seg.type.lanesB !== 0) return;
    for (const e of seg.edges) this.roads.flags[e] ^= EDGE_ONEWAY_REV;
    for (const id of seg.spanIds) {
      const sp = this.roads.spans.get(id);
      if (sp) sp.flags ^= EDGE_ONEWAY_REV;
    }
    this.roads.version++;
    this.rebuildNetwork();
  }

  private compile(): Network {
    return compileNetwork({ layer: this.roads, settings: this.junctions, outside: this.map.outside, cache: this.compileCache });
  }

  /** Recompiles the road network and reports which tile areas changed visually. */
  rebuildNetwork(): void {
    const oldSeg = this.segSigs;
    const oldNode = this.nodeSigs;
    this.network = this.compile();
    this.traffic?.setNetwork(this.network, this.junctions);
    this.city?.onNetworkChanged();
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
      const lanes = n.connectors.map((c) => c.key).join(',');
      const js = this.junctions.get(n.ringOf ?? n.tile);
      const sig = `${n.key}|${arms}|${n.control}|${lanes}|${js ? JSON.stringify(js) : ''}`;
      const x = n.tile % w;
      const y = (n.tile - x) / w;
      const r = n.ringOf !== null ? 3 : 2;
      this.nodeSigs.set(sig, { x0: x - r, y0: y - r, x1: x + r, y1: y + r });
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
    this.generator.step(dt);
    this.traffic.step(dt);
    this.city.step(dt);
  }
}
