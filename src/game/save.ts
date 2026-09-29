import type { CitySave } from '../city/City';
import { b64ToBytes, bytesToB64, gunzipText, gzipText } from '../core/codec';
import type { RoadLayerSave } from '../roads/roadLayer';
import type { JunctionSetting } from '../roads/settings';
import type { TransitSave } from '../transit/Transit';
import { World, type NewGameOptions } from './World';

export const SAVE_VERSION = 1;

/** Everything needed to restore a game. The terrain is regenerated from the seed. */
export interface SaveGame {
  version: number;
  savedAt: number;
  options: NewGameOptions;
  clock: number;
  simTime: number;
  money: number;
  roads: RoadLayerSave;
  junctions: Array<[number, JunctionSetting]>;
  city: CitySave;
  transit: TransitSave;
  generator: { enabled: boolean; rate: number };
  camera?: { x: number; y: number; zoom: number };
}

/** Short description shown in the load dialog. */
export interface SaveMeta {
  id: string;
  name: string;
  population: number;
  money: number;
  day: number;
  sandbox: boolean;
  savedAt: number;
}

export function saveWorld(world: World): SaveGame {
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    options: { ...world.options },
    clock: world.clock.time,
    simTime: world.traffic.time,
    money: world.money,
    roads: world.roads.save(),
    junctions: world.junctions.save(),
    city: world.city.save(),
    transit: world.transit.save(),
    generator: { enabled: world.generator.enabled, rate: world.generator.rate },
  };
}

export function loadWorld(data: SaveGame): World {
  if (!data || typeof data !== 'object' || !data.options || !data.roads) throw new Error('This is not a Traffic City save file');
  if (data.version > SAVE_VERSION) throw new Error('This save was made with a newer version of the game');
  const world = new World(data.options);
  world.clock.time = data.clock;
  world.traffic.time = data.simTime;
  world.money = data.money;
  world.roads.load(data.roads);
  world.junctions.load(data.junctions);
  world.rebuildNetwork();
  world.city.load(data.city);
  world.transit.load(data.transit);
  world.generator.enabled = data.generator.enabled;
  world.generator.rate = data.generator.rate;
  return world;
}

export function metaOf(world: World, id: string): SaveMeta {
  return {
    id,
    name: world.options.cityName,
    population: world.city.population,
    money: Math.round(world.money),
    day: world.clock.day,
    sandbox: world.sandbox,
    savedAt: Date.now(),
  };
}

/** Compressed text form of a save (for browser storage). */
export async function packSave(data: SaveGame): Promise<string> {
  return bytesToB64(await gzipText(JSON.stringify(data)));
}

export async function unpackSave(text: string): Promise<SaveGame> {
  return JSON.parse(await gunzipText(b64ToBytes(text))) as SaveGame;
}
