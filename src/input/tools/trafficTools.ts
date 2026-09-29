import { LANE_W } from '../../config';
import type { Game } from '../../game/Game';
import type { Arm, Lane, RoadNode } from '../../roads/network';
import type { Renderer } from '../../render/Renderer';
import { JunctionControl, PRIO_MAIN } from '../../sim/junctions';
import { laneTargets } from '../../ui/panels/junctionPanel';
import type { PointerInfo, Tool } from '../tool';

const LANE_COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#22b8cf', '#f06595'];

interface Dot {
  kind: 'in' | 'out';
  lane: Lane;
  arm: Arm;
  x: number;
  y: number;
}

/** On-map lane connector editor: click a lane end, then the lanes it should lead into. */
export class LaneTool implements Tool {
  readonly id = 'lanes';
  tile = -1;
  selected: { armDir: number; laneIdx: number } | null = null;
  private hover: PointerInfo | null = null;

  constructor(private game: Game) {}

  /** Starts editing a junction (or waits for a click on one if tile < 0). */
  edit(tile: number): void {
    this.tile = tile;
    this.selected = null;
    if (this.game.tool !== this) this.game.setTool(this);
  }

  deactivate(): void {
    this.selected = null;
  }

  private node(): RoadNode | null {
    const n = this.game.world?.network.nodeByTile.get(this.tile);
    return n && n.ringOf === null && n.arms.length >= 2 ? n : null;
  }

  private dots(node: RoadNode): Dot[] {
    const out: Dot[] = [];
    for (const arm of node.arms) {
      for (const lane of arm.ins) out.push({ kind: 'in', lane, arm, x: lane.path.x1, y: lane.path.y1 });
      for (const lane of arm.outs) out.push({ kind: 'out', lane, arm, x: lane.path.x0, y: lane.path.y0 });
    }
    return out;
  }

  private radius(): number {
    return Math.max(1.1, 7 / this.game.renderer.camera.zoom);
  }

  pointerMove(p: PointerInfo): void {
    this.hover = p;
  }

  pointerDown(p: PointerInfo): void {
    const world = this.game.world;
    if (!world) return;
    const node = this.node();
    let hit: Dot | null = null;
    if (node) {
      let bd = this.radius() * 1.3;
      for (const d of this.dots(node)) {
        const dist = Math.hypot(d.x - p.wx, d.y - p.wy);
        if (dist < bd) {
          bd = dist;
          hit = d;
        }
      }
    }
    if (!hit) {
      const other = this.game.tools.inspect.nodeAt(p.wx, p.wy);
      if (other && other.ringOf === null && other.tile !== this.tile) {
        this.edit(other.tile);
        this.game.events.emit('openJunction', other.tile);
      } else this.selected = null;
      return;
    }
    if (hit.kind === 'in') {
      this.selected = { armDir: hit.arm.dir, laneIdx: hit.lane.index };
      return;
    }
    if (!this.selected || !node) return;
    const arm = node.armByDir(this.selected.armDir);
    const lane = arm?.ins[this.selected.laneIdx];
    if (!arm || !lane) return;
    const cur = laneTargets(lane);
    const exists = cur.some(([d, i]) => d === hit!.arm.dir && i === hit!.lane.index);
    const next = exists ? cur.filter(([d, i]) => !(d === hit!.arm.dir && i === hit!.lane.index)) : [...cur, [hit.arm.dir, hit.lane.index] as [number, number]];
    world.setLaneTargets(this.tile, arm.dir, lane.index, next);
  }

  cancel(): boolean {
    if (this.selected) {
      this.selected = null;
      return true;
    }
    return false;
  }

