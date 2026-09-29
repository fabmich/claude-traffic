import { START_MONEY } from '../config';
import { Rng } from '../core/rng';
import { generateMap } from '../world/mapgen';
import type { WorldMap } from '../world/WorldMap';
import { Clock } from './clock';

export interface NewGameOptions {
  seed: number;
  size: number;
  cityName: string;
  sandbox: boolean;
}

/**
 * All simulation state of one game, independent of DOM and rendering so it can run headless in tests.
 */
export class World {
  readonly options: NewGameOptions;
  readonly map: WorldMap;
  readonly clock = new Clock();
  readonly rng: Rng;
  money: number;

  constructor(options: NewGameOptions, map?: WorldMap) {
    this.options = options;
    this.map = map ?? generateMap({ seed: options.seed, size: options.size });
    this.rng = new Rng(options.seed ^ 0x5bd1e995);
    this.money = START_MONEY;
  }

  get sandbox(): boolean {
    return this.options.sandbox;
  }

  /** Advances the simulation by dt simulated seconds. */
  step(dt: number): void {
    this.clock.advance(dt);
  }
}
