import { MAX_STEPS_PER_FRAME, SIM_DT, SPEED_LEVELS, TILE, TIME_SCALE } from '../config';
import { Emitter } from '../core/events';
import { Input } from '../input/Input';
import type { PointerInfo, Tool } from '../input/tool';
import { drawOutsideMarkers } from '../render/markers';
import { Renderer } from '../render/Renderer';
import { setupToolbar } from '../ui/toolbarSetup';
import { UI } from '../ui/UI';
import { World, type NewGameOptions } from './World';

export type GameEvents = {
  newGame: World;
  speed: { paused: boolean; speedIndex: number };
  tool: Tool | null;
  hover: PointerInfo;
  frame: number;
};

/** Browser shell around a World: owns the render loop, input, tools and UI. */
export class Game {
  readonly events = new Emitter<GameEvents>();
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
  readonly input: Input;
  readonly ui: UI;
  world: World | null = null;
  tool: Tool | null = null;
  paused = false;
  speedIndex = 0;
  fps = 60;
  private acc = 0;
  private lastT = 0;

  constructor(readonly root: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'view';
    root.append(this.canvas);
    this.renderer = new Renderer(this.canvas);
    this.ui = new UI(this, root);
    this.input = new Input(this, this.canvas);
    window.addEventListener('resize', () => this.renderer.resize());
    this.renderer.resize();
    this.renderer.upperDrawers.push((ctx, r) => {
      if (this.world) drawOutsideMarkers(ctx, r, this.world);
    });
    this.renderer.overlayDrawers.push((ctx, r) => this.tool?.drawOverlay?.(ctx, r));
    this.tools = setupToolbar(this);
  }

  readonly tools: ReturnType<typeof setupToolbar>;

  newGame(options: NewGameOptions): void {
    this.setTool(null);
    this.world = new World(options);
    this.renderer.setWorld(this.world);
    this.acc = 0;
    this.paused = false;
    this.focusStart();
    this.events.emit('newGame', this.world);
    this.events.emit('speed', { paused: this.paused, speedIndex: this.speedIndex });
  }

  /** Centres the camera on the first outside connection. */
  focusStart(): void {
    const world = this.world;
    if (!world) return;
    const cam = this.renderer.camera;
    const oc = world.map.outside[0];
    const tiles = 34;
    cam.setZoom(Math.max(cam.viewW, cam.viewH) / (tiles * TILE));
    if (oc) {
      const d = 8;
      const dx = [1, 1, 0, -1, -1, -1, 0, 1][oc.dir];
      const dy = [0, 1, 1, 1, 0, -1, -1, -1][oc.dir];
      cam.x = (oc.x + dx * d + 0.5) * TILE;
      cam.y = (oc.y + dy * d + 0.5) * TILE;
    } else {
      cam.x = world.map.widthMeters / 2;
      cam.y = world.map.heightMeters / 2;
    }
  }

  setTool(tool: Tool | null): void {
    if (this.tool === tool) return;
    this.tool?.deactivate?.();
    this.tool = tool;
    tool?.activate?.();
    this.renderer.showGrid = !!tool?.showGrid;
    this.events.emit('tool', tool);
  }

  /** Right click / Escape: lets the tool cancel an action, otherwise deselects it. */
  cancelTool(): void {
    if (this.tool?.cancel?.()) return;
    if (this.ui.closeTopPanel()) return;
    this.setTool(null);
  }

  togglePause(): void {
    this.paused = !this.paused;
    this.events.emit('speed', { paused: this.paused, speedIndex: this.speedIndex });
  }

  setSpeed(i: number): void {
    this.speedIndex = Math.max(0, Math.min(SPEED_LEVELS.length - 1, i));
    this.paused = false;
    this.events.emit('speed', { paused: this.paused, speedIndex: this.speedIndex });
  }

  start(): void {
    requestAnimationFrame((t) => {
      this.lastT = t;
      requestAnimationFrame(this.frame);
    });
  }

  private frame = (t: number): void => {
    const dtReal = Math.min(0.1, Math.max(0, (t - this.lastT) / 1000));
    this.lastT = t;
    if (dtReal > 0) this.fps = this.fps * 0.95 + (1 / dtReal) * 0.05;
    this.input.update(dtReal);
    const cam = this.renderer.camera;
    cam.update(dtReal);
    const world = this.world;
    if (world) {
      cam.clampTo(world.map.widthMeters, world.map.heightMeters);
      if (!this.paused) {
        this.acc += dtReal * TIME_SCALE * SPEED_LEVELS[this.speedIndex];
        let steps = 0;
        while (this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
          world.step(SIM_DT);
          this.acc -= SIM_DT;
          steps++;
        }
        if (steps === MAX_STEPS_PER_FRAME) this.acc = Math.min(this.acc, SIM_DT);
      }
      this.renderer.alpha = this.paused ? 1 : this.acc / SIM_DT;
    }
    this.renderer.render();
    this.ui.update(dtReal);
    this.events.emit('frame', dtReal);
    requestAnimationFrame(this.frame);
  };
}
