export const Terrain = {
  Grass: 0,
  Forest: 1,
  Sand: 2,
  Water: 3,
  Mountain: 4,
  Farmland: 5,
  Rich: 6,
} as const;
export type TerrainId = (typeof Terrain)[keyof typeof Terrain];

export interface TerrainInfo {
  name: string;
  /** Buildings and ground roads may be placed here. */
  buildable: boolean;
  description: string;
}

export const TERRAIN_INFO: readonly TerrainInfo[] = [
  { name: 'Grass', buildable: true, description: 'Open land. Good for any zone.' },
  { name: 'Forest', buildable: true, description: 'Trees are cleared when you build here.' },
  { name: 'Sand', buildable: true, description: 'Sandy shore. Buildable.' },
  { name: 'Water', buildable: false, description: 'River or lake. Cross it with a bridge.' },
  { name: 'Mountain', buildable: false, description: 'Rock. Cross it with a tunnel.' },
  { name: 'Farmland', buildable: true, description: 'Fertile soil. Farming zones only grow here.' },
  { name: 'Rich ground', buildable: true, description: 'Rich in raw materials. Factories here get a production bonus.' },
];

export const isBuildable = (t: number): boolean => TERRAIN_INFO[t]?.buildable ?? false;
