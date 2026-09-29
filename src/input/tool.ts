import type { Renderer } from '../render/Renderer';

export interface PointerInfo {
  /** Screen position in CSS pixels. */
  sx: number;
  sy: number;
  /** World position in meters. */
  wx: number;
  wy: number;
  /** Tile under the pointer (may be out of bounds). */
  tx: number;
  ty: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

/** A map interaction mode (road building, zoning, inspecting...). */
export interface Tool {
  readonly id: string;
  /** Show the tile grid while this tool is active. */
  readonly showGrid?: boolean;
  activate?(): void;
  deactivate?(): void;
  pointerDown?(p: PointerInfo): void;
  pointerMove?(p: PointerInfo): void;
  pointerUp?(p: PointerInfo): void;
  /** Return true if the key was consumed. */
  keyDown?(e: KeyboardEvent): boolean;
  /** Right click / Escape. Return true if the tool handled it and stays active. */
  cancel?(): boolean;
  /** Draws previews in world coordinates. */
  drawOverlay?(ctx: CanvasRenderingContext2D, r: Renderer): void;
}
