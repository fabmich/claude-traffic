import { opposite, DX, DY } from '../world/grid';
import { Terrain } from '../world/terrain';
import type { SpanKind } from './roadLayer';
import { BRIDGE_COST_MULT, MAX_BRIDGE_TILES, MAX_TUNNEL_TILES, ROAD_TYPES, TUNNEL_COST_MULT } from './roadTypes';

/** Minimal view of the world needed for planning (keeps this module testable). */
export interface PlanContext {
  w: number;
  h: number;
  terrain: Uint8Array;
  /** Building id per tile or -1. */
  buildingAt: Int32Array;
  roads: import('./roadLayer').RoadLayer;
}

export interface PlanEdge {
  tile: number;
  dir: number;
  type: number;
  /** Existing type on this edge (0 = new). */
  existing: number;
  flowOut: boolean;
  cost: number;
}

export interface PlanSpan {
  kind: SpanKind;
  a: number;
  b: number;
  dir: number;
  len: number;
  type: number;
  cost: number;
}

export interface RoadPlan {
  path: number[];
  edges: PlanEdge[];
  spans: PlanSpan[];
  cost: number;
  valid: boolean;
  reason: string;
  /** Tiles to highlight as problems. */
  bad: number[];
}

const DIAG = Math.SQRT2;

function tileClass(ctx: PlanContext, t: number): 'land' | 'water' | 'mountain' | 'building' {
  if (ctx.buildingAt[t] >= 0) return 'building';
  const ter = ctx.terrain[t];
  if (ter === Terrain.Water) return 'water';
  if (ter === Terrain.Mountain) return 'mountain';
  return 'land';
}

function stepDir(ctx: PlanContext, a: number, b: number): number {
  const ax = a % ctx.w;
  const ay = (a - ax) / ctx.w;
  const bx = b % ctx.w;
  const by = (b - bx) / ctx.w;
  const dx = bx - ax;
  const dy = by - ay;
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return -1;
}

/** Plans building a road of `typeId` along a tile path. */
export function planRoad(ctx: PlanContext, path: number[], typeId: number, overpass: boolean): RoadPlan {
  const plan: RoadPlan = { path, edges: [], spans: [], cost: 0, valid: true, reason: '', bad: [] };
  const type = ROAD_TYPES[typeId];
  const fail = (reason: string, bad: number[] = []): RoadPlan => {
    plan.valid = false;
    if (!plan.reason) plan.reason = reason;
    plan.bad.push(...bad);
    return plan;
  };
  if (path.length < 2) return fail('Drag to draw a road');
  const roads = ctx.roads;
  const dirs: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const d = stepDir(ctx, path[i - 1], path[i]);
    if (d < 0) return fail('Path is not continuous');
    dirs.push(d);
  }
  const cls = path.map((t) => tileClass(ctx, t));
  if (cls[0] !== 'land') return fail('Roads must start on land', [path[0]]);
  if (cls[path.length - 1] !== 'land') return fail('Roads must end on land', [path[path.length - 1]]);

  const linkBlocked = (t: number, d: number): boolean => roads.edgeType(t, d) !== 0 || roads.spanAt(t, d) !== null;

  if (overpass) {
    const d0 = dirs[0];
    if (dirs.some((d) => d !== d0)) return fail('Overpasses must be straight');
    const len = path.length - 1;
    if (len < 2) return fail('An overpass must span at least one tile');
    if (len > MAX_BRIDGE_TILES) return fail(`Overpasses can span at most ${MAX_BRIDGE_TILES} tiles`);
    for (let i = 1; i < path.length - 1; i++) {
      const c = cls[i];
      if (c === 'mountain' || c === 'building') return fail('Cannot bridge over mountains or buildings', [path[i]]);
      if (roads.bridgeCover[path[i]] >= 0) return fail('Another bridge is in the way', [path[i]]);
      if (roads.spansTouching(path[i]).some((s) => s.kind === 'bridge')) return fail('Another bridge is in the way', [path[i]]);
    }
    if (linkBlocked(path[0], d0) || linkBlocked(path[path.length - 1], opposite(d0))) return fail('Overpass endpoint is already connected in that direction');
    const cost = type.cost * len * (d0 & 1 ? DIAG : 1) * BRIDGE_COST_MULT;
    plan.spans.push({ kind: 'bridge', a: path[0], b: path[path.length - 1], dir: d0, len, type: typeId, cost });
    plan.cost = Math.round(cost);
    return plan;
  }

  let i = 0;
  while (i < path.length - 1) {
    const a = path[i];
    const b = path[i + 1];
    const d = dirs[i];
    if (cls[i + 1] === 'land') {
      // Ground edge between two land tiles.
      if (roads.diagonalBlocked(a, d)) fail('Diagonal roads cannot cross', [a, b]);
      if (d & 1) {
        const s1 = roads.neighbor(a, (d + 7) & 7);
        const s2 = roads.neighbor(a, (d + 1) & 7);
        const blocked = (t: number): boolean => t >= 0 && tileClass(ctx, t) !== 'land' && tileClass(ctx, t) !== 'building';
        if (blocked(s1) && blocked(s2)) fail('Cannot squeeze diagonally between water or rock', [a, b]);
      }
      if (roads.spanAt(a, d)) fail('A bridge or tunnel already leaves here', [a]);
      const existing = roads.edgeType(a, d);
      const e = roads.edgeIndex(a, d);
      if (existing !== 0 && roads.protectedEdges.has(e)) {
        i++;
        continue;
      }
      const oneWay = type.lanesB === 0;
      let cost = 0;
      if (existing === typeId) {
        const flowSame = !oneWay || roads.edgeFlow(a, d, true) === 1;
        if (flowSame) {
          i++;
          continue;
        }
        cost = type.cost * 0.1;
      } else if (existing !== 0) {
        cost = Math.max(type.cost * 0.1, type.cost - ROAD_TYPES[existing].cost * 0.5);
      } else {
        cost = type.cost;
      }
      if (d & 1) cost *= DIAG;
      plan.edges.push({ tile: a, dir: d, type: typeId, existing, flowOut: true, cost });
      plan.cost += cost;
      i++;
      continue;
    }
    // A run of water / rock: must be straight and end on land.
    let j = i + 1;
    while (j < path.length && cls[j] !== 'land') j++;
    const run = path.slice(i + 1, j);
    if (j >= path.length) return fail('Roads must end on land', run);
    if (run.some((_, k) => cls[i + 1 + k] === 'building')) return fail('Buildings are in the way', run);
    const d0 = dirs[i];
    for (let k = i; k < j; k++) if (dirs[k] !== d0) return fail('Bridges and tunnels must be straight', run);
    const hasRock = run.some((_, k) => cls[i + 1 + k] === 'mountain');
    const kind: SpanKind = hasRock ? 'tunnel' : 'bridge';
    const len = j - i;
    const max = kind === 'bridge' ? MAX_BRIDGE_TILES : MAX_TUNNEL_TILES;
    if (len > max) return fail(`${kind === 'bridge' ? 'Bridges' : 'Tunnels'} can be at most ${max} tiles long`, run);
    const cover = kind === 'bridge' ? roads.bridgeCover : roads.tunnelCover;
    for (const t of run) if (cover[t] >= 0) return fail(`Another ${kind} is in the way`, [t]);
    if (linkBlocked(path[i], d0) || linkBlocked(path[j], opposite(d0))) return fail('The span endpoint is already connected in that direction', [path[i], path[j]]);
    const cost = type.cost * len * (d0 & 1 ? DIAG : 1) * (kind === 'bridge' ? BRIDGE_COST_MULT : TUNNEL_COST_MULT);
    plan.spans.push({ kind, a: path[i], b: path[j], dir: d0, len, type: typeId, cost });
    plan.cost += cost;
    i = j;
  }
  plan.cost = Math.round(plan.cost);
  if (plan.valid && plan.edges.length === 0 && plan.spans.length === 0) {
    plan.valid = false;
    plan.reason = 'Already built';
  }
  return plan;
}

