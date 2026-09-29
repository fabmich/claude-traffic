import { DX, DY } from '../../world/grid';

/** Tile path traced by dragging: follows the cursor tile by tile in 8 directions. */
export class TilePath {
  tiles: number[] = [];
  private startX = 0;
  private startY = 0;

  constructor(
    private w: number,
    private h: number,
  ) {}

  get start(): number {
    return this.tiles[0] ?? -1;
  }

  begin(tx: number, ty: number): void {
    this.startX = tx;
    this.startY = ty;
    this.tiles = [ty * this.w + tx];
  }

  clear(): void {
    this.tiles = [];
  }

  private clampX(x: number): number {
    return Math.max(0, Math.min(this.w - 1, x));
  }

  private clampY(y: number): number {
    return Math.max(0, Math.min(this.h - 1, y));
  }

  /** Extends the path towards (tx, ty) one 8-neighbour step at a time; stepping back undoes. */
  follow(tx: number, ty: number): void {
    tx = this.clampX(tx);
    ty = this.clampY(ty);
    for (let guard = 0; guard < 512; guard++) {
      const last = this.tiles[this.tiles.length - 1];
      const lx = last % this.w;
      const ly = (last - lx) / this.w;
      if (lx === tx && ly === ty) return;
      const nx = lx + Math.sign(tx - lx);
      const ny = ly + Math.sign(ty - ly);
      const next = ny * this.w + nx;
      if (this.tiles.length >= 2 && this.tiles[this.tiles.length - 2] === next) this.tiles.pop();
      else {
        const existing = this.tiles.indexOf(next);
        if (existing >= 0) this.tiles.length = existing + 1;
        else this.tiles.push(next);
      }
    }
  }

  /** Replaces the path with a straight 8-direction line from the start towards (tx, ty). */
  straight(tx: number, ty: number): void {
    const dx = tx - this.startX;
    const dy = ty - this.startY;
    if (dx === 0 && dy === 0) {
      this.tiles = [this.startY * this.w + this.startX];
      return;
    }
    const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    const d = (oct + 8) & 7;
    const n = d & 1 ? Math.round((Math.abs(dx) + Math.abs(dy)) / 2) : Math.max(Math.abs(dx), Math.abs(dy));
    const tiles: number[] = [];
    for (let k = 0; k <= n; k++) {
      const x = this.startX + DX[d] * k;
      const y = this.startY + DY[d] * k;
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) break;
      tiles.push(y * this.w + x);
    }
    this.tiles = tiles;
  }
}
