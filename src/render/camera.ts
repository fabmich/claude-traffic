import { clamp } from '../core/math';

/** 2D camera: (x, y) is the world point (meters) at the screen center; zoom is CSS px per meter. */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  viewW = 1;
  viewH = 1;
  minZoom = 0.08;
  maxZoom = 10;
  private targetZoom = 1;
  private anchorX = 0;
  private anchorY = 0;

  setView(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.viewW / 2) / this.zoom + this.x, y: (sy - this.viewH / 2) / this.zoom + this.y };
  }

  worldToScreenX(wx: number): number {
    return (wx - this.x) * this.zoom + this.viewW / 2;
  }

  worldToScreenY(wy: number): number {
    return (wy - this.y) * this.zoom + this.viewH / 2;
  }

  /** Visible world rectangle in meters. */
  visibleRect(margin = 0): { x0: number; y0: number; x1: number; y1: number } {
    const hw = this.viewW / 2 / this.zoom + margin;
    const hh = this.viewH / 2 / this.zoom + margin;
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh };
  }

  /** Starts a smooth zoom towards `factor` times the current target, anchored at a screen point. */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.targetZoom = clamp(this.targetZoom * factor, this.minZoom, this.maxZoom);
    this.anchorX = sx;
    this.anchorY = sy;
  }

  setZoom(z: number): void {
    this.zoom = this.targetZoom = clamp(z, this.minZoom, this.maxZoom);
  }

  get zoomTarget(): number {
    return this.targetZoom;
  }

  pan(dsx: number, dsy: number): void {
    this.x -= dsx / this.zoom;
    this.y -= dsy / this.zoom;
  }

  /** Advances smooth zoom. Returns true if the view changed. */
  update(dt: number): boolean {
    if (Math.abs(this.zoom - this.targetZoom) < 1e-4 * this.targetZoom) {
      if (this.zoom !== this.targetZoom) {
        this.applyZoom(this.targetZoom);
        return true;
      }
      return false;
    }
    const a = 1 - Math.exp(-dt * 14);
    const z = Math.exp(Math.log(this.zoom) + (Math.log(this.targetZoom) - Math.log(this.zoom)) * a);
    this.applyZoom(z);
    return true;
  }

  private applyZoom(z: number): void {
    const w = this.screenToWorld(this.anchorX, this.anchorY);
    this.zoom = z;
    this.x = w.x - (this.anchorX - this.viewW / 2) / z;
    this.y = w.y - (this.anchorY - this.viewH / 2) / z;
  }

  /** Keeps the map on screen: centred when zoomed out, otherwise with a little overscroll. */
  clampTo(worldW: number, worldH: number): void {
    this.minZoom = Math.min(this.viewW / worldW, this.viewH / worldH) * 0.85;
    const hw = this.viewW / 2 / this.zoom;
    const hh = this.viewH / 2 / this.zoom;
    const slackX = Math.min(hw * 0.3, 200);
    const slackY = Math.min(hh * 0.3, 200);
    this.x = hw * 2 >= worldW ? worldW / 2 : clamp(this.x, hw - slackX, worldW - hw + slackX);
    this.y = hh * 2 >= worldH ? worldH / 2 : clamp(this.y, hh - slackY, worldH - hh + slackY);
  }
}
