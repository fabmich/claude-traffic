import { CHUNK, KMH, LANE_W, TILE } from '../config';
import { angleDiff, cubicBezier, Polyline } from '../core/polyline';
import { DX, DY, dirDiff, opposite } from '../world/grid';
import type { OutsideConnection } from '../world/WorldMap';
import { computeConflicts } from './conflicts';
import { buildNodePolygon, computeArmTrims } from './junctionGeometry';
import { customPairs, defaultConnections, type LanePair } from './laneDefaults';
import { Connector, Lane, Network, RoadNode, Segment, type Arm } from './network';
import { ATTR_BUS_LANE, ATTR_TRUCK_BAN, type Link, type RoadLayer, type Span } from './roadLayer';
import { ROAD_TYPES, roadWidth, type RoadType } from './roadTypes';
import { buildRingSegments, planRoundabouts, ringLanePairs, ringNodePolygon } from './roundabout';
import { armsSignature, type JunctionSettings } from './settings';

export interface CompileInput {
  layer: RoadLayer;
  settings: JunctionSettings;
  outside: readonly OutsideConnection[];
  /** Geometry cache reused between compiles (only changed junctions are rebuilt). */
  cache?: CompileCache;
}

interface NodeCacheEntry {
  conns: Array<{ inDir: number; inIdx: number; outDir: number; outIdx: number; turn: number; path: Polyline; maxSpeed: number }>;
  conflicts: Array<[number, number, number, number, number]>;
  polygon: number[];
  curbs: number[][];
  gen: number;
}

interface SegCacheEntry {
  poly: Polyline;
  vertexS: number[];
  fwd: Polyline[];
  bwd: Polyline[];
  gen: number;
}

/** Cache of compiled junction and segment geometry keyed by exact signatures. */
export class CompileCache {
  nodes = new Map<string, NodeCacheEntry>();
  segs = new Map<string, SegCacheEntry>();
  gen = 0;
  hits = 0;
  misses = 0;

  /** Drops entries that were not used by the latest compile. */
  prune(): void {
    for (const [k, v] of this.nodes) if (v.gen !== this.gen) this.nodes.delete(k);
    for (const [k, v] of this.segs) if (v.gen !== this.gen) this.segs.delete(k);
  }
}

function nodeSignature(node: RoadNode, settings: JunctionSettings): string {
  let s = `${node.key}|${node.control}|${node.outside ? 1 : 0}|`;
  for (const a of node.arms) {
    s += `${a.dir},${a.trim.toFixed(3)},${a.halfWidth},${a.nIn},${a.nOut};`;
    for (const l of a.ins) s += `i${l.path.x1.toFixed(2)},${l.path.y1.toFixed(2)},${l.path.endHeading().toFixed(3)},${l.speedLimit.toFixed(2)};`;
    for (const l of a.outs) s += `o${l.path.x0.toFixed(2)},${l.path.y0.toFixed(2)},${l.path.startHeading().toFixed(3)},${l.speedLimit.toFixed(2)};`;
  }
  const js = settings.get(node.tile);
  if (js?.lanes) s += JSON.stringify(js.lanes) + (js.lanesSig ?? '');
  return s;
}

interface Piece {
  from: number;
  to: number;
  dir: number;
  span: Span | null;
  steps: number;
  edge: number;
}

interface Draft {
  tiles: number[];
  pieces: Piece[];
  type: number;
  /** One-way flow seen from the first tile: 1 along the draft, -1 against, 0 two-way. */
  flow: number;
  speed: number;
  attr: number;
}

/** Comfortable lateral acceleration in turns (m/s²). */
const A_LAT = 2.2;

const oneWayType = (t: number): boolean => ROAD_TYPES[t].lanesB === 0;

function needsNode(t: number, ls: Link[], outside: Map<number, OutsideConnection>, settings: JunctionSettings): boolean {
  if (ls.length !== 2) return true;
  if (outside.has(t) || settings.forcesNode(t)) return true;
  const [p, q] = ls;
  if (p.type !== q.type || p.speed !== q.speed || p.attr !== q.attr) return true;
  if (oneWayType(p.type) && p.flow === q.flow) return true;
  if (dirDiff(p.dir, q.dir) < 2) return true;
  return false;
}

