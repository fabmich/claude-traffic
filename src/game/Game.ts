import { MAX_STEPS_PER_FRAME, SIM_DT, SPEED_LEVELS, TILE, TIME_SCALE } from '../config';
import { Emitter } from '../core/events';
import { Input } from '../input/Input';
import type { Selection } from '../input/tools/InspectTool';
import type { PointerInfo, Tool } from '../input/tool';
import { drawOutsideMarkers } from '../render/markers';
import { drawJunctionDelays, drawSpeedSigns } from '../render/overlays';
import { Renderer } from '../render/Renderer';
import { drawCongestion, drawSignals, drawVehicles } from '../render/vehicleDraw';
import { setupCityUI, type CityToolset } from '../ui/cityUI';
import { openSelectionPanel } from '../ui/panels/inspectPanels';
import { setupToolbar } from '../ui/toolbarSetup';
import { setupTrafficTools, type TrafficToolset } from '../ui/trafficToolsSetup';
import { UI } from '../ui/UI';
import { World, type NewGameOptions } from './World';

export type GameEvents = {
  newGame: World;
  speed: { paused: boolean; speedIndex: number };
  tool: Tool | null;
  hover: PointerInfo;
  frame: number;
  select: Selection;
  openJunction: number;
  overlay: string;
};

export type OverlayKind = 'none' | 'traffic' | 'delays' | 'speed' | 'happiness';

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
  overlay: OverlayKind = 'none';
  private acc = 0;
  private lastT = 0;
  readonly tools: ReturnType<typeof setupToolbar>;
  readonly trafficTools: TrafficToolset;
  readonly cityTools: CityToolset;

  constructor(readonly root: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'view';
    root.append(this.canvas);
    this.renderer = new Renderer(this.canvas);
    this.ui = new UI(this, root);
    this.input = new Input(this, this.canvas);
    window.addEventListener('resize', () => this.renderer.resize());
    this.renderer.resize();
    const selectedVehicle = () => {
      const sel = this.tools.inspect.selection;
      return sel?.kind === 'vehicle' ? sel.vehicle : null;
    };
    this.renderer.dynamicDrawers.push((ctx, r) => {
      if (!this.world) return;
      if (this.overlay === 'traffic') drawCongestion(ctx, r, this.world.traffic);
      drawVehicles(ctx, r, this.world.traffic, 'ground', selectedVehicle());
    });
    this.renderer.upperDrawers.push((ctx, r) => {
      if (!this.world) return;
      drawVehicles(ctx, r, this.world.traffic, 'upper', selectedVehicle());
      drawSignals(ctx, r, this.world.traffic.controls);
      drawOutsideMarkers(ctx, r, this.world);
    });
    this.renderer.overlayDrawers.push((ctx, r) => {
      if (!this.world) return;
      if (this.overlay === 'delays') drawJunctionDelays(ctx, r, this.world.traffic);
      if (this.overlay === 'speed' || this.tool === this.trafficTools.speed) drawSpeedSigns(ctx, r, this.world.network);
    });
    this.renderer.overlayDrawers.push((ctx, r) => this.activeTool.drawOverlay?.(ctx, r));
    this.tools = setupToolbar(this);
    this.trafficTools = setupTrafficTools(this);
    this.cityTools = setupCityUI(this);
    this.events.on('select', (sel) => openSelectionPanel(this, sel));
  }

  /** The selected tool, or the inspect tool when none is selected. */
  get activeTool(): Tool {
    return this.tool ?? this.tools.inspect;
  }

  newGame(options: NewGameOptions): void {
    this.setTool(null);
    this.tools.inspect.select(null);
    this.world = new World(options);
    this.renderer.setWorld(this.world);
    this.acc = 0;
    this.paused = false;
    this.focusStart();
    this.events.emit('newGame', this.world);
    this.events.emit('speed', { paused: this.paused, speedIndex: this.speedIndex });
  }

  setOverlay(o: OverlayKind): void {
    this.overlay = o;
    this.events.emit('overlay', o);
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
    if (this.tool) {
      this.setTool(null);
      return;
    }
    if (this.tools.inspect.cancel()) return;
    this.ui.closeTopPanel();
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
