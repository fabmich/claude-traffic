/** Vehicle kinds and their driving parameters (IDM + MOBIL). */
export const VKind = {
  Car: 0,
  Truck: 1,
  Bus: 2,
} as const;
export type VKindId = (typeof VKind)[keyof typeof VKind];

/** Bit masks used by routing restrictions. */
export const CLASS_BIT = [1, 2, 4] as const;

export interface KindParams {
  length: [number, number];
  width: number;
  /** Maximum speed of the vehicle itself (m/s). */
  vMax: number;
  /** Maximum acceleration (m/s²). */
  a: number;
  /** Comfortable deceleration (m/s²). */
  b: number;
  /** Desired time headway (s). */
  T: [number, number];
  /** Minimum standstill gap (m). */
  s0: number;
  politeness: number;
}

export const KIND_PARAMS: readonly KindParams[] = [
  { length: [4.2, 4.9], width: 1.9, vMax: 36, a: 1.7, b: 2.5, T: [1.0, 1.5], s0: 1.8, politeness: 0.3 },
  { length: [10.5, 13], width: 2.5, vMax: 25, a: 0.9, b: 2.0, T: [1.5, 1.9], s0: 2.4, politeness: 0.5 },
  { length: [11.5, 12], width: 2.5, vMax: 22, a: 1.0, b: 2.0, T: [1.3, 1.6], s0: 2.2, politeness: 0.6 },
];

export const CAR_COLORS = ['#e8594f', '#f2b134', '#3d8fe0', '#f7f7f2', '#34b37a', '#8e6fd8', '#2d3a45', '#e67fb1', '#9aa5ad', '#f08a3c', '#5cc0c8', '#c8d9e6'];
export const TRUCK_COLORS = ['#e8e4dc', '#d9cfb8', '#bfc8cf', '#e0a44a'];

/** Emergency deceleration limit (m/s²). */
export const B_MAX = 9;
