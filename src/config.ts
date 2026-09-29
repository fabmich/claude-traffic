/**
 * All tunable constants live here.
 * Units: meters, seconds; speeds in m/s unless the name says km/h.
 */

/** Meters per grid tile. */
export const TILE = 24;
/** Width of one traffic lane in meters. */
export const LANE_W = 3.2;
/** Tiles per side of one cached render chunk. */
export const CHUNK = 16;

/** Simulated seconds per simulation step. */
export const SIM_DT = 0.1;
/** Upper bound of simulation steps per rendered frame (prevents spiral of death). */
export const MAX_STEPS_PER_FRAME = 16;
/** Game speed multipliers selectable in the UI (index 0 is x1). */
export const SPEED_LEVELS = [1, 2, 4] as const;
/** Simulated seconds that pass per real second at x1. */
export const TIME_SCALE = 1.5;
/** Simulated seconds in one game day (12 real minutes at x1). */
export const DAY_SECONDS = 1080;
/** Hour of day at which a new game starts. */
export const START_HOUR = 6;

export const MAP_SIZES = { small: 96, medium: 128, large: 192 } as const;
export type MapSizeKey = keyof typeof MAP_SIZES;

export const START_MONEY = 70_000;

/** Junction upgrade prices. */
export const SIGNAL_COST = 500;
export const ROUNDABOUT_COST = 1_200;
export const ROUNDABOUT_LARGE_COST = 3_000;

/** Population needed before these tools unlock (normal mode). */
export const UNLOCK = {
  signals: 300,
  roundabout: 300,
  roundaboutLarge: 2_500,
  buses: 1_000,
  truckBan: 1_000,
  busLane: 1_000,
} as const;

export const KMH = 1 / 3.6;
