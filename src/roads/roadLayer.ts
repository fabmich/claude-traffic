import { DX, DY, opposite } from '../world/grid';

export type SpanKind = 'bridge' | 'tunnel';

/** A straight elevated (bridge) or underground (tunnel) road between two ground tiles. */
export interface Span {
  id: number;
  kind: SpanKind;
  /** Endpoint tiles (tile indices). */
  a: number;
  b: number;
  /** Direction from a to b (0..7). */
  dir: number;
  /** Number of steps between a and b. */
  len: number;
  type: number;
  /** Bit 0: one-way traffic flows b -> a instead of a -> b. */
  flags: number;
  speed: number;
  attr: number;
}

export const EDGE_ONEWAY_REV = 1;
export const ATTR_TRUCK_BAN = 1;
export const ATTR_BUS_LANE = 2;

/** A connection leaving a tile: a ground edge or a span. */
export interface Link {
  dir: number;
  /** Neighbour tile at the other end. */
  to: number;
  type: number;
  /** Traffic direction relative to this link: 0 both, 1 outgoing only, -1 incoming only. */
  flow: number;
  speed: number;
  attr: number;
  /** Canonical edge index for ground edges, or -1. */
  edge: number;
  span: Span | null;
}

/**
 * Editable road layer: ground edges between 8-neighbour tiles stored per tile in 4 canonical
 * directions (E, SE, S, SW), plus straight spans (bridges and tunnels).
 */
