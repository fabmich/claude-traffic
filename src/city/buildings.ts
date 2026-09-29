import { TILE } from '../config';
import type { Lane, Network, Segment } from '../roads/network';
import type { RoadLayer } from '../roads/roadLayer';
import { ROAD_TYPES } from '../roads/roadTypes';
import type { SpawnOrigin } from '../sim/Traffic';
import type { Destination } from '../sim/vehicle';
import type { BuildingTemplate } from './templates';
import { Zone } from './zones';

export const BState = {
  Construction: 0,
  Active: 1,
  Abandoned: 2,
} as const;

export const Problem = {
  NoRoad: 1,
  NoWorkers: 2,
  NoCustomers: 4,
  NoGoods: 8,
  NoConnection: 16,
  Unhappy: 32,
  NoInputs: 64,
  LongCommute: 128,
  NoJobs: 256,
} as const;

export const PROBLEM_TEXT: Record<number, string> = {
  [Problem.NoRoad]: 'No road access',
  [Problem.NoWorkers]: 'Not enough workers',
  [Problem.NoCustomers]: 'Not enough customers',
  [Problem.NoGoods]: 'Out of goods: needs deliveries from factories',
  [Problem.NoConnection]: 'Not connected to a highway exit (no new residents or trade)',
  [Problem.Unhappy]: 'Residents are unhappy',
  [Problem.NoInputs]: 'Needs crops from farms (or build on rich ground)',
  [Problem.LongCommute]: 'Long commutes: traffic is slowing people down',
  [Problem.NoJobs]: 'Residents cannot find jobs: zone more industry, farms or shops',
};

/** Where a building meets the road network. */
export interface Access {
  seg: Segment;
  roadTile: number;
  origins: SpawnOrigin[];
  dests: Destination[];
  x: number;
  y: number;
}

export class Building {
  level = 1;
  state: number = BState.Construction;
  /** Seconds of construction left. */
  build = 25;
  /** Residents (R) or workers (C/I/F). */
  people: number[] = [];
  /** Residents on their way to move in. */
  pending = 0;
  happiness = 60;
  /** Accumulated game-days of high/low happiness for level changes. */
  goodTime = 0;
  badTime = 0;
  /** Commerce and industry stocks. */
  goods = 0;
  crops = 0;
  incoming = 0;
  reserved = 0;
  sales = 0;
  customers = 0;
  produced = 0;
  /** Fraction of the footprint on rich-material ground (factories). */
  rich = 0;
  problems = 0;
  /** Problems seen in the previous update too (what the player is shown). */
  shownProblems = 0;
  lastProblems = 0;
  /** Game-days since construction finished. */
  age = 0;
  access: Access | null = null;
  accessDirty = true;
  component = -1;
  abandonedTime = 0;
  /** Recent shopping success of residents (EMA, R only). */
  shopOk = 1;
  /** Recent average commute in seconds (R only). */
  commute = 0;

  constructor(
    readonly id: number,
    readonly template: BuildingTemplate,
    readonly tiles: number[],
    /** Tile bounding box (inclusive). */
    readonly x0: number,
    readonly y0: number,
    readonly x1: number,
    readonly y1: number,
    /** Direction (0, 2, 4, 6) from the building towards its road. */
    readonly facing: number,
    /** Road tile the front of the building touches. */
    readonly roadTile: number,
    readonly seed: number,
  ) {}

  get zone(): number {
    return this.template.zone;
  }

  get capacity(): number {
    return this.template.capacity[this.level - 1];
  }

  get isWorkplace(): boolean {
    return this.template.zone !== Zone.Residential;
  }

  get active(): boolean {
    return this.state === BState.Active;
  }

  get cx(): number {
    return ((this.x0 + this.x1 + 1) / 2) * TILE;
  }

  get cy(): number {
    return ((this.y0 + this.y1 + 1) / 2) * TILE;
  }
}

/** True if any road touching `tile` lets buildings connect (not a highway). */
export function hasAccessRoad(roads: RoadLayer, tile: number): boolean {
  for (let d = 0; d < 8; d++) {
    const t = roads.edgeType(tile, d);
    if (t && ROAD_TYPES[t].access) return true;
  }
  return false;
}

/** Resolves where a building at `roadTile` joins the network (both driving directions if possible). */
export function resolveAccess(net: Network, roads: RoadLayer, roadTile: number, mapW: number): Access | null {
  let seg: Segment | null = null;
  for (let d = 0; d < 8; d++) {
    const e = roads.edgeIndex(roadTile, d);
    if (e < 0 || roads.type[e] === 0 || !ROAD_TYPES[roads.type[e]].access) continue;
    const s = net.segmentAtEdge(e);
    if (s && !s.type.hidden) {
      seg = s;
      break;
    }
  }
  if (!seg) return null;
  const x = ((roadTile % mapW) + 0.5) * TILE;
  const y = (Math.floor(roadTile / mapW) + 0.5) * TILE;
  // Closest point on the centreline.
  const c = seg.center;
  let bestS = 0;
  let bd = Infinity;
  for (let i = 0; i < c.n - 1; i++) {
    const ax = c.xs[i];
    const ay = c.ys[i];
    const dx = c.xs[i + 1] - ax;
    const dy = c.ys[i + 1] - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < bd) {
      bd = d;
      bestS = c.cum[i] + t * (c.cum[i + 1] - c.cum[i]);
    }
  }
  const usable = c.length - seg.trimA - seg.trimB;
  if (usable < 4) return null;
  const sc = Math.max(seg.trimA + 2, Math.min(c.length - seg.trimB - 2, bestS));
  const origins: SpawnOrigin[] = [];
  const dests: Destination[] = [];
  const add = (lanes: Lane[], forward: boolean): void => {
    if (lanes.length === 0) return;
    const lane = lanes[0];
    const frac = forward ? (sc - seg!.trimA) / usable : (c.length - seg!.trimB - sc) / usable;
    const s = Math.max(1, Math.min(lane.length - 1, frac * lane.length));
    origins.push({ lane, s });
    dests.push({ seg: seg!, forward, s, tile: roadTile, outside: false });
  };
  add(seg.forward, true);
  add(seg.backward, false);
  if (origins.length === 0) return null;
  return { seg, roadTile, origins, dests, x, y };
}
