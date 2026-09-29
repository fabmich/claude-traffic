import { MinHeap } from '../core/heap';
import { clamp, quantile } from '../core/math';
import { fbm, ridged, Simplex2 } from '../core/noise';
import { Rng } from '../core/rng';
import { DX, DY } from './grid';
import { Terrain } from './terrain';
import { WorldMap } from './WorldMap';

export interface MapGenOptions {
  seed: number;
  size: number;
}

/** Procedurally generates terrain: mountains, lakes, rivers, shores, farmland, rich ground, forest. */
export function generateMap({ seed, size }: MapGenOptions): WorldMap {
  const w = size;
  const h = size;
  const n = w * h;
  const rng = new Rng(seed);
  const map = new WorldMap(w, h, seed);
  const T = map.terrain;
  const height = map.height;

  const nElev = new Simplex2(rng.fork());
  const nRidge = new Simplex2(rng.fork());
  const nLake = new Simplex2(rng.fork());
  const nRiver = new Simplex2(rng.fork());
  const nMoist = new Simplex2(rng.fork());
  const nOre = new Simplex2(rng.fork());
  const nForest = new Simplex2(rng.fork());
  const nSand = new Simplex2(rng.fork());

  // 1. Height field: smooth hills plus ridged mountain ranges.
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = fbm(nElev, x / 42, y / 42, 5) * 0.5 + 0.5;
      const r = ridged(nRidge, x / 60, y / 60, 4);
      const v = 0.5 * e + 0.5 * r * (0.35 + 0.65 * e);
      height[y * w + x] = v;
      if (v < hMin) hMin = v;
      if (v > hMax) hMax = v;
    }
  }
  for (let i = 0; i < n; i++) height[i] = (height[i] - hMin) / (hMax - hMin || 1);

  // 2. Mountains: the highest ~9% of the terrain.
  const mountainThreshold = quantile(height, 0.91);
  for (let i = 0; i < n; i++) if (height[i] >= mountainThreshold) T[i] = Terrain.Mountain;
  removeSmallBlobs(map, Terrain.Mountain, 8, Terrain.Grass);

  // 3. Lakes in low basins.
  const lakeScore = new Float32Array(n);
  const lakeCandidates: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      lakeScore[i] = (1 - height[i]) * 0.45 + (fbm(nLake, x / 30, y / 30, 3) * 0.5 + 0.5) * 0.55;
      if (T[i] !== Terrain.Mountain) lakeCandidates.push(lakeScore[i]);
    }
  }
  const lakeThreshold = quantile(lakeCandidates, 0.968);
  for (let i = 0; i < n; i++) if (T[i] === Terrain.Grass && lakeScore[i] >= lakeThreshold) T[i] = Terrain.Water;
  removeSmallBlobs(map, Terrain.Water, 10, Terrain.Grass);

  // 4. Rivers crossing the map edge to edge.
  const riverCount = size >= 160 ? 2 : rng.chance(0.55) ? 2 : 1;
  for (let r = 0; r < riverCount; r++) carveRiver(map, rng, nRiver);

  // 5. Distances to water (land tiles) and to land (water tiles).
  computeWaterDistance(map);

  // 6. Sandy shores.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (T[i] !== Terrain.Grass || map.waterDist[i] !== 1) continue;
      if (nSand.noise(x * 0.15, y * 0.15) > -0.3) T[i] = Terrain.Sand;
    }
  }

  // 7. Farmland: moist lowland near water.
  const grassScores = (score: (x: number, y: number, i: number) => number): { scores: Float32Array; values: number[] } => {
    const scores = new Float32Array(n).fill(-Infinity);
    const values: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (T[i] !== Terrain.Grass) continue;
        const s = score(x, y, i);
        scores[i] = s;
        values.push(s);
      }
    }
    return { scores, values };
  };

  const farm = grassScores((x, y, i) => {
    const moist = fbm(nMoist, x / 22, y / 22, 3) * 0.5 + 0.5;
    const nearWater = Math.max(0, 1 - map.waterDist[i] / 12);
    return 0.55 * moist + 0.45 * nearWater - 0.25 * height[i];
  });
  applyTop(map, farm.scores, farm.values, 0.13, Terrain.Farmland);
  smoothTerrain(map, Terrain.Farmland);

  // 8. Rich-material ground, biased towards mountains.
  const mountainDist = bfsDistance(map, (i) => T[i] === Terrain.Mountain);
  const ore = grassScores((x, y, i) => {
    const blob = ridged(nOre, x / 18, y / 18, 3);
    const nearRock = Math.max(0, 1 - mountainDist[i] / 9);
    return 0.55 * blob + 0.45 * nearRock;
  });
  applyTop(map, ore.scores, ore.values, 0.065, Terrain.Rich);
  smoothTerrain(map, Terrain.Rich);

  // 9. Forest clusters.
  const forest = grassScores((x, y) => fbm(nForest, x / 16, y / 16, 4));
  applyTop(map, forest.scores, forest.values, 0.17, Terrain.Forest);
  smoothTerrain(map, Terrain.Forest);

  // 10. Outside connections (highway stubs at the map edge).
  placeOutsideConnections(map, rng);
  computeWaterDistance(map);
  return map;
}