  drawOverlay(ctx: CanvasRenderingContext2D, r: Renderer): void {
    const node = this.node();
    const z = r.camera.zoom;
    if (!node) {
      const hv = this.hover;
      if (hv) r.label('Click a junction to edit its lanes', hv.wx, hv.wy, { dy: -24 });
      return;
    }
    ctx.fillStyle = 'rgba(15, 25, 35, 0.35)';
    ctx.beginPath();
    ctx.arc(node.x, node.y, 34, 0, Math.PI * 2);
    ctx.fill();
    // Connectors coloured by incoming lane.
    const inLanes = node.arms.flatMap((a) => a.ins);
    ctx.lineCap = 'round';
    for (const c of node.connectors) {
      const idx = inLanes.indexOf(c.from);
      const sel = this.selected && c.inArm.dir === this.selected.armDir && c.from.index === this.selected.laneIdx;
      ctx.strokeStyle = LANE_COLORS[idx % LANE_COLORS.length];
      ctx.globalAlpha = this.selected ? (sel ? 1 : 0.18) : 0.85;
      ctx.lineWidth = sel ? Math.max(0.9, 2.6 / z) : Math.max(0.5, 1.6 / z);
      ctx.beginPath();
      c.path.trace(ctx);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const rad = this.radius();
    for (const d of this.dots(node)) {
      const isSel = d.kind === 'in' && this.selected && d.arm.dir === this.selected.armDir && d.lane.index === this.selected.laneIdx;
      ctx.fillStyle = d.kind === 'in' ? LANE_COLORS[inLanes.indexOf(d.lane) % LANE_COLORS.length] : '#ffffff';
      ctx.strokeStyle = d.kind === 'in' ? '#ffffff' : '#1d2830';
      ctx.lineWidth = Math.max(0.25, 1.4 / z);
      ctx.beginPath();
      ctx.arc(d.x, d.y, isSel ? rad * 1.35 : d.kind === 'in' ? rad : rad * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const hint = this.selected ? 'Click white dots to connect or disconnect · Esc to deselect' : 'Click a coloured lane end to choose where it goes';
    r.label(hint, node.x, node.y - 30, { dy: -10 });
    void LANE_W;
  }
}

export type JunctionMode = 'auto' | 'yield' | 'stop' | 'allstop' | 'signals' | 'roundabout' | 'roundaboutLarge';

/** Click junctions to apply a traffic control quickly. */
export class JunctionTool implements Tool {
  readonly id = 'junction';
  mode: JunctionMode = 'signals';
  private hover: PointerInfo | null = null;

  constructor(private game: Game) {}

  pointerMove(p: PointerInfo): void {
    this.hover = p;
  }

  pointerDown(p: PointerInfo): void {
    const world = this.game.world;
    if (!world) return;
    const node = this.game.tools.inspect.nodeAt(p.wx, p.wy);
    if (!node) {
      this.game.ui.toast('Click on a junction', 'warn');
      return;
    }
    const tile = node.ringOf ?? node.tile;
    let err: string | null = null;
    switch (this.mode) {
      case 'auto':
        err = world.setJunctionControl(tile, 'auto');
        break;
      case 'yield':
      case 'stop': {
        err = world.setJunctionControl(tile, 'auto');
        if (err) break;
        const n = world.network.nodeByTile.get(tile);
        if (!n) break;
        // Keep the automatic main road and give the other roads signs.
        const auto = new JunctionControl(n, undefined);
        const minor = n.arms.filter((a) => a.ins.length && (auto.prio.get(a) ?? PRIO_MAIN) !== PRIO_MAIN);
        const targets = minor.length ? minor : n.arms.filter((a) => a.ins.length).slice(1);
        err = world.setJunctionControl(tile, 'priority');
        if (err) break;
        world.updateJunction(tile, (s) => {
          s.signs = {};
          for (const a of n.arms) s.signs[a.dir] = targets.includes(a) ? (this.mode as 'yield' | 'stop') : 'main';
        });
        break;
      }
      case 'allstop':
        err = world.setJunctionControl(tile, 'allstop');
        break;
      case 'signals':
        err = world.setJunctionControl(tile, 'signals');
        break;
      case 'roundabout':
        err = world.setJunctionControl(tile, 'roundabout', false);
        break;
      case 'roundaboutLarge':
        err = world.setJunctionControl(tile, 'roundabout', true);
        break;
    }
    if (err) this.game.ui.toast(err, 'warn');
  }

  drawOverlay(ctx: CanvasRenderingContext2D, r: Renderer): void {
    const hv = this.hover;
    if (!hv) return;
    const node = this.game.tools.inspect.nodeAt(hv.wx, hv.wy);
    if (!node) return;
    const rb = node.ringOf !== null ? this.game.world?.network.roundabouts.get(node.ringOf) : null;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = Math.max(0.6, 2 / r.camera.zoom);
    ctx.beginPath();
    if (rb) ctx.arc(rb.x, rb.y, rb.radius + rb.halfWidth + 3, 0, Math.PI * 2);
    else ctx.arc(node.x, node.y, 16, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Paint speed limits onto roads (whole segments between junctions). */
export class SpeedTool implements Tool {
  readonly id = 'speed';
  kmh = 50;
  private dragging = false;
  private applied = new Set<string>();
  private hover: PointerInfo | null = null;

  constructor(private game: Game) {}

  pointerDown(p: PointerInfo): void {
    this.dragging = true;
    this.applied.clear();
    this.apply(p);
  }

  pointerMove(p: PointerInfo): void {
    this.hover = p;
    if (this.dragging) this.apply(p);
  }

  pointerUp(): void {
    this.dragging = false;
  }

  private apply(p: PointerInfo): void {
    const world = this.game.world;
    if (!world) return;
    const seg = this.game.tools.inspect.segmentAt(p.wx, p.wy);
    if (!seg || this.applied.has(seg.key) || seg.type.hidden) return;
    this.applied.add(seg.key);
    const target = this.kmh === seg.type.speedKmh ? 0 : this.kmh;
    world.setSegmentAttrs(seg.key, { speedKmh: target });
  }

  drawOverlay(ctx: CanvasRenderingContext2D, r: Renderer): void {
    const hv = this.hover;
    if (!hv) return;
    const seg = this.game.tools.inspect.segmentAt(hv.wx, hv.wy);
    if (!seg) return;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const lane of seg.lanes) {
      ctx.beginPath();
      lane.path.trace(ctx);
      ctx.stroke();
    }
    r.label(`${this.kmh} km/h`, hv.wx, hv.wy, { dy: -24 });
  }
}
