import { Terrain } from '../world/terrain';

export const Zone = {
  None: 0,
  Residential: 1,
  Commercial: 2,
  Industrial: 3,
  Farming: 4,
} as const;
export type ZoneId = (typeof Zone)[keyof typeof Zone];

export const ZONE_INFO = [
  { name: 'None', short: '', color: 'transparent', fill: 'transparent' },
  { name: 'Residential', short: 'R', color: '#4fb06d', fill: 'rgba(79, 176, 109, 0.30)' },
  { name: 'Commercial', short: 'C', color: '#3d8fe0', fill: 'rgba(61, 143, 224, 0.30)' },
  { name: 'Industrial', short: 'I', color: '#e0a030', fill: 'rgba(224, 160, 48, 0.32)' },
  { name: 'Farming', short: 'F', color: '#a8952a', fill: 'rgba(168, 149, 42, 0.30)' },
] as const;

/** Maximum distance (tiles) from a road at which land can be zoned. */
export const ZONE_DEPTH = 3;

/** Whether a tile's terrain allows a zone type. */
export function terrainAllows(zone: number, terrain: number): boolean {
  if (terrain === Terrain.Water || terrain === Terrain.Mountain) return false;
  if (zone === Zone.Farming) return terrain === Terrain.Farmland;
  return true;
}