export class RoadLayer {
  readonly w: number;
  readonly h: number;
  readonly n: number;
  readonly type: Uint8Array;
  readonly flags: Uint8Array;
  readonly speed: Uint8Array;
  readonly attr: Uint8Array;
  readonly spans = new Map<number, Span>();
  /** Span ids covering a tile (not counting endpoints), per kind. */
  readonly bridgeCover: Int32Array;
  readonly tunnelCover: Int32Array;
  /** Edges that cannot be removed (outside connections). */
  readonly protectedEdges = new Set<number>();
  private nextSpanId = 1;
  version = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.type = new Uint8Array(this.n * 4);
    this.flags = new Uint8Array(this.n * 4);
    this.speed = new Uint8Array(this.n * 4);
    this.attr = new Uint8Array(this.n * 4);
    this.bridgeCover = new Int32Array(this.n).fill(-1);
    this.tunnelCover = new Int32Array(this.n).fill(-1);
  }

  neighbor(tile: number, dir: number): number {
    const x = tile % this.w;
    const y = (tile - x) / this.w;
    const nx = x + DX[dir];
    const ny = y + DY[dir];
    if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) return -1;
    return ny * this.w + nx;
  }

  /** Canonical edge index for the connection from `tile` in direction `dir`, or -1 if off-map. */
  edgeIndex(tile: number, dir: number): number {
    if (dir < 4) return this.neighbor(tile, dir) < 0 ? -1 : tile * 4 + dir;
    const nb = this.neighbor(tile, dir);
    return nb < 0 ? -1 : nb * 4 + (dir - 4);
  }

  edgeType(tile: number, dir: number): number {
    const e = this.edgeIndex(tile, dir);
    return e < 0 ? 0 : this.type[e];
  }

  /** Traffic flow of the edge as seen from `tile` going in `dir`: 0 both, 1 out, -1 in. */
  edgeFlow(tile: number, dir: number, oneWay: boolean): number {
    if (!oneWay) return 0;
    const e = this.edgeIndex(tile, dir);
    const rev = (this.flags[e] & EDGE_ONEWAY_REV) !== 0;
    const forward = dir < 4 ? !rev : rev;
    return forward ? 1 : -1;
  }

  /** Sets a ground edge. `flowOut` = true means one-way traffic flows from tile in dir. */
  setEdge(tile: number, dir: number, type: number, flowOut = true, speed = 0, attr = 0): void {
    const e = this.edgeIndex(tile, dir);
    if (e < 0) return;
    this.type[e] = type;
    const forward = dir < 4 ? flowOut : !flowOut;
    this.flags[e] = forward ? 0 : EDGE_ONEWAY_REV;
    this.speed[e] = speed;
    this.attr[e] = attr;
    this.version++;
  }

  removeEdge(tile: number, dir: number): void {
    const e = this.edgeIndex(tile, dir);
    if (e < 0) return;
    this.type[e] = 0;
    this.flags[e] = 0;
    this.speed[e] = 0;
    this.attr[e] = 0;
    this.version++;
  }

  /** True if a diagonal edge from tile in dir would cross an existing opposite diagonal. */
  diagonalBlocked(tile: number, dir: number): boolean {
    if ((dir & 1) === 0) return false;
    // The crossing diagonal connects the two side tiles of this 2x2 block.
    const side1 = this.neighbor(tile, (dir + 7) & 7); // rotate -45
    const side2 = this.neighbor(tile, (dir + 1) & 7); // rotate +45
    if (side1 < 0 || side2 < 0) return false;
    // Direction from side1 to side2.
    const x1 = side1 % this.w;
    const y1 = (side1 - x1) / this.w;
    const x2 = side2 % this.w;
    const y2 = (side2 - x2) / this.w;
    const ddx = x2 - x1;
    const ddy = y2 - y1;
    for (let d = 1; d < 8; d += 2) {
      if (DX[d] === ddx && DY[d] === ddy) return this.edgeType(side1, d) !== 0;
    }
    return false;
  }

  addSpan(s: Omit<Span, 'id'>): Span {
    const span: Span = { ...s, id: this.nextSpanId++ };
    this.spans.set(span.id, span);
    const cover = span.kind === 'bridge' ? this.bridgeCover : this.tunnelCover;
    let t = span.a;
    for (let k = 1; k < span.len; k++) {
      t = this.neighbor(t, span.dir);
      cover[t] = span.id;
    }
    this.version++;
    return span;
  }

  removeSpan(id: number): void {
    const span = this.spans.get(id);
    if (!span) return;
    const cover = span.kind === 'bridge' ? this.bridgeCover : this.tunnelCover;
    let t = span.a;
    for (let k = 1; k < span.len; k++) {
      t = this.neighbor(t, span.dir);
      if (cover[t] === id) cover[t] = -1;
    }
    this.spans.delete(id);
    this.version++;
  }

  /** Span starting at `tile` in direction `dir` (either end), if any. */
  spanAt(tile: number, dir: number): Span | null {
    for (const s of this.spans.values()) {
      if ((s.a === tile && s.dir === dir) || (s.b === tile && opposite(s.dir) === dir)) return s;
    }
    return null;
  }

  spansTouching(tile: number): Span[] {
    const out: Span[] = [];
    for (const s of this.spans.values()) if (s.a === tile || s.b === tile) out.push(s);
    return out;
  }

  /** Tiles covered by a span, excluding endpoints. */
  spanTiles(s: Span): number[] {
    const out: number[] = [];
    let t = s.a;
    for (let k = 1; k < s.len; k++) {
      t = this.neighbor(t, s.dir);
      out.push(t);
    }
    return out;
  }

  /** All links (edges and spans) leaving a tile, ordered by direction. */
  links(tile: number, oneWay: (type: number) => boolean, spanIndex?: Map<number, Span[]>): Link[] {
    const out: Link[] = [];
    for (let d = 0; d < 8; d++) {
      const e = this.edgeIndex(tile, d);
      if (e >= 0 && this.type[e] !== 0) {
        const type = this.type[e];
        out.push({
          dir: d,
          to: this.neighbor(tile, d),
          type,
          flow: this.edgeFlow(tile, d, oneWay(type)),
          speed: this.speed[e],
          attr: this.attr[e],
          edge: e,
          span: null,
        });
      }
    }
    const spans = spanIndex ? spanIndex.get(tile) ?? [] : this.spansTouching(tile);
    for (const s of spans) {
      const fromA = s.a === tile;
      const dir = fromA ? s.dir : opposite(s.dir);
      let flow = 0;
      if (oneWay(s.type)) {
        const aToB = (s.flags & EDGE_ONEWAY_REV) === 0;
        flow = aToB === fromA ? 1 : -1;
      }
      out.push({ dir, to: fromA ? s.b : s.a, type: s.type, flow, speed: s.speed, attr: s.attr, edge: -1, span: s });
    }
    out.sort((p, q) => p.dir - q.dir);
    return out;
  }

  /** Map from endpoint tile to spans, for fast lookups during compilation. */
  spanIndex(): Map<number, Span[]> {
    const m = new Map<number, Span[]>();
    for (const s of this.spans.values()) {
      if (!m.has(s.a)) m.set(s.a, []);
      if (!m.has(s.b)) m.set(s.b, []);
      m.get(s.a)!.push(s);
      m.get(s.b)!.push(s);
    }
    return m;
  }

  hasRoad(tile: number): boolean {
    for (let d = 0; d < 8; d++) if (this.edgeType(tile, d) !== 0) return true;
    for (const s of this.spans.values()) if (s.a === tile || s.b === tile) return true;
    return false;
  }

  hasGroundRoad(tile: number): boolean {
    for (let d = 0; d < 8; d++) if (this.edgeType(tile, d) !== 0) return true;
    return false;
  }
}
