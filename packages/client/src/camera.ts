import type { GameConfig, Point } from '@tank/shared';

export type CameraMode = 'overview' | 'follow';

/**
 * Overview fits the whole battlefield (the concept-art framing). Follow zooms in on your
 * tank, which phones use by default so tanks and labels stay readable.
 */
export class Camera {
  x = 0;
  y = 0;
  scale = 1;
  mode: CameraMode = 'overview';
  followZoom = 1.9;
  private initialised = false;

  constructor(private cfg: GameConfig) {}

  /** Vertical band worth showing: helicopter lane down to just below the deepest valley. */
  private contentBounds(deepest: number) {
    return { top: 20, bottom: Math.min(this.cfg.worldHeight, deepest + 50) };
  }

  update(vw: number, vh: number, target: Point | null, deepest: number, dtMs: number) {
    const W = this.cfg.worldWidth;
    const H = this.cfg.worldHeight;
    const b = this.contentBounds(deepest);
    const fit = Math.min(vw / W, vh / (b.bottom - b.top));
    let scale: number;
    let x: number;
    let y: number;
    if (this.mode === 'overview' || !target) {
      scale = fit;
      const visW = vw / scale;
      const visH = vh / scale;
      x = (W - visW) / 2;
      y = Math.min(b.top, b.bottom - visH);
    } else {
      scale = fit * this.followZoom;
      const visW = vw / scale;
      const visH = vh / scale;
      x = clamp(target.x - visW / 2, 0, Math.max(0, W - visW));
      y = clamp(target.y - visH * 0.58, Math.min(b.top, H - visH), H - visH);
    }
    if (!this.initialised) {
      this.x = x;
      this.y = y;
      this.scale = scale;
      this.initialised = true;
      return;
    }
    const k = 1 - Math.exp(-dtMs / 160);
    this.x += (x - this.x) * k;
    this.y += (y - this.y) * k;
    this.scale += (scale - this.scale) * k;
  }

  toScreen(p: Point): Point {
    return { x: (p.x - this.x) * this.scale, y: (p.y - this.y) * this.scale };
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