export interface BulldozePlan {
  edges: Array<{ tile: number; dir: number; type: number }>;
  spans: number[];
  buildings: number[];
  refund: number;
  protectedHit: boolean;
}

/** Everything touching the given tiles: road edges, spans (endpoints or covered) and buildings. */
export function planBulldoze(ctx: PlanContext, tiles: number[]): BulldozePlan {
  const roads = ctx.roads;
  const plan: BulldozePlan = { edges: [], spans: [], buildings: [], refund: 0, protectedHit: false };
  const seenEdges = new Set<number>();
  const seenSpans = new Set<number>();
  const seenBuildings = new Set<number>();
  for (const t of tiles) {
    for (let d = 0; d < 8; d++) {
      const e = roads.edgeIndex(t, d);
      if (e < 0 || roads.type[e] === 0 || seenEdges.has(e)) continue;
      if (roads.protectedEdges.has(e)) {
        plan.protectedHit = true;
        continue;
      }
      seenEdges.add(e);
      const type = roads.type[e];
      plan.edges.push({ tile: t, dir: d, type });
      plan.refund += ROAD_TYPES[type].cost * (d & 1 ? DIAG : 1) * 0.5;
    }
    const spanIds = [roads.bridgeCover[t], roads.tunnelCover[t], ...roads.spansTouching(t).map((s) => s.id)];
    for (const id of spanIds) {
      if (id < 0 || seenSpans.has(id)) continue;
      const s = roads.spans.get(id);
      if (!s) continue;
      seenSpans.add(id);
      plan.spans.push(id);
      plan.refund += ROAD_TYPES[s.type].cost * s.len * (s.kind === 'bridge' ? BRIDGE_COST_MULT : TUNNEL_COST_MULT) * 0.5;
    }
    const b = ctx.buildingAt[t];
    if (b >= 0 && !seenBuildings.has(b)) {
      seenBuildings.add(b);
      plan.buildings.push(b);
    }
  }
  plan.refund = Math.round(plan.refund);
  return plan;
}
