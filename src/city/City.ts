import { DAY_SECONDS, TILE } from '../config';
import { Emitter } from '../core/events';
import { MinHeap } from '../core/heap';
import { Rng } from '../core/rng';
import type { TileRect, World } from '../game/World';
import type { RoadNode } from '../roads/network';
import { ROAD_TYPES } from '../roads/roadTypes';
import { VKind } from '../sim/params';
import type { SpawnOrigin } from '../sim/Traffic';
import type { Destination } from '../sim/vehicle';
import { DX, DY } from '../world/grid';
import { Terrain } from '../world/terrain';
import { Building, BState, hasAccessRoad, Problem, resolveAccess, type Access } from './buildings';
import { templatesFor, type BuildingTemplate } from './templates';
import { terrainAllows, Zone, ZONE_DEPTH } from './zones';

const HOUR = DAY_SECONDS / 24;

/** Tunables of the city simulation. */
export const CITY = {
  carOwnership: 0.85,
  workerShare: 0.75,
  /** Share of car trips simulated with real vehicles (the rest are instant "virtual" trips). */
  realTripShare: 0.75,
  walkDistance: 650,
  truckLoad: 10,
  milestones: [
    { pop: 300, name: 'Village', reward: 10_000 },
    { pop: 1000, name: 'Town', reward: 20_000 },
    { pop: 2500, name: 'Small city', reward: 40_000 },
    { pop: 5000, name: 'City', reward: 60_000 },
    { pop: 10000, name: 'Big city', reward: 100_000 },
    { pop: 20000, name: 'Metropolis', reward: 150_000 },
  ],
};

export const CState = { Home: 0, Work: 1, Shop: 2, Travel: 3 } as const;
export const TripKind = { Work: 0, Home: 1, Shop: 2 } as const;

export class Citizen {
  state: number = CState.Home;
  job: Building | null = null;
  place: Building | null = null;
  nextTime = 0;
  queued = false;
  lastWorkDay = 0;
  shopNeed: number;
  startHour: number;
  shift: number;
  tripStart = 0;
  tripKind = 0;
  tripTarget: Building | null = null;
  tripFrom: Building | null = null;
  virtual = false;
  removed = false;
  /** EMA of commute duration in simulated seconds. */
  commute = 0;
  lastJobSearch = -1e9;
  /** Simulation time when the citizen moved in. */
  movedIn = 0;
  /** Travel mode of the current trip: 'car' | 'walk' | 'bus'. */
  mode: 'car' | 'walk' | 'bus' = 'car';

  constructor(
    readonly id: number,
    public home: Building,
    readonly car: boolean,
    readonly worker: boolean,
    rng: Rng,
  ) {
    this.shopNeed = rng.next() * 0.8;
    this.startHour = 6 + rng.next() * 3.5;
    this.shift = 7 + rng.next() * 2;
  }
}

export interface Budget {
  residential: number;
  commercial: number;
  industrial: number;
  farming: number;
  exports: number;
  fares: number;
  roads: number;
  junctions: number;
  transit: number;
  imports: number;
}

const emptyBudget = (): Budget => ({ residential: 0, commercial: 0, industrial: 0, farming: 0, exports: 0, fares: 0, roads: 0, junctions: 0, transit: 0, imports: 0 });

export type CityEvents = {
  tiles: TileRect[];
  milestone: { index: number; name: string; reward: number; pop: number };
  notice: string;
};

/** Zoning, buildings, citizens, trips, freight and the city economy. */
export class City {
  readonly events = new Emitter<CityEvents>();
  readonly zones: Uint8Array;
  readonly buildings: Array<Building | null> = [];
  readonly citizens: Array<Citizen | null> = [];
  private freeB: number[] = [];
  private freeC: number[] = [];
  private queue = new MinHeap(4096);
  private zoneTiles: number[][] = [[], [], [], [], []];
  private rng: Rng;
  private comp = new Int32Array(0);
  /** Tiles where zoning is allowed (near an access road, not on or under a road). */
  zoneable = new Uint8Array(0);
  private outsideComps = new Set<number>();
  private outsideNodes: RoadNode[] = [];
  private timers = { grow: 0, demand: 0, freight: 0, hour: 0, construct: 0 };
  private immigrationAcc = 0;
  private lastDay = 1;
  private noticeCooldown = new Map<string, number>();

  population = 0;
  /** Highest population reached (milestone unlocks never lock again). */
  peakPopulation = 0;
  workers = 0;
  employed = 0;
  jobs = 0;
  demand = { r: 0.6, c: 0.3, i: 0.3, f: 0.2 };
  /** Desire of people to move here (0..1), independent of free homes. */
  attractiveness = 0.6;
  taxes = { r: 9, c: 9, i: 9, f: 9 };
  happiness = 60;
  /** Average commute in game minutes. */
  commuteMinutes = 0;
  budgetToday: Budget = emptyBudget();
  budgetYesterday: Budget = emptyBudget();
  roadUpkeepPerDay = 0;
  junctionUpkeepPerDay = 0;
  transitUpkeepPerDay = 0;
  milestone = 0;
  tripsStarted = 0;
  modeCounts = { car: 0, walk: 0, bus: 0 };
  /** Hook for public transport (installed by the transit module). */
  transitPlanner: ((c: Citizen, from: Building, to: Building, dist: number) => boolean) | null = null;
  vacancies: Building[] = [];
  shops: Building[] = [];

  constructor(private world: World) {
    this.zones = new Uint8Array(world.map.tileCount);
    this.rng = new Rng(world.options.seed ^ 0x51f1c7);
    this.onNetworkChanged();
  }

  private get now(): number {
    return this.world.traffic.time;
  }

  // ------------------------------------------------------------------ zoning

