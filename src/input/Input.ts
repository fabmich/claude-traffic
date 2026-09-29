import { TILE } from '../config';
import type { Game } from '../game/Game';
import type { PointerInfo } from './tool';

const PAN_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/** Mouse / keyboard handling: camera controls plus forwarding to the active tool. */
export class Input {
  /** Last known pointer position over the map, or null if outside. */
  pointer: PointerInfo | null = null;
  private panning: { sx: number; sy: number; moved: number } | null = null;
  private held = new Set<string>();
  private leftDown = false;

  constructor(
    private game: Game,
    private canvas: HTMLCanvasElement,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', () => {
      if (!this.panning && !this.leftDown) this.pointer = null;
    });
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
  }

  private info(e: PointerEvent | MouseEvent): PointerInfo {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const w = this.game.renderer.camera.screenToWorld(sx, sy);
    return {
      sx,
      sy,
      wx: w.x,
      wy: w.y,
      tx: Math.floor(w.x / TILE),
      ty: Math.floor(w.y / TILE),
      button: e.button,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
    };
  }

  private onDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.info(e);
    this.pointer = p;
    if (e.button === 1 || e.button === 2) {
      this.panning = { sx: p.sx, sy: p.sy, moved: 0 };
      return;
    }
    if (e.button === 0) {
      this.leftDown = true;
      this.game.activeTool.pointerDown?.(p);
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.info(e);
    this.pointer = p;
    if (this.panning) {
      const dx = p.sx - this.panning.sx;
      const dy = p.sy - this.panning.sy;
      this.panning.moved += Math.abs(dx) + Math.abs(dy);
      this.game.renderer.camera.pan(dx, dy);
      this.panning.sx = p.sx;
      this.panning.sy = p.sy;
      return;
    }
    this.game.activeTool.pointerMove?.(p);
    this.game.events.emit('hover', p);
  };

  private onUp = (e: PointerEvent): void => {
    const p = this.info(e);
    if (this.panning && (e.button === 1 || e.button === 2)) {
      const wasClick = this.panning.moved < 5;
      this.panning = null;
      if (wasClick && e.button === 2) this.game.cancelTool();
      return;
    }
    if (e.button === 0 && this.leftDown) {
      this.leftDown = false;
      this.game.activeTool.pointerUp?.(p);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.info(e);
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    this.game.renderer.camera.zoomAt(p.sx, p.sy, factor);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (this.game.ui.handleKey(e)) {
      e.preventDefault();
      return;
    }
    if (this.game.tool?.keyDown?.(e)) {
      e.preventDefault();
      return;
    }
    if (e.code in PAN_KEYS && !e.ctrlKey && !e.metaKey) {
      this.held.add(e.code);
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case 'Space':
        this.game.togglePause();
        e.preventDefault();
        break;
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
        this.game.setSpeed(Number(e.code.slice(5)) - 1);
        break;
      case 'Escape':
        this.game.cancelTool();
        break;
      case 'Equal':
      case 'NumpadAdd':
        this.zoomCenter(1.25);
        break;
      case 'Minus':
      case 'NumpadSubtract':
        this.zoomCenter(0.8);
        break;
      default:
        return;
    }
  };

  private zoomCenter(f: number): void {
    const cam = this.game.renderer.camera;
    cam.zoomAt(cam.viewW / 2, cam.viewH / 2, f);
  }

  /** Applies held-key panning. */
  update(dtReal: number): void {
    if (this.held.size === 0) return;
    let dx = 0;
    let dy = 0;
    for (const k of this.held) {
      const v = PAN_KEYS[k];
      if (v) {
        dx += v[0];
        dy += v[1];
      }
    }
    const speed = 900 * dtReal;
    this.game.renderer.camera.pan(-dx * speed, -dy * speed);
  }
}
