import { World } from '../../src/game/World';
import { Zone } from '../../src/city/zones';
import { ROAD } from '../../src/roads/roadTypes';
import { generateMap } from '../../src/world/mapgen';
import { DX, DY } from '../../src/world/grid';
import { Terrain } from '../../src/world/terrain';

/** A flat map with a street grid connected to the first highway exit. */
export function makeTown(sandbox = true): { world: World; cx: number; cy: number } {
  const map = generateMap({ seed: 11, size: 96 });
  map.terrain.fill(Terrain.Grass);
  // Farmland and rich ground patches for farms and factories.
  const world = new World({ seed: 11, size: 96, cityName: 'T', sandbox }, map);
  const W = map.w;
  const oc = map.outside[0];
  const ex = oc.x + DX[oc.dir] * oc.length;
  const ey = oc.y + DY[oc.dir] * oc.length;
  const road = (a: [number, number], b: [number, number], type: number = ROAD.street) => {
    const path: number[] = [];
    let [x, y] = a;
    path.push(y * W + x);
    while (x !== b[0] || y !== b[1]) {
      x += Math.sign(b[0] - x);
      y += Math.sign(b[1] - y);
      path.push(y * W + x);
    }
    const err = world.applyRoadPlan(world.planRoad(path, type, false));
    if (err && err !== 'Already built') throw new Error(err);
  };
  // Main road from the exit into the map.
  const cx = ex + DX[oc.dir] * 14;
  const cy = ey + DY[oc.dir] * 14;
  road([ex, ey], [cx, cy], ROAD.avenue);
  // A grid of streets around the centre.
  for (let k = -12; k <= 12; k += 6) {
    road([cx - 12, cy + k], [cx + 12, cy + k]);
    road([cx + k, cy - 12], [cx + k, cy + 12]);
  }
  for (let y = cy - 12; y <= cy + 12; y++) {
    for (let x = cx - 12; x <= cx + 12; x++) {
      const t = y * W + x;
      if (x > cx + 6 && y > cy) map.terrain[t] = Terrain.Farmland;
      if (x < cx - 6 && y > cy) map.terrain[t] = Terrain.Rich;
    }
  }
  const zone = (x0: number, y0: number, x1: number, y1: number, z: number) => {
    const tiles: number[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push(y * W + x);
    world.city.paintZone(tiles, z);
  };
  zone(cx - 12, cy - 12, cx + 12, cy - 1, Zone.Residential);
  zone(cx - 5, cy + 1, cx + 5, cy + 12, Zone.Commercial);
  zone(cx - 12, cy + 1, cx - 6, cy + 12, Zone.Industrial);
  zone(cx + 7, cy + 1, cx + 12, cy + 12, Zone.Farming);
  return { world, cx, cy };
}
