import type { Polyline } from '../core/polyline';
import type { Vehicle } from '../sim/vehicle';
import type { OutsideConnection } from '../world/WorldMap';
import type { RoadType } from './roadTypes';
import type { SpanKind } from './roadLayer';

/** Turn index k = (outDir - travelDir) mod 8: 0 straight, 1-3 right, 4 U-turn, 5-7 left. */
export type TurnIndex = number;

export const TURN_NAMES = ['straight', 'slight right', 'right', 'sharp right', 'U-turn', 'sharp left', 'left', 'slight left'];
export const isRightTurn = (k: number): boolean => k >= 1 && k <= 3;
export const isLeftTurn = (k: number): boolean => k >= 5 && k <= 7;

export class Lane {
  /** Vehicles on this lane ordered from the front (largest s) to the back. */
  vehicles: Vehicle[] = [];
  outs: Connector[] = [];
  ins: Connector[] = [];
  /** Neighbouring lane towards the median (index + 1) and towards the curb (index - 1). */
  left: Lane | null = null;
  right: Lane | null = null;
  fromNode!: RoadNode;
  toNode!: RoadNode;
  /** Arm at the destination node through which this lane arrives. */
  toArm!: Arm;
  fromArm!: Arm;
  /** Traffic statistics (EMA of speed ratio, vehicle count) for routing and overlays. */
  statSpeed = 1;
  statFlow = 0;
  busOnly = false;

  constructor(
    readonly id: number,
    readonly key: string,
    readonly segment: Segment,
    /** True if travelling from segment.a to segment.b. */
    readonly forward: boolean,
    /** 0 = curb lane (rightmost in travel direction). */
    readonly index: number,
    readonly offset: number,
    readonly path: Polyline,
    public speedLimit: number,
  ) {}

  get length(): number {
    return this.path.length;
  }

  /** Lanes of the same segment and direction, curb first. */
  get siblings(): Lane[] {
    return this.forward ? this.segment.forward : this.segment.backward;
  }
}

export interface Conflict {
  other: Connector;
  /** Arc length along this connector / the other connector where paths meet. */
  s: number;
  sOther: number;
  /** 'cross' paths intersect; 'merge' both end in the same lane. */
  kind: 'cross' | 'merge';
  /** True if vehicles on this connector must give way to the other one (set by junction control). */
  yields: boolean;
}

export class Connector {
  conflicts: Conflict[] = [];
  /** Vehicles currently committed to or driving on this connector. */
  vehicles: Vehicle[] = [];
  /** Traffic signal group index for signalized junctions (-1 if none). */
  signalGroup = -1;

  constructor(
    readonly id: number,
    readonly key: string,
    readonly node: RoadNode,
    readonly from: Lane,
    readonly to: Lane,
    readonly inArm: Arm,
    readonly outArm: Arm,
    readonly turn: TurnIndex,
    readonly path: Polyline,
    readonly maxSpeed: number,
  ) {}

  get length(): number {
    return this.path.length;
  }
}

export interface Arm {
  node: RoadNode;
  /** Direction (0..7) from the node into the segment. */
  dir: number;
  segment: Segment;
  /** True if the segment starts (s = 0) at this node. */
  atStart: boolean;
  /** Lanes arriving at the node through this arm, curb first. */
  ins: Lane[];
  /** Lanes leaving the node through this arm, curb first. */
  outs: Lane[];
  /** Distance from node centre to where the segment's lanes begin. */
  trim: number;
  halfWidth: number;
  ux: number;
  uy: number;
  /** Number of incoming / outgoing lanes (known before lanes are built). */
  nIn: number;
  nOut: number;
}

export type ControlKind = 'auto' | 'priority' | 'allstop' | 'signals' | 'roundabout';

export class RoadNode {
  arms: Arm[] = [];
  connectors: Connector[] = [];
  /** Flat [x0, y0, x1, y1, ...] outline for rendering; curves are pre-sampled. */
  polygon: number[] = [];
  /** Curb polylines (flat x, y lists) between neighbouring arms. */
  curbs: number[][] = [];
  outside: OutsideConnection | null = null;
  control: ControlKind = 'auto';
  /** Radius of the roundabout ring centreline if this node is (part of) a roundabout. */
  ringRadius = 0;

  constructor(
    readonly id: number,
    readonly tile: number,
    readonly x: number,
    readonly y: number,
  ) {}

  get isDeadEnd(): boolean {
    return this.arms.length === 1 && !this.outside;
  }

  armByDir(dir: number): Arm | undefined {
    return this.arms.find((a) => a.dir === dir);
  }
}

export interface SpanRange {
  kind: SpanKind;
  spanId: number;
  /** Arc-length range along the untrimmed centreline. */
  s0: number;
  s1: number;
}

export class Segment {
  forward: Lane[] = [];
  backward: Lane[] = [];
  spanRanges: SpanRange[] = [];
  /** Canonical edge indices covered by this segment (ground edges). */
  edges: number[] = [];
  spanIds: number[] = [];
  bbox = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(
    readonly id: number,
    readonly key: string,
    readonly type: RoadType,
    readonly a: RoadNode,
    readonly b: RoadNode,
    /** Tile path from a to b (vertices, including both node tiles). */
    readonly tiles: number[],
    /** Untrimmed centreline from node a centre to node b centre. */
    readonly center: Polyline,
    readonly trimA: number,
    readonly trimB: number,
    public speedLimit: number,
    public truckBan: boolean,
    public busLane: boolean,
  ) {}

  get lanes(): Lane[] {
    return [...this.forward, ...this.backward];
  }

  /** Usable length between junction trims. */
  get length(): number {
    return Math.max(0, this.center.length - this.trimA - this.trimB);
  }
}

/** Compiled, simulation-ready road network. */
export class Network {
  nodes: RoadNode[] = [];
  segments: Segment[] = [];
  lanes: Lane[] = [];
  connectors: Connector[] = [];
  nodeByTile = new Map<number, RoadNode>();
  /** Segment id per canonical ground edge index (-1 = none). */
  segByEdge: Int32Array;
  segBySpan = new Map<number, number>();
  /** Segments and nodes per render chunk. */
  chunkSegs = new Map<number, Segment[]>();
  chunkNodes = new Map<number, RoadNode[]>();
  laneByKey = new Map<string, Lane>();
  connectorByKey = new Map<string, Connector>();
  segByKey = new Map<string, Segment>();
  version = 0;

  constructor(readonly tileCount: number) {
    this.segByEdge = new Int32Array(tileCount * 4).fill(-1);
  }

  /** Segment containing the road tile `tile` (not a node), or passing through it. */
  segmentAtEdge(edge: number): Segment | null {
    const id = this.segByEdge[edge];
    return id >= 0 ? this.segments[id] : null;
  }
}
