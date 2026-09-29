import { TILE } from '../../config';
import type { Game } from '../../game/Game';
import type { RoadNode, Segment } from '../../roads/network';
import type { Renderer } from '../../render/Renderer';
import type { Vehicle } from '../../sim/vehicle';
import type { PointerInfo, Tool } from '../tool';

export type Selection =
  | { kind: 'vehicle'; vehicle: Vehicle }
  | { kind: 'node'; tile: number }
  | { kind: 'segment'; key: string }
  | null;

/** Default tool: click vehicles, junctions and roads to see details. */
export class InspectTool implements Tool {
  readonly id = 'inspect';
  selection: Selection = null;
  hover: PointerInfo | null = null;

  constructor(private game: Game) {}

  pointerMove(p: PointerInfo): void {
    this.hover = p;
  }

  pointerDown(p: PointerInfo): void {
    const world = this.game.world;
    if (!world) return;
    const v = world.traffic.vehicleAt(p.wx, p.wy, 5 + 4 / this.game.renderer.camera.zoom);
    if (v) {
      this.select({ kind: 'vehicle', vehicle: v });
      return;
    }
    const node = this.nodeAt(p.wx, p.wy);
    if (node) {
      this.select({ kind: 'node', tile: node.ringOf ?? node.tile });
      return;
    }
    const seg = this.segmentAt(p.wx, p.wy);
    if (seg) {
      this.select({ kind: 'segment', key: seg.key });
      return;
    }
    this.select(null);
  }

  select(sel: Selection): void {
    this.selection = sel;
    this.game.events.emit('select', sel);
  }

  cancel(): boolean {
    if (this.selection) {
      this.select(null);
      return true;
    }
    return false;
  }

  /** Junction (or roundabout) under a world point. */
  nodeAt(x: number, y: number): RoadNode | null {
    const world = this.game.world;
    if (!world) return null;
    const net = world.network;
    for (const rb of net.roundabouts.values()) {
      if (Math.hypot(rb.x - x, rb.y - y) < rb.radius + rb.halfWidth + 2) return rb.nodes[0];
    }
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const n = net.nodeByTile.get(ty * world.map.w + tx);
    if (n && n.arms.length >= 2 && Math.hypot(n.x - x, n.y - y) < TILE * 0.55) return n;
    return null;
  }

  /** Road segment nearest to a world point (within half a tile). */
  segmentAt(x: number, y: number): Segment | null {
    const world = this.game.world;
    if (!world) return null;
    let best: Segment | null = null;
    let bd = TILE * 0.5;
    for (const seg of world.network.segments) {
      const b = seg.bbox;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      const c = seg.center;
      for (let i = 0; i < c.n - 1; i++) {
        const ax = c.xs[i];
        const ay = c.ys[i];
        const dx = c.xs[i + 1] - ax;
        const dy = c.ys[i + 1] - ay;
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
        if (d < bd) {
          bd = d;
          best = seg;
        }
      }
    }
    return best;
  }

  drawOverlay(ctx: CanvasRenderingContext2D, r: Renderer): void {
    const world = this.game.world;
    const sel = this.selection;
    if (!world || !sel) return;
    if (sel.kind === 'vehicle') {
      const v = sel.vehicle;
      if (v.listIndex < 0) return;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(80, 170, 255, 0.85)';
      ctx.lineWidth = Math.max(1.4, 3 / r.camera.zoom);
      for (const p of world.traffic.routePaths(v)) {
        ctx.beginPath();
        p.trace(ctx);
        ctx.stroke();
      }
      const d = v.dest;
      if (d) {
        const lanes = d.forward ? d.seg.forward : d.seg.backward;
        if (lanes[0]) {
          const pt = { x: 0, y: 0, a: 0 };
          lanes[0].path.pointAt(d.outside ? lanes[0].length : d.s, pt);
          ctx.fillStyle = '#50aaff';
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, Math.max(2.5, 6 / r.camera.zoom), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (sel.kind === 'node') {
      const rb = world.network.roundabouts.get(sel.tile);
      ctx.strokeStyle = 'rgba(80, 170, 255, 0.9)';
      ctx.lineWidth = Math.max(0.8, 2 / r.camera.zoom);
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      if (rb) ctx.arc(rb.x, rb.y, rb.radius + rb.halfWidth + 3, 0, Math.PI * 2);
      else {
        const n = world.network.nodeByTile.get(sel.tile);
        if (n) ctx.arc(n.x, n.y, TILE * 0.62, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (sel.kind === 'segment') {
      const seg = world.network.segByKey.get(sel.key);
      if (!seg) return;
      ctx.strokeStyle = 'rgba(80, 170, 255, 0.55)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (const lane of seg.lanes) {
        ctx.beginPath();
        lane.path.trace(ctx);
        ctx.stroke();
      }
    }
  }
}