function canonicalize(d: Draft): void {
  const sT = d.tiles[0];
  const sD = d.pieces[0].dir;
  const eT = d.tiles[d.tiles.length - 1];
  const eD = opposite(d.pieces[d.pieces.length - 1].dir);
  if (eT < sT || (eT === sT && eD < sD)) {
    d.tiles.reverse();
    d.pieces = d.pieces.reverse().map((p) => ({ from: p.to, to: p.from, dir: opposite(p.dir), span: p.span, steps: p.steps, edge: p.edge }));
    d.flow = -d.flow;
  }
}

const unitX = (d: number): number => DX[d] / (d & 1 ? Math.SQRT2 : 1);
const unitY = (d: number): number => DY[d] / (d & 1 ? Math.SQRT2 : 1);
const stepMeters = (d: number): number => (d & 1 ? Math.SQRT2 : 1) * TILE;

/** Centreline through tile centres with rounded corners; also returns arc length at each vertex. */
function buildCenterline(d: Draft, W: number, trimA: number, trimB: number): { poly: Polyline; vertexS: number[] } {
  const k = d.pieces.length;
  const cx = (t: number): number => ((t % W) + 0.5) * TILE;
  const cy = (t: number): number => (Math.floor(t / W) + 0.5) * TILE;
  const pts: number[] = [];
  const vIdx: number[] = [];
  const push = (x: number, y: number): void => {
    const n = pts.length;
    if (n >= 2 && Math.abs(pts[n - 2] - x) < 1e-6 && Math.abs(pts[n - 1] - y) < 1e-6) return;
    pts.push(x, y);
  };
  push(cx(d.tiles[0]), cy(d.tiles[0]));
  vIdx.push(0);
  for (let i = 1; i < k; i++) {
    const pin = d.pieces[i - 1];
    const pout = d.pieces[i];
    const vx = cx(d.tiles[i]);
    const vy = cy(d.tiles[i]);
    if (pin.dir === pout.dir) {
      push(vx, vy);
      vIdx.push(pts.length / 2 - 1);
      continue;
    }
    const lin = pin.steps * stepMeters(pin.dir);
    const lout = pout.steps * stepMeters(pout.dir);
    const availIn = i - 1 === 0 ? lin - trimA - 0.5 : lin / 2;
    const availOut = i === k - 1 ? lout - trimB - 0.5 : lout / 2;
    const t = Math.max(0, Math.min(TILE * 0.5, availIn, availOut));
    if (t < 0.3) {
      push(vx, vy);
      vIdx.push(pts.length / 2 - 1);
      continue;
    }
    const ax = vx - unitX(pin.dir) * t;
    const ay = vy - unitY(pin.dir) * t;
    const bx = vx + unitX(pout.dir) * t;
    const by = vy + unitY(pout.dir) * t;
    const steps = dirDiff(pin.dir, pout.dir) >= 2 ? 8 : 6;
    let mid = 0;
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const w = 1 - u;
      push(w * w * ax + 2 * w * u * vx + u * u * bx, w * w * ay + 2 * w * u * vy + u * u * by);
      if (s === steps / 2) mid = pts.length / 2 - 1;
    }
    vIdx.push(mid);
  }
  const last = d.tiles[d.tiles.length - 1];
  push(cx(last), cy(last));
  vIdx.push(pts.length / 2 - 1);
  const poly = Polyline.fromFlat(pts);
  return { poly, vertexS: vIdx.map((i) => poly.cum[i]) };
}

function connectorPath(from: Lane, to: Lane, turn: number): Polyline {
  const p = from.path;
  const q = to.path;
  const x0 = p.x1;
  const y0 = p.y1;
  const x3 = q.x0;
  const y3 = q.y0;
  const h0 = p.endHeading();
  const h3 = q.startHeading();
  const d = Math.hypot(x3 - x0, y3 - y0);
  const theta = Math.abs(angleDiff(h0, h3));
  let k: number;
  if (turn === 4 && theta > 2.5) {
    k = Math.max(d * 0.75, 2.5);
  } else if (theta < 0.02) {
    k = d / 3;
  } else {
    const R = d / (2 * Math.sin(Math.min(theta, Math.PI - 0.01) / 2));
    k = (4 / 3) * Math.tan(theta / 4) * R;
  }
  const segs = Math.max(6, Math.ceil(theta / (Math.PI / 14)) + 4);
  return cubicBezier(x0, y0, x0 + Math.cos(h0) * k, y0 + Math.sin(h0) * k, x3 - Math.cos(h3) * k, y3 - Math.sin(h3) * k, x3, y3, segs);
}

