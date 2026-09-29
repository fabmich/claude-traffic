/**
 * 8-direction grid helpers. Screen coordinates: x grows right, y grows down.
 * Direction indices go clockwise starting east: E, SE, S, SW, W, NW, N, NE.
 */
export const DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;
export const DIR_NAMES = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const;
export const DIR_ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'] as const;

export const opposite = (d: number): number => (d + 4) & 7;
export const isDiagonal = (d: number): boolean => (d & 1) === 1;
/** Length of one step in direction d, in tiles. */
export const dirLength = (d: number): number => ((d & 1) === 1 ? Math.SQRT2 : 1);
/** Angle of direction d in radians (screen space, clockwise from east). */
export const dirAngle = (d: number): number => (d * Math.PI) / 4;

/** Direction from a delta of at most one tile in each axis, or -1. */
export function dirFromDelta(dx: number, dy: number): number {
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return -1;
}

/** Smallest absolute difference between two direction indices (0..4). */
export function dirDiff(a: number, b: number): number {
  const d = Math.abs(a - b) & 7;
  return d > 4 ? 8 - d : d;
}
