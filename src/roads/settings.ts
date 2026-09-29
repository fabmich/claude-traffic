import type { ControlKind } from './network';

export type SignKind = 'main' | 'yield' | 'stop';

export interface SignalPhaseSetting {
  /** Green time in seconds. */
  green: number;
  /** Signal group keys `${armDir}:${movement}` that are green in this phase. */
  groups: string[];
}

export interface SignalPlanSetting {
  phases: SignalPhaseSetting[];
  actuated: boolean;
}

/** User settings for one junction, keyed by the node's tile index so they survive recompiles. */
export interface JunctionSetting {
  control?: ControlKind;
  /** Priority sign per arm direction. */
  signs?: Record<number, SignKind>;
  signalPlan?: SignalPlanSetting;
  /**
   * Custom lane connections: key `${inArmDir}:${laneIndex}` -> list of [outArmDir, outLaneIndex].
   * Lanes without an entry use the default arrows.
   */
  lanes?: Record<string, Array<[number, number]>>;
  /** Arm layout the lane overrides were made for; overrides are ignored if the junction changes. */
  lanesSig?: string;
  roundaboutLarge?: boolean;
}

/** Signature of a junction's arm layout (direction and lane counts). */
export function armsSignature(arms: ReadonlyArray<{ dir: number; nIn: number; nOut: number }>): string {
  return arms
    .filter((a) => a.dir < 8)
    .map((a) => `${a.dir}:${a.nIn}:${a.nOut}`)
    .join(',');
}

export class JunctionSettings {
  private map = new Map<number, JunctionSetting>();

  get(tile: number): JunctionSetting | undefined {
    return this.map.get(tile);
  }

  ensure(tile: number): JunctionSetting {
    let s = this.map.get(tile);
    if (!s) {
      s = {};
      this.map.set(tile, s);
    }
    return s;
  }

  set(tile: number, s: JunctionSetting): void {
    this.map.set(tile, s);
  }

  delete(tile: number): void {
    this.map.delete(tile);
  }

  /** Settings that require the tile to be a junction node even with two arms. */
  forcesNode(tile: number): boolean {
    const s = this.map.get(tile);
    return !!s && s.control === 'roundabout';
  }

  entries(): IterableIterator<[number, JunctionSetting]> {
    return this.map.entries();
  }

  clear(): void {
    this.map.clear();
  }
}