/** Compiles the editable road layer into a simulation-ready network. */
export function compileNetwork(input: CompileInput): Network {
  const { layer, settings, cache } = input;
  if (cache) cache.gen++;
  const W = layer.w;
  const net = new Network(layer.n);
  net.version = layer.version;
  const spanIdx = layer.spanIndex();
  const outsideByTile = new Map<number, OutsideConnection>();
  for (const oc of input.outside) outsideByTile.set(oc.y * W + oc.x, oc);

  // 1. Vertices and their links.
  const vertexSet = new Set<number>();
  for (let e = 0; e < layer.type.length; e++) {
    if (layer.type[e] === 0) continue;
    const t = e >> 2;
    vertexSet.add(t);
    vertexSet.add(layer.neighbor(t, e & 3));
  }
  for (const s of layer.spans.values()) {
    vertexSet.add(s.a);
    vertexSet.add(s.b);
  }
  const vertices = [...vertexSet].sort((a, b) => a - b);
  const links = new Map<number, Link[]>();
  for (const t of vertices) links.set(t, layer.links(t, oneWayType, spanIdx));

  // 2. Node tiles.
  const isNode = new Set<number>();
  for (const t of vertices) if (needsNode(t, links.get(t)!, outsideByTile, settings)) isNode.add(t);

  // 3. Walk segments between nodes.
  const visitedEdge = new Uint8Array(layer.n * 4);
  const visitedSpan = new Set<number>();
  const visited = (l: Link): boolean => (l.span ? visitedSpan.has(l.span.id) : visitedEdge[l.edge] === 1);
  const mark = (l: Link): void => {
    if (l.span) visitedSpan.add(l.span.id);
    else visitedEdge[l.edge] = 1;
  };
  const drafts: Draft[] = [];
  const walk = (start: number, first: Link): Draft => {
    const tiles = [start];
    const pieces: Piece[] = [];
    let cur = start;
    let link = first;
    for (let guard = 0; guard < 1_000_000; guard++) {
      mark(link);
      pieces.push({ from: cur, to: link.to, dir: link.dir, span: link.span, steps: link.span ? link.span.len : 1, edge: link.edge });
      tiles.push(link.to);
      const next = link.to;
      if (isNode.has(next)) break;
      const back = opposite(link.dir);
      const prevSpan = link.span;
      const other = links.get(next)!.find((l) => !(l.dir === back && l.span === prevSpan));
      if (!other || visited(other)) break;
      cur = next;
      link = other;
    }
    return { tiles, pieces, type: first.type, flow: first.flow, speed: first.speed, attr: first.attr };
  };
  for (const t of vertices) {
    if (!isNode.has(t)) continue;
    for (const l of links.get(t)!) if (!visited(l)) drafts.push(walk(t, l));
  }
  for (const t of vertices) {
    const ls = links.get(t)!;
    if (ls.some((l) => !visited(l))) {
      isNode.add(t);
      for (const l of ls) if (!visited(l)) drafts.push(walk(t, l));
    }
  }

  // Safety: every draft must start and end at a node.
  for (const d of drafts) {
    isNode.add(d.tiles[0]);
    isNode.add(d.tiles[d.tiles.length - 1]);
  }

  // 4. Nodes.
  for (const t of vertices) {
    if (!isNode.has(t)) continue;
    const node = new RoadNode(net.nodes.length, t, ((t % W) + 0.5) * TILE, (Math.floor(t / W) + 0.5) * TILE);
    node.outside = outsideByTile.get(t) ?? null;
    const js = settings.get(t);
    if (js?.control) node.control = js.control;
    net.nodes.push(node);
    net.nodeByTile.set(t, node);
  }

  // 5. Arms.
  for (const d of drafts) canonicalize(d);
  drafts.sort((p, q) => p.tiles[0] - q.tiles[0] || p.pieces[0].dir - q.pieces[0].dir);
  interface Build {
    d: Draft;
    type: RoadType;
    a: RoadNode;
    b: RoadNode;
    armA: Arm;
    armB: Arm;
    nF: number;
    nB: number;
  }
  const builds: Build[] = [];
  for (const d of drafts) {
    const type = ROAD_TYPES[d.type];
    const a = net.nodeByTile.get(d.tiles[0])!;
    const b = net.nodeByTile.get(d.tiles[d.tiles.length - 1])!;
    let nF = type.lanesF;
    let nB = type.lanesB;
    if (nB === 0) {
      if (d.flow < 0) {
        nB = nF;
        nF = 0;
      }
    }
    const hw = roadWidth(type) / 2;
    const dirA = d.pieces[0].dir;
    const dirB = opposite(d.pieces[d.pieces.length - 1].dir);
    const mk = (node: RoadNode, dir: number, atStart: boolean, nIn: number, nOut: number): Arm => ({
      node,
      dir,
      segment: null as unknown as Segment,
      atStart,
      ins: [],
      outs: [],
      trim: 0,
      halfWidth: hw,
      ux: unitX(dir),
      uy: unitY(dir),
      nIn,
      nOut,
    });
    const armA = mk(a, dirA, true, nB, nF);
    const armB = mk(b, dirB, false, nF, nB);
    a.arms.push(armA);
    b.arms.push(armB);
    builds.push({ d, type, a, b, armA, armB, nF, nB });
  }
  for (const node of net.nodes) {
    node.arms.sort((p, q) => p.dir - q.dir);
    computeArmTrims(node);
  }

  // 5b. Roundabouts become rings of small merge/diverge junctions.
  const rings = planRoundabouts(net.nodes, settings);
  if (rings.plans.length) {
    net.nodes = rings.nodes;
    for (const p of rings.plans) net.nodeByTile.delete(p.center.tile);
    for (const bd of builds) {
      bd.a = bd.armA.node;
      bd.b = bd.armB.node;
    }
  }

  // 6. Segments and lanes.
  for (const bd of builds) {
    const { d, type, armA, armB, nF, nB } = bd;
    const segSig = `${d.tiles.join(',')}|${d.pieces.map((p) => p.dir).join('')}|${type.id}|${armA.trim.toFixed(3)}|${armB.trim.toFixed(3)}|${nF}/${nB}`;
    let cached = cache?.segs.get(segSig);
    let poly: Polyline;
    let vertexS: number[];
    if (cached) {
      poly = cached.poly;
      vertexS = cached.vertexS;
    } else {
      ({ poly, vertexS } = buildCenterline(d, W, armA.trim, armB.trim));
    }
    const L = poly.length;
    let tA = armA.trim;
    let tB = armB.trim;
    const minLen = 1.0;
    if (tA + tB > L - minLen) {
      const f = Math.max(0, L - minLen) / (tA + tB);
      tA *= f;
      tB *= f;
    }
    armA.trim = tA;
    armB.trim = tB;
    const speed = d.speed > 0 ? d.speed * KMH : type.speedKmh * KMH;
    const key = `${d.tiles[0]}:${d.pieces[0].dir}`;
    const seg = new Segment(
      net.segments.length,
      key,
      type,
      bd.a,
      bd.b,
      d.tiles,
      poly,
      tA,
      tB,
      speed,
      (d.attr & ATTR_TRUCK_BAN) !== 0,
      (d.attr & ATTR_BUS_LANE) !== 0,
    );
    armA.segment = seg;
    armB.segment = seg;
    net.segments.push(seg);
    net.segByKey.set(key, seg);
    d.pieces.forEach((p, j) => {
      if (p.span) {
        net.segBySpan.set(p.span.id, seg.id);
        seg.spanIds.push(p.span.id);
        seg.spanRanges.push({ kind: p.span.kind, spanId: p.span.id, s0: vertexS[j], s1: vertexS[j + 1] });
      } else if (p.edge >= 0) {
        net.segByEdge[p.edge] = seg.id;
        seg.edges.push(p.edge);
      }
    });

    const med = type.median;
    if (!cached) {
      const cut = poly.slice(tA, L - tB);
      const rc = cut.reverse();
      const fwd: Polyline[] = [];
      const bwd: Polyline[] = [];
      for (let k = 0; k < nF; k++) fwd.push(cut.offset(nB > 0 ? med / 2 + (nF - k - 0.5) * LANE_W : ((nF - 1) / 2 - k) * LANE_W));
      for (let k = 0; k < nB; k++) bwd.push(rc.offset(nF > 0 ? med / 2 + (nB - k - 0.5) * LANE_W : ((nB - 1) / 2 - k) * LANE_W));
      cached = { poly, vertexS, fwd, bwd, gen: 0 };
      cache?.segs.set(segSig, cached);
    }
    cached.gen = cache?.gen ?? 0;
    for (let k = 0; k < nF; k++) {
      const off = nB > 0 ? med / 2 + (nF - k - 0.5) * LANE_W : ((nF - 1) / 2 - k) * LANE_W;
      const lane = new Lane(net.lanes.length, `${key}|F${k}`, seg, true, k, off, cached.fwd[k], speed);
      net.lanes.push(lane);
      seg.forward.push(lane);
    }
    for (let k = 0; k < nB; k++) {
      const off = nF > 0 ? med / 2 + (nB - k - 0.5) * LANE_W : ((nB - 1) / 2 - k) * LANE_W;
      const lane = new Lane(net.lanes.length, `${key}|B${k}`, seg, false, k, off, cached.bwd[k], speed);
      net.lanes.push(lane);
      seg.backward.push(lane);
    }
    for (const list of [seg.forward, seg.backward]) {
      for (let k = 0; k < list.length; k++) {
        const lane = list[k];
        lane.left = list[k + 1] ?? null;
        lane.right = list[k - 1] ?? null;
        lane.busOnly = seg.busLane && list.length >= 2 && k === 0;
        net.laneByKey.set(lane.key, lane);
      }
    }
    for (const lane of seg.forward) {
      lane.fromNode = bd.a;
      lane.toNode = bd.b;
      lane.fromArm = armA;
      lane.toArm = armB;
    }
    for (const lane of seg.backward) {
      lane.fromNode = bd.b;
      lane.toNode = bd.a;
      lane.fromArm = armB;
      lane.toArm = armA;
    }
    armA.outs = seg.forward;
    armA.ins = seg.backward;
    armB.ins = seg.forward;
    armB.outs = seg.backward;
    const bb = poly.bbox();
    const pad = roadWidth(type) / 2 + 2;
    seg.bbox = { x0: bb.x0 - pad, y0: bb.y0 - pad, x1: bb.x1 + pad, y1: bb.y1 + pad };
  }
  for (const p of rings.plans) {
    buildRingSegments(net, p);
    for (const s of p.subs) s.arms.sort((x, y) => x.dir - y.dir);
  }

  // 7. Junction connectors, conflicts and outlines.
  for (const node of net.nodes) {
    const sig = cache ? nodeSignature(node, settings) : '';
    const hit = cache?.nodes.get(sig);
    if (hit) {
      cache!.hits++;
      hit.gen = cache!.gen;
      restoreConnectors(net, node, hit);
      continue;
    }
    if (node.ringOf !== null) {
      addPairs(net, node, ringLanePairs(node));
      computeConflicts(node);
      node.polygon = ringNodePolygon(node, net.roundabouts.get(node.ringOf)?.halfWidth ?? 3);
      node.curbs = [];
    } else {
      buildConnectors(net, node, settings);
      computeConflicts(node);
      const outline = buildNodePolygon(node);
      node.polygon = outline.polygon;
      node.curbs = outline.curbs;
    }
    if (cache) {
      cache.misses++;
      const index = new Map(node.connectors.map((c, i) => [c, i]));
      const conflicts: Array<[number, number, number, number, number]> = [];
      node.connectors.forEach((c, i) => {
        for (const x of c.conflicts) {
          const j = index.get(x.other)!;
          if (j > i) conflicts.push([i, j, x.s, x.sOther, x.kind === 'merge' ? 1 : 0]);
        }
      });
      cache.nodes.set(sig, {
        conns: node.connectors.map((c) => ({ inDir: c.inArm.dir, inIdx: c.from.index, outDir: c.outArm.dir, outIdx: c.to.index, turn: c.turn, path: c.path, maxSpeed: c.maxSpeed })),
        conflicts,
        polygon: node.polygon,
        curbs: node.curbs,
        gen: cache.gen,
      });
    }
  }
  cache?.prune();

  // 8. Spatial index per render chunk.
  const cols = Math.ceil(layer.w / CHUNK);
  const span = CHUNK * TILE;
  const addTo = <T>(map: Map<number, T[]>, x0: number, y0: number, x1: number, y1: number, item: T): void => {
    const cx0 = Math.max(0, Math.floor(x0 / span));
    const cy0 = Math.max(0, Math.floor(y0 / span));
    const cx1 = Math.floor(x1 / span);
    const cy1 = Math.floor(y1 / span);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cy * cols + cx;
        let list = map.get(k);
        if (!list) map.set(k, (list = []));
        list.push(item);
      }
    }
  };
  for (const seg of net.segments) addTo(net.chunkSegs, seg.bbox.x0, seg.bbox.y0, seg.bbox.x1, seg.bbox.y1, seg);
  for (const node of net.nodes) {
    const r = TILE * 1.6;
    addTo(net.chunkNodes, node.x - r, node.y - r, node.x + r, node.y + r, node);
  }
  return net;
}

