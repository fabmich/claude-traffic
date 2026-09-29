import type { Connector, Lane, Segment } from '../roads/network';
import type { VKindId } from './params';

/** One directed step of a route: a segment travelled forward (a -> b) or backward. */
export interface Leg {
  seg: Segment;
  forward: boolean;
}

/** Where a trip ends: a position along a directed segment, or the end of a lane (outside). */
export interface Destination {
  seg: Segment;
  forward: boolean;
  /** Arc length along lanes of that direction where the vehicle stops. */
  s: number;
  /** Tile the destination belongs to (for re-resolving after network edits). */
  tile: number;
  /** Destination is an outside connection: drive to the end of the lane. */
  outside: boolean;
}

export type TripHandler = (v: Vehicle, arrived: boolean) => void;

export class Vehicle {
  /** Index in the simulation's vehicle list (for O(1) removal). */
  listIndex = -1;
  // Parameters
  length = 4.5;
  width = 1.9;
  vMax = 36;
  aMax = 1.6;
  bComf = 2.5;
  T = 1.2;
  s0 = 2;
  politeness = 0.3;
  speedFactor = 1;
  color = '#e8594f';
  /** Random factor used to vary route costs per driver. */
  seed = 0;

  // Position: exactly one of lane / conn is set while driving.
  lane: Lane | null = null;
  conn: Connector | null = null;
  /** Previous element (for drawing the rear half of the body). */
  prevLane: Lane | null = null;
  prevConn: Connector | null = null;
  /** Arc length of the front bumper along the current element. */
  s = 0;
  v = 0;
  acc = 0;

  // Render state (interpolated between steps).
  x = 0;
  y = 0;
  heading = 0;
  px = 0;
  py = 0;
  pHeading = 0;
  /** Lateral offset (m) animating a lane change. */
  lat = 0;
  /** -1 in tunnel, 0 ground, 1 on bridge. */
  layer = 0;
  pathHint = 0;

  // Route
  route: Leg[] = [];
  routeIdx = 0;
  dest: Destination | null = null;
  /** Connector chosen at the upcoming junction. */
  nextConn: Connector | null = null;
  /** Connector this vehicle has been allowed to enter. */
  granted: Connector | null = null;
  needsReroute = false;
  lastRoute = 0;

  // Junction and lane-change state
  /** Distance from the front bumper to the stop line of the next junction. */
  distToStop = Infinity;
  waitTime = 0;
  stoppedAtLine = false;
  arrivalStamp = 0;
  laneChangeCooldown = 0;
  /** Lane this vehicle urgently wants to merge into. */
  mergeTarget: Lane | null = null;
  blockedTime = 0;

  // Trip bookkeeping
  onTrip: TripHandler | null = null;
  tripData: unknown = null;
  spawnTime = 0;
  /** Stored for route display. */
  distanceDriven = 0;

  constructor(
    readonly id: number,
    readonly kind: VKindId,
  ) {}

  get element(): Lane | Connector | null {
    return this.lane ?? this.conn;
  }

  get currentLeg(): Leg | undefined {
    return this.route[this.routeIdx];
  }

  get nextLeg(): Leg | undefined {
    return this.route[this.routeIdx + 1];
  }

  get braking(): boolean {
    return this.acc < -1.2 && this.v > 0.5;
  }
}