  /** Recomputes where zoning is allowed and removes zones that lost their road. */
  private updateZoneable(): void {
    const { w, h } = this.world.map;
    const roads = this.world.roads;
    const n = w * h;
    const near = new Uint8Array(n);
    for (let t = 0; t < n; t++) {
      if (!hasAccessRoad(roads, t)) continue;
      const x = t % w;
      const y = (t - x) / w;
      for (let ny = Math.max(0, y - ZONE_DEPTH); ny <= Math.min(h - 1, y + ZONE_DEPTH); ny++) {
        for (let nx = Math.max(0, x - ZONE_DEPTH); nx <= Math.min(w - 1, x + ZONE_DEPTH); nx++) near[ny * w + nx] = 1;
      }
    }
    const spanEnds = new Set<number>();
    for (const sp of roads.spans.values()) spanEnds.add(sp.a).add(sp.b);
    for (let t = 0; t < n; t++) {
      if (near[t] && (roads.hasGroundRoad(t) || spanEnds.has(t) || roads.bridgeCover[t] >= 0 || roads.diagonalCorner(t))) near[t] = 0;
    }
    // Large roundabouts reach into the neighbouring tiles.
    for (const rb of this.world.network.roundabouts.values()) for (const t of this.world.tilesInCircle(rb.x, rb.y, rb.radius + rb.halfWidth + 1)) near[t] = 0;
    this.zoneable = near;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let t = 0; t < n; t++) {
      if (!this.zones[t] || near[t] || this.world.buildingAt[t] >= 0) continue;
      this.zones[t] = 0;
      const x = t % w;
      const y = (t - x) / w;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (x1 >= 0) this.events.emit('tiles', [{ x0, y0, x1, y1 }]);
  }

  canZone(t: number, zone: number): boolean {
    const world = this.world;
    if (zone === Zone.None) return this.zones[t] !== 0;
    if (!terrainAllows(zone, world.map.terrain[t])) return false;
    const b = world.buildingAt[t];
    if (b >= 0) return this.buildings[b]?.zone === zone;
    return this.zoneable[t] === 1;
  }

