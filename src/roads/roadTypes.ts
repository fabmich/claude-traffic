import { KMH, LANE_W } from '../config';

export interface RoadType {
  id: number;
  key: string;
  name: string;
  /** Lanes in the drag direction. */
  lanesF: number;
  /** Lanes against the drag direction (0 = one-way). */
  lanesB: number;
  speedKmh: number;
  /** Width of the central median in meters. */
  median: number;
  /** Sidewalk or shoulder width on each side in meters. */
  shoulder: number;
  /** Buildings can connect directly (driveways). */
  access: boolean;
  highway: boolean;
  /** Construction cost per tile. */
  cost: number;
  /** Upkeep per tile per game day. */
  upkeep: number;
  /** Population needed to unlock. */
  unlockPop: number;
  /** Road hierarchy used for automatic right of way (higher wins). */
  rank: number;
  asphalt: string;
  medianColor: string;
  edgeColor: string;
  description: string;
}

const T = (t: Omit<RoadType, 'id'>, id: number): RoadType => ({ ...t, id });

export const ROAD_TYPES: readonly RoadType[] = [
  // id 0 = no road (placeholder so ids index the array directly)
  T({ key: 'none', name: 'None', lanesF: 0, lanesB: 0, speedKmh: 0, median: 0, shoulder: 0, access: false, highway: false, cost: 0, upkeep: 0, unlockPop: 0, rank: 0, asphalt: '#000', medianColor: '#000', edgeColor: '#000', description: '' }, 0),
  T(
    {
      key: 'street',
      name: 'Street',
      lanesF: 1,
      lanesB: 1,
      speedKmh: 50,
      median: 0,
      shoulder: 1.6,
      access: true,
      highway: false,
      cost: 80,
      upkeep: 1.2,
      unlockPop: 0,
      rank: 1,
      asphalt: '#5f656d',
      medianColor: '#5f656d',
      edgeColor: '#d9d5cc',
      description: 'Two lanes, one each way. Buildings can connect.',
    },
    1,
  ),
  T(
    {
      key: 'oneway',
      name: 'One-way street',
      lanesF: 2,
      lanesB: 0,
      speedKmh: 50,
      median: 0,
      shoulder: 1.6,
      access: true,
      highway: false,
      cost: 100,
      upkeep: 1.5,
      unlockPop: 0,
      rank: 1,
      asphalt: '#5f656d',
      medianColor: '#5f656d',
      edgeColor: '#d9d5cc',
      description: 'Two lanes in the drag direction.',
    },
    2,
  ),
  T(
    {
      key: 'avenue',
      name: 'Avenue',
      lanesF: 2,
      lanesB: 2,
      speedKmh: 60,
      median: 1.0,
      shoulder: 1.6,
      access: true,
      highway: false,
      cost: 240,
      upkeep: 3.5,
      unlockPop: 300,
      rank: 2,
      asphalt: '#5a6068',
      medianColor: '#cfc9bc',
      edgeColor: '#d9d5cc',
      description: 'Four lanes with a small median.',
    },
    3,
  ),
  T(
    {
      key: 'boulevard',
      name: 'Boulevard',
      lanesF: 3,
      lanesB: 3,
      speedKmh: 70,
      median: 1.4,
      shoulder: 1.0,
      access: true,
      highway: false,
      cost: 420,
      upkeep: 6,
      unlockPop: 5000,
      rank: 3,
      asphalt: '#575d65',
      medianColor: '#9cc585',
      edgeColor: '#d9d5cc',
      description: 'Six lanes with a green median.',
    },
    4,
  ),
  T(
    {
      key: 'highway',
      name: 'Highway',
      lanesF: 2,
      lanesB: 2,
      speedKmh: 100,
      median: 2.0,
      shoulder: 1.2,
      access: false,
      highway: true,
      cost: 520,
      upkeep: 8,
      unlockPop: 2500,
      rank: 4,
      asphalt: '#50565e',
      medianColor: '#9cc585',
      edgeColor: '#50565e',
      description: 'Fast four-lane road. No driveways.',
    },
    5,
  ),
  T(
    {
      key: 'highway1',
      name: 'One-way highway',
      lanesF: 3,
      lanesB: 0,
      speedKmh: 110,
      median: 0,
      shoulder: 1.2,
      access: false,
      highway: true,
      cost: 480,
      upkeep: 7,
      unlockPop: 2500,
      rank: 4,
      asphalt: '#50565e',
      medianColor: '#50565e',
      edgeColor: '#50565e',
      description: 'Three fast lanes in the drag direction. Build two for a motorway.',
    },
    6,
  ),
  T(
    {
      key: 'ramp',
      name: 'Ramp',
      lanesF: 1,
      lanesB: 0,
      speedKmh: 70,
      median: 0,
      shoulder: 0.9,
      access: false,
      highway: true,
      cost: 160,
      upkeep: 2.4,
      unlockPop: 2500,
      rank: 3,
      asphalt: '#50565e',
      medianColor: '#50565e',
      edgeColor: '#50565e',
      description: 'One-lane one-way connector for interchanges.',
    },
    7,
  ),
];

export const ROAD = {
  street: 1,
  oneway: 2,
  avenue: 3,
  boulevard: 4,
  highway: 5,
  highway1: 6,
  ramp: 7,
} as const;

export const roadWidth = (t: RoadType): number => (t.lanesF + t.lanesB) * LANE_W + t.median + 2 * t.shoulder;
export const isOneWay = (t: RoadType): boolean => t.lanesB === 0;
export const defaultSpeed = (t: RoadType): number => t.speedKmh * KMH;

/** Cost multipliers for spans. */
export const BRIDGE_COST_MULT = 4;
export const TUNNEL_COST_MULT = 6;
export const MAX_BRIDGE_TILES = 8;
export const MAX_TUNNEL_TILES = 12;