function restoreConnectors(net: Network, node: RoadNode, e: NodeCacheEntry): void {
  for (const cd of e.conns) {
    const inArm = node.armByDir(cd.inDir)!;
    const outArm = node.armByDir(cd.outDir)!;
    const from = inArm.ins[cd.inIdx];
    const to = outArm.outs[cd.outIdx];
    const key = `${node.key}|${cd.inDir}.${cd.inIdx}>${cd.outDir}.${cd.outIdx}`;
    const c = new Connector(net.connectors.length, key, node, from, to, inArm, outArm, cd.turn, cd.path, cd.maxSpeed);
    net.connectors.push(c);
    net.connectorByKey.set(key, c);
    node.connectors.push(c);
    from.outs.push(c);
    to.ins.push(c);
  }
  for (const [i, j, sa, sb, kind] of e.conflicts) {
    const a = node.connectors[i];
    const b = node.connectors[j];
    const k = kind === 1 ? 'merge' : 'cross';
    a.conflicts.push({ other: b, s: sa, sOther: sb, kind: k, yields: false });
    b.conflicts.push({ other: a, s: sb, sOther: sa, kind: k, yields: false });
  }
  node.polygon = e.polygon;
  node.curbs = e.curbs;
}

/** Creates the connectors of a node from default arrows and user lane overrides. */
export function buildConnectors(net: Network, node: RoadNode, settings: JunctionSettings): void {
  const js = settings.get(node.tile);
  // Lane overrides only apply while the junction keeps the layout they were made for.
  const custom = js?.lanes && (!js.lanesSig || js.lanesSig === armsSignature(node.arms)) ? js.lanes : undefined;
  let pairs: LanePair[] = defaultConnections(node);
  if (custom) {
    const overridden = new Set<Lane>();
    const extra: LanePair[] = [];
    for (const [k, targets] of Object.entries(custom)) {
      const [dirStr, idxStr] = k.split(':');
      const inArm = node.armByDir(Number(dirStr));
      if (!inArm) continue;
      const lane = inArm.ins[Number(idxStr)];
      if (!lane) continue;
      overridden.add(lane);
      extra.push(...customPairs(node, inArm, Number(idxStr), targets));
    }
    pairs = pairs.filter((p) => !overridden.has(p.from)).concat(extra);
  }
  addPairs(net, node, pairs);
}

/** Creates connector objects (geometry, speed) for lane pairs of a node. */
export function addPairs(net: Network, node: RoadNode, pairs: LanePair[]): void {
  const seen = new Set<string>();
  for (const p of pairs) {
    const key = `${node.key}|${p.inArm.dir}.${p.from.index}>${p.outArm.dir}.${p.to.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = connectorPath(p.from, p.to, p.turn);
    const r = path.minRadius();
    const vCurve = Number.isFinite(r) ? Math.sqrt(A_LAT * r) : Infinity;
    const maxSpeed = Math.max(2.5, Math.min(p.from.speedLimit, p.to.speedLimit, vCurve));
    const c = new Connector(net.connectors.length, key, node, p.from, p.to, p.inArm, p.outArm, p.turn, path, maxSpeed);
    net.connectors.push(c);
    net.connectorByKey.set(key, c);
    node.connectors.push(c);
    p.from.outs.push(c);
    p.to.ins.push(c);
  }
}