  /** Paints a zone on tiles. Returns how many tiles changed. */
  paintZone(tiles: number[], zone: number): number {
    let n = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const w = this.world.map.w;
    for (const t of tiles) {
      if (this.zones[t] === zone || !this.canZone(t, zone)) continue;
      this.zones[t] = zone;
      if (zone) this.zoneTiles[zone].push(t);
      n++;
      const x = t % w;
      const y = (t - x) / w;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (n) this.events.emit('tiles', [{ x0, y0, x1, y1 }]);
    return n;
  }

  /** Roads replace zoning on their tiles. */
  onRoadsBuilt(tiles: number[]): void {
    for (const t of tiles) this.zones[t] = 0;
  }

  // ------------------------------------------------------------------ network

  onNetworkChanged(): void {
    const net = this.world.network;
    const parent = new Int32Array(net.nodes.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (a: number): number => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]];
        a = parent[a];
      }
      return a;
    };
    for (const s of net.segments) {
      const a = find(s.a.id);
      const b = find(s.b.id);
      if (a !== b) parent[a] = b;
    }
    this.comp = new Int32Array(net.segments.length);
    for (const s of net.segments) this.comp[s.id] = find(s.a.id);
    this.outsideComps.clear();
    this.outsideNodes = net.nodes.filter((n) => n.outside && n.arms.length > 0);
    for (const n of this.outsideNodes) {
      const other = n.arms[0].segment;
      const far = other.a === n ? other.b : other.a;
      if (far.arms.length >= 2) this.outsideComps.add(this.comp[other.id]);
    }
    for (const b of this.buildings) if (b) b.accessDirty = true;
    this.updateZoneable();
    this.recomputeUpkeep();
  }

  private recomputeUpkeep(): void {
    const roads = this.world.roads;
    let up = 0;
    for (let e = 0; e < roads.type.length; e++) {
      const t = roads.type[e];
      if (t) up += ROAD_TYPES[t].upkeep * ((e & 3) % 2 === 1 ? Math.SQRT2 : 1);
    }
    for (const s of roads.spans.values()) up += ROAD_TYPES[s.type].upkeep * s.len * (s.kind === 'bridge' ? 3 : 4);
    this.roadUpkeepPerDay = up;
    let j = 0;
    for (const [, st] of this.world.junctions.entries()) {
      if (st.control === 'signals') j += 20;
      else if (st.control === 'roundabout') j += st.roundaboutLarge ? 18 : 8;
    }
    this.junctionUpkeepPerDay = j;
  }

  accessOf(b: Building): Access | null {
    if (b.accessDirty) {
      b.access = resolveAccess(this.world.network, this.world.roads, b.roadTile, this.world.map.w);
      b.component = b.access ? this.comp[b.access.seg.id] ?? -1 : -1;
      b.accessDirty = false;
    }
    return b.access;
  }

  connectedToOutside(b: Building): boolean {
    this.accessOf(b);
    return b.component >= 0 && this.outsideComps.has(b.component);
  }

  /** Outside connection lanes in the same road component as a building. */
  private outsideFor(b: Building): { origins: SpawnOrigin[]; dests: Destination[] } | null {
    this.accessOf(b);
    let best: RoadNode | null = null;
    let bd = Infinity;
    for (const n of this.outsideNodes) {
      const seg = n.arms[0].segment;
      if (this.comp[seg.id] !== b.component) continue;
      const d = Math.hypot(n.x - b.cx, n.y - b.cy) * (0.8 + this.rng.next() * 0.4);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    if (!best) return null;
    const arm = best.arms[0];
    const origins = arm.outs.length ? [{ lane: arm.outs[0], s: 1 }] : [];
    const lane = arm.ins[0];
    const dests: Destination[] = lane ? [{ seg: lane.segment, forward: lane.forward, s: lane.length, tile: best.tile, outside: true }] : [];
    if (!origins.length || !dests.length) return null;
    return { origins, dests };
  }

  // ------------------------------------------------------------------ buildings

  private newBuildingId(): number {
    return this.freeB.length ? this.freeB.pop()! : this.buildings.length;
  }

  private tileFree(t: number, zone: number): boolean {
    const world = this.world;
    return this.zones[t] === zone && world.buildingAt[t] < 0 && this.zoneable[t] === 1 && terrainAllows(zone, world.map.terrain[t]);
  }

  /** Tries to grow one building of `zone` at a random zoned tile with road frontage. */
  private tryGrow(zone: number, demand: number): boolean {
    const list = this.zoneTiles[zone];
    const map = this.world.map;
    const w = map.w;
    for (let attempt = 0; attempt < 6 && list.length; attempt++) {
      const i = this.rng.int(list.length);
      const t = list[i];
      if (this.zones[t] !== zone || this.world.buildingAt[t] >= 0) {
        list[i] = list[list.length - 1];
        list.pop();
        continue;
      }
      const x = t % w;
      const y = (t - x) / w;
      // Road side (orthogonal neighbour with an access road).
      const sides: number[] = [];
      for (const d of [0, 2, 4, 6]) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= map.h) continue;
        if (hasAccessRoad(this.world.roads, ny * w + nx)) sides.push(d);
      }
      if (sides.length === 0) continue;
      const templates = templatesFor(zone).filter((tp) => tp.minDemand <= demand);
      const order = this.weightedOrder(templates);
      for (const tpl of order) {
        for (const rd of sides) {
          for (const side of this.rng.chance(0.5) ? [2, 6] : [6, 2]) {
            const b = this.fit(tpl, x, y, rd, (rd + side) & 7);
            if (b) return true;
          }
        }
      }
    }
    return false;
  }

  private weightedOrder(tpls: BuildingTemplate[]): BuildingTemplate[] {
    const arr = tpls.map((t) => ({ t, k: -Math.log(this.rng.next() + 1e-9) / t.weight }));
    arr.sort((a, b) => a.k - b.k);
    return arr.map((a) => a.t);
  }

  private fit(tpl: BuildingTemplate, x: number, y: number, roadDir: number, widthDir: number): Building | null {
    const map = this.world.map;
    const depthDir = (roadDir + 4) & 7;
    const tiles: number[] = [];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < tpl.w; i++) {
      for (let j = 0; j < tpl.d; j++) {
        const tx = x + DX[widthDir] * i + DX[depthDir] * j;
        const ty = y + DY[widthDir] * i + DY[depthDir] * j;
        if (!map.inBounds(tx, ty)) return null;
        const t = ty * map.w + tx;
        if (!this.tileFree(t, tpl.zone)) return null;
        tiles.push(t);
        x0 = Math.min(x0, tx);
        y0 = Math.min(y0, ty);
        x1 = Math.max(x1, tx);
        y1 = Math.max(y1, ty);
      }
    }
    const roadTile = (y + DY[roadDir]) * map.w + x + DX[roadDir];
    const id = this.newBuildingId();
    const b = new Building(id, tpl, tiles, x0, y0, x1, y1, roadDir, roadTile, this.rng.int(1 << 30));
    let rich = 0;
    for (const t of tiles) {
      this.world.buildingAt[t] = id;
      if (map.terrain[t] === Terrain.Rich) rich++;
    }
    b.rich = rich / tiles.length;
    this.buildings[id] = b;
    this.events.emit('tiles', [{ x0, y0, x1, y1 }]);
    return b;
  }

  /** Removes a building: residents move out, workers lose their jobs. */
  removeBuilding(id: number): void {
    const b = this.buildings[id];
    if (!b) return;
    for (const cid of [...b.people]) {
      const c = this.citizens[cid];
      if (!c) continue;
      if (b.zone === Zone.Residential) this.removeCitizen(c);
      else if (c.job === b) c.job = null;
    }
    for (const c of this.citizens) {
      if (!c) continue;
      if (c.job === b) c.job = null;
      if (c.place === b) c.place = null;
      if (c.tripTarget === b) c.tripTarget = null;
    }
    for (const t of b.tiles) {
      if (this.world.buildingAt[t] === id) this.world.buildingAt[t] = -1;
      if (this.zones[t]) this.zoneTiles[this.zones[t]].push(t);
    }
    this.buildings[id] = null;
    this.freeB.push(id);
    this.events.emit('tiles', [{ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }]);
  }

  // ------------------------------------------------------------------ citizens

  private addCitizen(home: Building): Citizen {
    const id = this.freeC.length ? this.freeC.pop()! : this.citizens.length;
    const c = new Citizen(id, home, this.rng.chance(CITY.carOwnership), this.rng.chance(CITY.workerShare), this.rng);
    this.citizens[id] = c;
    home.people.push(id);
    c.place = home;
    c.movedIn = this.now;
    this.population++;
    this.schedule(c, this.now + this.rng.next() * HOUR);
    return c;
  }

  private removeCitizen(c: Citizen): void {
    if (c.removed) return;
    c.removed = true;
    const i = c.home.people.indexOf(c.id);
    if (i >= 0) c.home.people.splice(i, 1);
    if (c.job) {
      const j = c.job.people.indexOf(c.id);
      if (j >= 0) c.job.people.splice(j, 1);
      c.job = null;
    }
    this.citizens[c.id] = null;
    this.freeC.push(c.id);
    this.population--;
  }

  private schedule(c: Citizen, time: number): void {
    c.nextTime = time;
    if (!c.queued) {
      c.queued = true;
      this.queue.push(c.id, time);
    }
  }

  private processQueue(): void {
    let guard = 0;
    while (this.queue.size > 0 && this.queue.peekKey() <= this.now && guard++ < 3000) {
      const id = this.queue.pop();
      const c = this.citizens[id];
      if (!c || !c.queued) continue;
      c.queued = false;
      if (c.nextTime > this.now + 1e-6) {
        this.schedule(c, c.nextTime);
        continue;
      }
      this.wake(c);
    }
  }

  private wake(c: Citizen): void {
    switch (c.state) {
      case CState.Home:
        this.decideAtHome(c);
        break;
      case CState.Work:
      case CState.Shop:
        this.startTrip(c, c.place ?? c.home, c.home, TripKind.Home);
        break;
      case CState.Travel:
        if (c.virtual) this.arrive(c, true);
        break;
    }
  }

  private decideAtHome(c: Citizen): void {
    const clock = this.world.clock;
    const hour = clock.hour;
    const day = clock.day;
    if (c.worker && !c.job && this.now - c.lastJobSearch > HOUR * 2) {
      c.lastJobSearch = this.now;
      this.findJob(c);
    }
    if (c.worker && c.job && c.lastWorkDay < day) {
      if (hour >= c.startHour && hour < c.startHour + 3.5) {
        c.lastWorkDay = day;
        this.startTrip(c, c.home, c.job, TripKind.Work);
        return;
      }
      if (hour >= c.startHour + 3.5) c.lastWorkDay = day;
    }
    c.shopNeed += 0.08;
    if (c.shopNeed > 1 && hour >= 8 && hour < 21 && this.rng.chance(0.5)) {
      const shop = this.findShop(c.home);
      if (shop) {
        this.startTrip(c, c.home, shop, TripKind.Shop);
        return;
      }
      c.home.shopOk = c.home.shopOk * 0.9;
      c.shopNeed = 0.5;
    }
    this.schedule(c, this.now + HOUR * (0.5 + this.rng.next()));
  }

  private findJob(c: Citizen): void {
    const home = c.home;
    this.accessOf(home);
    if (home.component < 0) return;
    let best: Building | null = null;
    let bd = Infinity;
    const list = this.vacancies;
    for (let k = 0; k < 12 && list.length; k++) {
      const b = list[this.rng.int(list.length)];
      if (!b.active || b.people.length >= b.capacity) continue;
      this.accessOf(b);
      if (b.component !== home.component) continue;
      const d = Math.hypot(b.cx - home.cx, b.cy - home.cy) + this.rng.next() * 300;
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (best) {
      best.people.push(c.id);
      c.job = best;
    }
  }

  private findShop(home: Building): Building | null {
    this.accessOf(home);
    let best: Building | null = null;
    let bd = Infinity;
    const list = this.shops;
    for (let k = 0; k < 10 && list.length; k++) {
      const b = list[this.rng.int(list.length)];
      if (!b.active || b.goods < 1) continue;
      this.accessOf(b);
      if (b.component !== home.component) continue;
      const d = Math.hypot(b.cx - home.cx, b.cy - home.cy) * (0.7 + this.rng.next() * 0.6);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  private startTrip(c: Citizen, from: Building, to: Building, kind: number): void {
    c.state = CState.Travel;
    c.tripKind = kind;
    c.tripTarget = to;
    c.tripFrom = from;
    c.tripStart = this.now;
    c.virtual = false;
    this.tripsStarted++;
    if (from === to) {
      this.arrive(c, true);
      return;
    }
    const fa = this.accessOf(from);
    const ta = this.accessOf(to);
    if (!fa || !ta || from.component !== to.component) {
      this.tripImpossible(c);
      return;
    }
    const dist = Math.hypot(from.cx - to.cx, from.cy - to.cy);
    if (this.transitPlanner && this.transitPlanner(c, from, to, dist)) {
      c.mode = 'bus';
      this.modeCounts.bus++;
      return;
    }
    if (!c.car || (dist < CITY.walkDistance && this.rng.chance(0.55))) {
      c.mode = 'walk';
      this.modeCounts.walk++;
      this.virtualTrip(c, (dist * 1.3) / 1.4);
      return;
    }
    c.mode = 'car';
    this.modeCounts.car++;
    const traffic = this.world.traffic;
    if (traffic.count > traffic.settings.maxVehicles * 0.9 || !this.rng.chance(CITY.realTripShare)) {
      this.virtualTrip(c, (dist * 1.4) / 9 + 20);
      return;
    }
    traffic.request({
      kind: VKind.Car,
      origins: fa.origins,
      dests: ta.dests,
      data: kind === TripKind.Work ? 'Driving to work' : kind === TripKind.Shop ? 'Going shopping' : 'Driving home',
      onTrip: (_v, ok) => this.arrive(c, ok),
      onFail: (reason) => {
        if (reason === 'noroute') this.tripImpossible(c);
        else this.virtualTrip(c, (dist * 1.4) / 9 + 20);
      },
    });
  }

  /** Trip without a simulated vehicle; the citizen arrives after `duration` seconds. */
  virtualTrip(c: Citizen, duration: number): void {
    c.virtual = true;
    this.schedule(c, this.now + duration);
  }

  /** Called by the transit module when a passenger reaches their destination. */
  arrive(c: Citizen, ok: boolean): void {
    if (c.removed) return;
    const to = c.tripTarget;
    const kind = c.tripKind;
    const dur = this.now - c.tripStart;
    c.virtual = false;
    if (kind === TripKind.Work || kind === TripKind.Home) c.commute = c.commute ? c.commute * 0.7 + dur * 0.3 : dur;
    if (!ok) c.commute += 60;
    if (!to || !this.buildings[to.id]) {
      c.state = CState.Home;
      c.place = c.home;
      this.schedule(c, this.now + HOUR);
      return;
    }
    if (kind === TripKind.Work) {
      if (c.job === to && to.active) {
        c.state = CState.Work;
        c.place = to;
        this.schedule(c, this.now + c.shift * HOUR);
      } else this.goHomeInstant(c);
    } else if (kind === TripKind.Shop) {
      c.state = CState.Shop;
      c.place = to;
      to.customers++;
      if (to.active && to.goods >= 1) {
        to.goods -= 1;
        to.sales++;
        c.shopNeed = 0;
        c.home.shopOk = c.home.shopOk * 0.8 + 0.2;
        this.budgetToday.commercial += 0.8 * (this.taxes.c / 9);
      } else {
        c.home.shopOk = c.home.shopOk * 0.8;
        c.shopNeed = 0.6;
      }
      this.schedule(c, this.now + HOUR * (0.3 + this.rng.next() * 0.5));
    } else {
      c.state = CState.Home;
      c.place = c.home;
      this.schedule(c, this.now + HOUR * (0.3 + this.rng.next()));
    }
  }

  private goHomeInstant(c: Citizen): void {
    c.state = CState.Home;
    c.place = c.home;
    this.schedule(c, this.now + HOUR);
  }

  private tripImpossible(c: Citizen): void {
    const to = c.tripTarget;
    if (c.tripKind === TripKind.Work && to && c.job === to) {
      const j = to.people.indexOf(c.id);
      if (j >= 0) to.people.splice(j, 1);
      c.job = null;
    }
    if (c.tripKind === TripKind.Shop) c.home.shopOk *= 0.85;
    this.goHomeInstant(c);
  }

  // ------------------------------------------------------------------ immigration

  private immigrate(dt: number): void {
    if (this.attractiveness <= 0.02 || this.outsideComps.size === 0) return;
    const rate = this.attractiveness * (0.15 + this.population * 0.0006);
    this.immigrationAcc += rate * dt;
    let guard = 0;
    while (this.immigrationAcc >= 1 && guard++ < 5) {
      this.immigrationAcc -= 1;
      this.moveIn();
    }
    this.immigrationAcc = Math.min(this.immigrationAcc, 3);
  }

  private moveIn(): void {
    const homes = this.buildings.filter((b): b is Building => !!b && b.active && b.zone === Zone.Residential && b.people.length + b.pending < b.capacity);
    if (homes.length === 0) return;
    for (let k = 0; k < 6; k++) {
      const b = homes[this.rng.int(homes.length)];
      if (!this.connectedToOutside(b)) {
        b.problems |= Problem.NoConnection;
        continue;
      }
      const free = b.capacity - b.people.length - b.pending;
      const size = Math.max(1, Math.min(free, 1 + this.rng.int(4)));
      const route = this.outsideFor(b);
      const acc = this.accessOf(b);
      if (!route || !acc) continue;
      b.pending += size;
      const settle = (): void => {
        b.pending = Math.max(0, b.pending - size);
        if (!this.buildings[b.id] || !b.active) return;
        const n = Math.min(size, b.capacity - b.people.length);
        for (let i = 0; i < n; i++) this.addCitizen(b);
      };
      this.world.traffic.request({
        kind: VKind.Car,
        origins: route.origins,
        dests: acc.dests,
        color: '#f7f7f2',
        data: 'Moving into the city',
        onTrip: () => settle(),
        onFail: (reason) => (reason === 'noroute' ? (b.pending = Math.max(0, b.pending - size)) : settle()),
      });
      return;
    }
  }

  /** Residents of an unhappy home move away (driving out of town). */
  private moveOut(b: Building): void {
    const n = Math.min(b.people.length, 1 + this.rng.int(3));
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const c = this.citizens[b.people[b.people.length - 1]];
      if (c) this.removeCitizen(c);
    }
    const route = this.outsideFor(b);
    const acc = this.accessOf(b);
    if (route && acc) this.world.traffic.request({ kind: VKind.Car, origins: acc.origins, dests: route.dests, color: '#9aa5ad', data: 'Moving away (unhappy)' });
  }

  // ------------------------------------------------------------------ freight

  private truck(from: Building | null, to: Building | null, onArrive: () => void, returnTrip: boolean, purpose: string): boolean {
    const a = from ? this.accessOf(from) : null;
    const b = to ? this.accessOf(to) : null;
    const ref = (from ?? to)!;
    const outside = !from || !to ? this.outsideFor(ref) : null;
    const origins = from ? a?.origins : outside?.origins;
    const dests = to ? b?.dests : outside?.dests;
    if (!origins?.length || !dests?.length) return false;
    const traffic = this.world.traffic;
    if (traffic.count > traffic.settings.maxVehicles * 0.9) {
      onArrive();
      return true;
    }
    traffic.request({
      kind: VKind.Truck,
      origins,
      dests,
      data: purpose,
      onTrip: () => {
        onArrive();
        if (returnTrip) {
          const back = to ? b?.origins : outside?.origins;
          const home = from ? a?.dests : outside?.dests;
          if (back?.length && home?.length) traffic.request({ kind: VKind.Truck, origins: back, dests: home, data: 'Returning empty' });
        }
      },
      onFail: (reason) => {
        if (reason !== 'noroute') onArrive();
        else if (to) to.incoming = Math.max(0, to.incoming - CITY.truckLoad);
      },
    });
    return true;
  }

  private freight(): void {
    const load = CITY.truckLoad;
    const live = this.buildings.filter((b): b is Building => !!b && b.active);
    const factories = live.filter((b) => b.zone === Zone.Industrial);
    const farms = live.filter((b) => b.zone === Zone.Farming);
    const shops = live.filter((b) => b.zone === Zone.Commercial);
    const nearest = (list: Building[], ref: Building, ok: (b: Building) => boolean): Building | null => {
      let best: Building | null = null;
      let bd = Infinity;
      this.accessOf(ref);
      for (const b of list) {
        if (!ok(b)) continue;
        this.accessOf(b);
        if (b.component !== ref.component || b.component < 0) continue;
        const d = Math.hypot(b.cx - ref.cx, b.cy - ref.cy);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      return best;
    };
    // Shops order goods from factories, or import them.
    for (const s of shops) {
      if (s.goods + s.incoming >= 6 * s.level + 4) continue;
      const f = nearest(factories, s, (b) => b.goods - b.reserved >= load);
      if (f) {
        f.reserved += load;
        s.incoming += load;
        const ok = this.truck(f, s, () => {
          f.reserved = Math.max(0, f.reserved - load);
          f.goods = Math.max(0, f.goods - load);
          s.incoming = Math.max(0, s.incoming - load);
          s.goods += load;
        }, true, 'Delivering goods to a shop');
        if (!ok) {
          f.reserved -= load;
          s.incoming -= load;
        }
      } else if (this.connectedToOutside(s) && this.rng.chance(0.35)) {
        s.incoming += load;
        const ok = this.truck(null, s, () => {
          s.incoming = Math.max(0, s.incoming - load);
          s.goods += load;
          this.budgetToday.imports += load * 0.6;
        }, true, 'Importing goods for a shop');
        if (!ok) s.incoming -= load;
      }
    }
    // Factories without rich ground need crops.
    for (const f of factories) {
      if (f.rich >= 0.75 || f.crops + f.incoming >= 12) continue;
      const farm = nearest(farms, f, (b) => b.crops - b.reserved >= load);
      if (farm) {
        farm.reserved += load;
        f.incoming += load;
        const ok = this.truck(farm, f, () => {
          farm.reserved = Math.max(0, farm.reserved - load);
          farm.crops = Math.max(0, farm.crops - load);
          f.incoming = Math.max(0, f.incoming - load);
          f.crops += load;
        }, true, 'Delivering crops to a factory');
        if (!ok) {
          farm.reserved -= load;
          f.incoming -= load;
        }
      } else if (this.connectedToOutside(f) && this.rng.chance(0.3)) {
        f.incoming += load;
        const ok = this.truck(null, f, () => {
          f.incoming = Math.max(0, f.incoming - load);
          f.crops += load;
          this.budgetToday.imports += load * 0.4;
        }, true, 'Importing crops for a factory');
        if (!ok) f.incoming -= load;
      }
    }
    // Surplus is exported.
    for (const b of [...farms, ...factories]) {
      const stock = b.zone === Zone.Farming ? b.crops : b.goods;
      if (stock - b.reserved < 30 * b.level || !this.connectedToOutside(b)) continue;
      b.reserved += load * 2;
      const ok = this.truck(b, null, () => {
        b.reserved = Math.max(0, b.reserved - load * 2);
        if (b.zone === Zone.Farming) b.crops = Math.max(0, b.crops - load * 2);
        else b.goods = Math.max(0, b.goods - load * 2);
        this.budgetToday.exports += load * 2 * 1.5;
      }, false, b.zone === Zone.Farming ? 'Exporting crops' : 'Exporting goods');
      if (!ok) b.reserved -= load * 2;
    }
  }

  // ------------------------------------------------------------------ hourly building update

  private noiseAt(b: Building): number {
    const map = this.world.map;
    let noise = 0;
    for (let y = b.y0 - 2; y <= b.y1 + 2; y++) {
      for (let x = b.x0 - 2; x <= b.x1 + 2; x++) {
        if (!map.inBounds(x, y)) continue;
        const t = y * map.w + x;
        for (let d = 0; d < 4; d++) {
          const tp = this.world.roads.type[t * 4 + d];
          if (tp && (ROAD_TYPES[tp].highway || ROAD_TYPES[tp].rank >= 3)) noise += 1;
        }
        const ob = this.world.buildingAt[t];
        if (ob >= 0 && this.buildings[ob]?.zone === Zone.Industrial) noise += 0.5;
      }
    }
    return Math.min(1, noise / 10);
  }

  private hourlyBuilding(b: Building, hours: number): void {
    this.updateBuilding(b, hours);
    // Only problems that persist between updates are shown to the player.
    b.shownProblems = b.problems & b.lastProblems;
    b.lastProblems = b.problems;
  }

  private updateBuilding(b: Building, hours: number): void {
    const day = hours / 24;
    b.problems = 0;
    const acc = this.accessOf(b);
    if (!acc) b.problems |= Problem.NoRoad;
    if (b.state === BState.Abandoned) {
      b.abandonedTime += day;
      if (b.abandonedTime > 1) this.removeBuilding(b.id);
      return;
    }
    if (b.state !== BState.Active) return;
    b.age += day;
    if (!this.connectedToOutside(b)) b.problems |= Problem.NoConnection;
    const tax = this.taxes;
    if (b.zone === Zone.Residential) {
      let workers = 0;
      let employed = 0;
      let commute = 0;
      let cn = 0;
      for (const id of b.people) {
        const c = this.citizens[id];
        if (!c) continue;
        // Newcomers get half a day to find work before unemployment weighs on them.
        if (c.worker && (c.job || this.now - c.movedIn > DAY_SECONDS / 2)) {
          workers++;
          if (c.job) employed++;
        }
        if (c.commute > 0) {
          commute += c.commute;
          cn++;
        }
      }
      b.commute = cn ? commute / cn : 0;
      // Commutes are measured in simulated time (what you see cars drive), in minutes.
      const mins = b.commute / 60;
      const empFrac = workers ? employed / workers : 1;
      if (workers >= 2 && empFrac < 0.5) b.problems |= Problem.NoJobs;
      let h = 62;
      h += (empFrac - 0.75) * 60;
      h += (b.shopOk - 0.6) * 30;
      h -= Math.max(0, Math.min(1, (mins - 2.5) / 5)) * 28;
      h -= this.noiseAt(b) * 14;
      h -= (tax.r - 9) * 1.5;
      h += this.transitBonus(b);
      if (!acc) h -= 30;
      b.happiness += (Math.max(0, Math.min(100, h)) - b.happiness) * Math.min(1, hours * 0.35);
      if (b.happiness < 35) b.problems |= Problem.Unhappy;
      if (mins > 5) b.problems |= Problem.LongCommute;
      this.budgetToday.residential += employed * 3 * (tax.r / 9) * day;
      if (b.happiness >= 72) b.goodTime += day;
      else b.goodTime = Math.max(0, b.goodTime - day * 0.5);
      if (b.happiness < 30) b.badTime += day;
      else b.badTime = Math.max(0, b.badTime - day * 0.5);
      if (b.goodTime > 1 && b.level < 3 && this.demand.r > -0.2) this.levelUp(b);
      if (b.badTime > 0.4 && b.people.length && this.rng.chance(0.25 * hours)) this.moveOut(b);
      if (b.badTime > 3) this.abandon(b);
      return;
    }
    // Workplaces.
    const staff = b.people.length;
    const staffing = staff / b.capacity;
    // New workplaces get some time to hire staff and fill their stock.
    const settled = b.age > 0.3;
    if (staffing < 0.5 && settled) b.problems |= Problem.NoWorkers;
    const lvl = b.level;
    if (b.zone === Zone.Farming) {
      const add = staff * 0.55 * hours;
      b.crops = Math.min(40 * lvl, b.crops + add);
      b.produced += add;
      this.budgetToday.farming += add * 0.3 * (tax.f / 9);
    } else if (b.zone === Zone.Industrial) {
      const fromRich = staff * 0.4 * b.rich * hours;
      const use = Math.min(b.crops, staff * 0.5 * (1 - b.rich) * hours);
      b.crops -= use;
      const add = fromRich + use * 1.3;
      b.goods = Math.min(60 * lvl, b.goods + add);
      b.produced += add;
      this.budgetToday.industrial += add * 0.35 * (tax.i / 9);
      if (b.rich < 0.5 && b.crops < 1 && b.incoming <= 0 && staff > 0 && settled) b.problems |= Problem.NoInputs;
    } else if (b.zone === Zone.Commercial) {
      if (b.goods < 1 && settled) b.problems |= Problem.NoGoods;
      b.sales = Math.max(0, b.sales - staff * 0.1 * hours);
      if (b.customers < b.capacity * 0.5 * day * 24 && staff > 0 && b.age > 0.6) b.problems |= Problem.NoCustomers;
      b.customers = Math.max(0, b.customers * (1 - 0.2 * hours));
    }
    const healthy = staffing >= 0.85 && !(b.problems & (Problem.NoGoods | Problem.NoInputs | Problem.NoRoad));
    if (healthy) b.happiness = Math.min(100, b.happiness + hours * 2);
    else b.happiness = Math.max(0, b.happiness - hours * 2);
    if (b.happiness > 85 && b.level < 3 && this.demand[b.zone === Zone.Commercial ? 'c' : b.zone === Zone.Industrial ? 'i' : 'f'] > -0.3) {
      b.happiness = 60;
      this.levelUp(b);
    }
    if (staff === 0 && b.happiness < 5 && this.workers > 20) this.abandon(b);
  }

  private levelUp(b: Building): void {
    b.level++;
    b.goodTime = 0;
    this.events.emit('tiles', [{ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }]);
  }

  private abandon(b: Building): void {
    for (const id of [...b.people]) {
      const c = this.citizens[id];
      if (!c) continue;
      if (b.zone === Zone.Residential) this.removeCitizen(c);
      else if (c.job === b) {
        c.job = null;
      }
    }
    b.people = [];
    b.state = BState.Abandoned;
    b.abandonedTime = 0;
    this.events.emit('tiles', [{ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }]);
  }

  /** Bonus to happiness from public transport (installed by the transit module). */
  transitBonus: (b: Building) => number = () => 0;

  // ------------------------------------------------------------------ demand & economy

  private updateDemand(): void {
    let workers = 0;
    let employed = 0;
    let cJobs = 0;
    let iJobs = 0;
    let fJobs = 0;
    let happy = 0;
    let homes = 0;
    let commute = 0;
    let commuters = 0;
    this.vacancies = [];
    this.shops = [];
    for (const b of this.buildings) {
      if (!b || b.state === BState.Abandoned) continue;
      if (b.zone === Zone.Residential) {
        if (b.active) {
          happy += b.happiness * b.people.length;
          homes += b.people.length;
          if (b.commute > 0) {
            commute += b.commute * b.people.length;
            commuters += b.people.length;
          }
        }
        continue;
      }
      const cap = b.capacity;
      if (b.zone === Zone.Commercial) cJobs += cap;
      else if (b.zone === Zone.Industrial) iJobs += cap;
      else fJobs += cap;
      if (b.active && b.people.length < cap) this.vacancies.push(b);
      if (b.active && b.zone === Zone.Commercial) this.shops.push(b);
    }
    for (const c of this.citizens) {
      if (!c || !c.worker) continue;
      workers++;
      if (c.job) employed++;
    }
    this.workers = workers;
    this.employed = employed;
    this.jobs = cJobs + iJobs + fJobs;
    this.happiness = homes ? happy / homes : 60;
    this.commuteMinutes = commuters ? commute / commuters / 60 : 0;
    const unemployed = workers - employed;
    const vacancies = this.vacancies.reduce((s, b) => s + b.capacity - b.people.length, 0);
    const u = unemployed / Math.max(1, workers);
    const pop = this.population;
    const t = this.taxes;
    // Empty homes (built but not yet occupied) dampen residential demand.
    let freeHomes = 0;
    for (const b of this.buildings) {
      if (b && b.zone === Zone.Residential && b.state !== BState.Abandoned) freeHomes += Math.max(0, b.capacity - b.people.length - b.pending);
    }
    const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
    // How much people want to live here (drives moving in to empty homes).
    const attract = 0.35 + (this.happiness - 55) / 60 + ((vacancies - unemployed) / Math.max(15, workers * 0.25)) * 0.8 - (u > 0.15 ? (u - 0.15) * 4 : 0) - (t.r - 9) / 18;
    this.attractiveness += (clamp(attract) - this.attractiveness) * 0.3;
    // New homes are only needed once existing ones are filling up.
    const r = attract - freeHomes / Math.max(25, pop * 0.3);
    const target = {
      r: clamp(r),
      c: clamp(((0.25 * workers + 4 - cJobs) / Math.max(8, 0.12 * workers)) * 0.6 + u * 1.2 - (t.c - 9) / 18),
      i: clamp(((0.55 * workers + 6 - iJobs) / Math.max(10, 0.2 * workers)) * 0.6 + u * 1.5 - (t.i - 9) / 18),
      f: clamp(((0.15 * workers + 3 - fJobs) / Math.max(6, 0.1 * workers)) * 0.5 + u * 0.8 - (t.f - 9) / 18),
    };
    for (const k of ['r', 'c', 'i', 'f'] as const) this.demand[k] += (target[k] - this.demand[k]) * 0.3;
  }

  private hourlyEconomy(hours: number): void {
    const day = hours / 24;
    this.budgetToday.roads += this.roadUpkeepPerDay * day;
    this.budgetToday.junctions += this.junctionUpkeepPerDay * day;
    this.budgetToday.transit += this.transitUpkeepPerDay * day;
  }

  /** Net money change per day (using yesterday's totals, or today's projection early on). */
  get moneyPerDay(): number {
    const b = this.world.clock.day > 1 ? this.budgetYesterday : this.budgetToday;
    const scale = this.world.clock.day > 1 ? 1 : 24 / Math.max(1, this.world.clock.hour - 5.9);
    return (this.income(b) - this.expenses(b)) * (this.world.clock.day > 1 ? 1 : Math.min(4, scale));
  }

  income(b: Budget): number {
    return b.residential + b.commercial + b.industrial + b.farming + b.exports + b.fares;
  }

  expenses(b: Budget): number {
    return b.roads + b.junctions + b.transit + b.imports;
  }

  /** Net amount of today's budget already applied to the city's money. */
  private settled = 0;

  /** Applies today's income and expenses that have not been paid out yet. */
  private settleMoney(): void {
    const net = this.income(this.budgetToday) - this.expenses(this.budgetToday);
    const delta = net - this.settled;
    this.settled = net;
    if (delta > 0) this.world.earn(delta);
    else if (delta < 0) this.world.spend(-delta);
  }

  private checkMilestones(): void {
    const ms = CITY.milestones;
    while (this.milestone < ms.length && this.population >= ms[this.milestone].pop) {
      const m = ms[this.milestone];
      this.world.earn(m.reward);
      this.events.emit('milestone', { index: this.milestone, name: m.name, reward: m.reward, pop: m.pop });
      this.milestone++;
    }
  }

  notice(key: string, text: string, cooldown = DAY_SECONDS / 2): void {
    const last = this.noticeCooldown.get(key) ?? -1e9;
    if (this.now - last < cooldown) return;
    this.noticeCooldown.set(key, this.now);
    this.events.emit('notice', text);
  }

  // ------------------------------------------------------------------ main step

  step(dt: number): void {
    const t = this.timers;
    // Construction.
    t.construct += dt;
    if (t.construct >= 1) {
      for (const b of this.buildings) {
        if (!b || b.state !== BState.Construction) continue;
        b.build -= t.construct;
        if (b.build <= 0) {
          b.state = BState.Active;
          b.goodTime = 0;
          b.happiness = 60;
          if (b.zone === Zone.Commercial) b.goods = 8;
          this.events.emit('tiles', [{ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }]);
        }
      }
      t.construct = 0;
    }
    this.processQueue();
    this.immigrate(dt);
    t.grow += dt;
    if (t.grow >= 1.5) {
      t.grow = 0;
      const zones: Array<[number, number]> = [
        [Zone.Residential, this.demand.r],
        [Zone.Commercial, this.demand.c],
        [Zone.Industrial, this.demand.i],
        [Zone.Farming, this.demand.f],
      ];
      for (const [z, d] of zones) {
        if (d > 0.05 && this.rng.chance(0.3 + d * 0.6)) this.tryGrow(z, d);
      }
    }
    t.demand += dt;
    if (t.demand >= 4) {
      t.demand = 0;
      this.updateDemand();
      this.peakPopulation = Math.max(this.peakPopulation, this.population);
      this.checkMilestones();
      if (this.population === 0 && this.buildings.some((b) => b && b.zone === Zone.Residential && b.active) && this.outsideComps.size === 0) {
        this.notice('connect', 'Connect your roads to a highway exit so people can move in.');
      }
    }
    t.freight += dt;
    if (t.freight >= 4) {
      t.freight = 0;
      this.freight();
    }
    t.hour += dt;
    if (t.hour >= HOUR / 4) {
      const hours = t.hour / HOUR;
      t.hour = 0;
      for (const b of this.buildings) if (b) this.hourlyBuilding(b, hours);
      this.hourlyEconomy(hours);
      this.settleMoney();
      const day = this.world.clock.day;
      if (day !== this.lastDay) {
        this.lastDay = day;
        this.budgetYesterday = this.budgetToday;
        this.budgetToday = emptyBudget();
        this.settled = 0;
        this.modeCounts = { car: 0, walk: 0, bus: 0 };
      }
    }
  }

  /** Citizens currently living in the city (including those on trips). */
  get residents(): number {
    return this.population;
  }

  tileRectOf(b: Building): TileRect {
    return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
  }

  get tileSize(): number {
    return TILE;
  }
}
