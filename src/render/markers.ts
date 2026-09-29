import { TILE } from '../config';
import type { World } from '../game/World';
import { DX, DY } from '../world/grid';
import type { Renderer } from './Renderer';

/** Highway signs where roads leave the map towards the outside world. */
export function drawOutsideMarkers(ctx: CanvasRenderingContext2D, r: Renderer, world: World): void {
  const z = r.camera.zoom;
  const size = Math.max(9, 16 / z);
  for (const oc of world.map.outside) {
    // Place the sign at the map edge, beside the road.
    const bx = (oc.x + 0.5) * TILE - DX[oc.dir] * TILE * 0.5;
    const by = (oc.y + 0.5) * TILE - DY[oc.dir] * TILE * 0.5;
    const sx = bx + -DY[oc.dir] * (TILE * 0.5 + size * 0.9);
    const sy = by + DX[oc.dir] * (TILE * 0.5 + size * 0.9);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = '#2f7de1';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = size * 0.12;
    ctx.beginPath();
    ctx.roundRect(-size * 0.8, -size * 0.8, size * 1.6, size * 1.6, size * 0.3);
    ctx.fill();
    ctx.stroke();
    // Arrow pointing out of the map.
    const a = Math.atan2(-DY[oc.dir], -DX[oc.dir]);
    ctx.rotate(a);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(size * 0.55, 0);
    ctx.lineTo(0, -size * 0.45);
    ctx.lineTo(0, -size * 0.18);
    ctx.lineTo(-size * 0.5, -size * 0.18);
    ctx.lineTo(-size * 0.5, size * 0.18);
    ctx.lineTo(0, size * 0.18);
    ctx.lineTo(0, size * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