function applyTop(map: WorldMap, scores: Float32Array, values: number[], fraction: number, t: number): void {
  if (values.length === 0) return;
  const thr = quantile(values, 1 - fraction);
  for (let i = 0; i < scores.length; i++) if (scores[i] >= thr && map.terrain[i] === Terrain.Grass) map.terrain[i] = t;
}

/** One cellular-automaton pass: removes specks of `t` and fills small holes. */
function smoothTerrain(map: WorldMap, t: number): void {
  const { w, h, terrain } = map;
  const next = terrain.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const cur = terrain[i];
      if (cur !== t && cur !== Terrain.Grass) continue;
      let count = 0;
      for (let d = 0; d < 8; d++) if (terrain[(y + DY[d]) * w + x + DX[d]] === t) count++;
      if (cur === t && count <= 1) next[i] = Terrain.Grass;
      else if (cur === Terrain.Grass && count >= 6) next[i] = t;
    }
  }
  terrain.set(next);
}

/** Replaces 4-connected components of terrain `t` smaller than `minSize`. */
function removeSmallBlobs(map: WorldMap, t: number, minSize: number, replacement: number): void {
  const { w, h, terrain } = map;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || terrain[s] !== t) continue;
    comp.length = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (let d = 0; d < 8; d += 2) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && terrain[j] === t) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (comp.length < minSize) for (const i of comp) terrain[i] = replacement;
  }
}

/** Multi-source BFS (4-neighbourhood) distance in tiles from tiles matching `isSource`, capped at 255. */
export function bfsDistance(map: WorldMap, isSource: (i: number) => boolean): Uint8Array {
  const { w, h } = map;
  const n = w * h;
  const dist = new Uint8Array(n).fill(255);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (isSource(i)) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    const nd = dist[i] + 1;
    if (nd >= 255) continue;
    for (let d = 0; d < 8; d += 2) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (dist[j] > nd) {
        dist[j] = nd;
        queue[tail++] = j;
      }
    }
  }
  return dist;
}

function computeWaterDistance(map: WorldMap): void {
  const T = map.terrain;
  const toWater = bfsDistance(map, (i) => T[i] === Terrain.Water);
  const toLand = bfsDistance(map, (i) => T[i] !== Terrain.Water);
  for (let i = 0; i < T.length; i++) map.waterDist[i] = T[i] === Terrain.Water ? toLand[i] : toWater[i];
}

function edgePoint(map: WorldMap, side: number, t: number): [number, number] {
  const { w, h } = map;
  switch (side) {
    case 0:
      return [Math.round(t * (w - 1)), 0];
    case 1:
      return [w - 1, Math.round(t * (h - 1))];
    case 2:
      return [Math.round(t * (w - 1)), h - 1];
    default:
      return [0, Math.round(t * (h - 1))];
  }
}

