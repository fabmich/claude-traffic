import { TILE } from '../config';
import { Terrain } from './terrain';

export interface OutsideConnection {
  id: number;
  /** Tile on the map edge where the connection leaves the map. */
  x: number;
  y: number;
  /** Direction (0..7) pointing from the edge into the map. */
  dir: number;
  /** Number of pre-built highway tiles, starting at the edge tile. */
  length: number;
}

/** Terrain grid of a generated map. */
export class WorldMap {
  readonly w: number;
  readonly h: number;
  readonly seed: number;
  /** Terrain id per tile. */
  readonly terrain: Uint8Array;
  /** Normalized height 0..1 per tile (used for mountain shading). */
  readonly height: Float32Array;
  /** Distance to land for water tiles, distance to water for land tiles (in tiles, capped). */
  readonly waterDist: Uint8Array;
  outside: OutsideConnection[] = [];

  constructor(w: number, h: number, seed: number) {
    this.w = w;
    this.h = h;
    this.seed = seed;
    this.terrain = new Uint8Array(w * h);
    this.height = new Float32Array(w * h);
    this.waterDist = new Uint8Array(w * h);
  }

  get tileCount(): number {
    return this.w * this.h;
  }

  get widthMeters(): number {
    return this.w * TILE;
  }

  get heightMeters(): number {
    return this.h * TILE;
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  terrainAt(x: number, y: number): number {
    return this.terrain[y * this.w + x];
  }

  isWater(x: number, y: number): boolean {
    return this.terrain[y * this.w + x] === Terrain.Water;
  }

  isMountain(x: number, y: number): boolean {
    return this.terrain[y * this.w + x] === Terrain.Mountain;
  }

  countTerrain(): number[] {
    const counts = new Array(7).fill(0);
    for (let i = 0; i < this.terrain.length; i++) counts[this.terrain[i]]++;
    return counts;
  }
}