/** Carves a meandering river between two map edges using A* over a noisy cost field. */
function carveRiver(map: WorldMap, rng: Rng, noise: Simplex2): void {
  const { w, h, terrain, height } = map;
  const startSide = rng.int(4);
  const endSide = rng.chance(0.7) ? (startSide + 2) % 4 : (startSide + (rng.chance(0.5) ? 1 : 3)) % 4;
  let start = -1;
  let goal = -1;
  for (let attempt = 0; attempt < 20 && (start < 0 || goal < 0); attempt++) {
    const [sx, sy] = edgePoint(map, startSide, rng.range(0.15, 0.85));
    const [gx, gy] = edgePoint(map, endSide, rng.range(0.15, 0.85));
    if (terrain[sy * w + sx] !== Terrain.Mountain) start = sy * w + sx;
    if (terrain[gy * w + gx] !== Terrain.Mountain) goal = gy * w + gx;
  }
  if (start < 0 || goal < 0) return;

  const offset = rng.range(0, 1000);
  const cost = (i: number): number => {
    const x = i % w;
    const y = (i - x) / w;
    const valley = fbm(noise, x / 25 + offset, y / 25, 2) * 0.5 + 0.5;
    let c = 1 + 5 * height[i] + 5 * valley * valley;
    if (terrain[i] === Terrain.Mountain) c += 60;
    if (terrain[i] === Terrain.Water) c = 0.6;
    return c;
  };
  const gx = goal % w;
  const gy = (goal - gx) / w;
  const heur = (i: number): number => {
    const x = i % w;
    const y = (i - x) / w;
    return (Math.abs(x - gx) + Math.abs(y - gy)) * 0.6;
  };

  const n = w * h;
  const g = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap(4096);
  g[start] = 0;
  heap.push(start, heur(start));
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) break;
    const x = cur % w;
    const y = (cur - x) / w;
    for (let d = 0; d < 8; d += 2) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (closed[j]) continue;
      const ng = g[cur] + cost(j);
      if (ng < g[j]) {
        g[j] = ng;
        came[j] = cur;
        heap.push(j, ng + heur(j));
      }
    }
  }
  if (came[goal] < 0 && goal !== start) return;

  const path: number[] = [];
  for (let i = goal; i >= 0; i = came[i]) {
    path.push(i);
    if (i === start) break;
  }
  const widthOffset = rng.range(0, 1000);
  for (let k = 0; k < path.length; k++) {
    const i = path[k];
    const x = i % w;
    const y = (i - x) / w;
    terrain[i] = Terrain.Water;
    const wide = fbm(noise, k * 0.035 + widthOffset, 7.3, 2) > -0.05;
    if (!wide) continue;
    for (let d = 0; d < 8; d += 2) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      terrain[ny * w + nx] = Terrain.Water;
    }
  }
}

const INWARD_DIR = [2, 4, 6, 0]; // top edge -> S, right edge -> W, bottom edge -> N, left edge -> E

/** Picks 2-3 map-edge spots for highway connections to the outside world. */
function placeOutsideConnections(map: WorldMap, rng: Rng): void {
  const count = map.w <= 96 ? 2 : 3;
  const sides = rng.shuffle([0, 1, 2, 3]);
  const length = 4;
  const { w, terrain } = map;
  const blocked = (x: number, y: number): boolean => {
    if (!map.inBounds(x, y)) return true;
    const t = terrain[y * w + x];
    return t === Terrain.Water || t === Terrain.Mountain;
  };

  for (const side of sides) {
    if (map.outside.length >= count) break;
    const dir = INWARD_DIR[side];
    const px = -DY[dir];
    const py = DX[dir];
    const target = rng.range(0.35, 0.65);
    let best: [number, number] | null = null;
    let bestScore = Infinity;
    for (let t = 0.2; t <= 0.8; t += 0.01) {
      const [x, y] = edgePoint(map, side, t);
      let ok = true;
      for (let k = 0; k < length + 2 && ok; k++) {
        for (let s = -1; s <= 1 && ok; s++) {
          if (blocked(x + DX[dir] * k + px * s, y + DY[dir] * k + py * s)) ok = false;
        }
      }
      if (!ok) continue;
      const score = Math.abs(t - target);
      if (score < bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    if (!best) continue;
    const [x, y] = best;
    for (let k = 0; k < length + 1; k++) {
      for (let s = -1; s <= 1; s++) {
        const tx = x + DX[dir] * k + px * s;
        const ty = y + DY[dir] * k + py * s;
        if (map.inBounds(tx, ty)) terrain[ty * w + tx] = Terrain.Grass;
      }
    }
    map.outside.push({ id: map.outside.length, x, y, dir, length });
  }

  // Extremely unlikely fallback: force a connection on the first side.
  if (map.outside.length === 0) {
    const side = sides[0];
    const dir = INWARD_DIR[side];
    const [x, y] = edgePoint(map, side, 0.5);
    for (let k = 0; k < length + 1; k++) {
      const tx = clamp(x + DX[dir] * k, 0, map.w - 1);
      const ty = clamp(y + DY[dir] * k, 0, map.h - 1);
      terrain[ty * w + tx] = Terrain.Grass;
    }
    map.outside.push({ id: 0, x, y, dir, length });
  }
}
