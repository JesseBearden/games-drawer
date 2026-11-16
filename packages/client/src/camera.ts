import type { GameConfig, Point } from '@tank/shared';

/**
 * Zoom levels, as multiples of the "whole battlefield" fit. Level 0 shows everything (the
 * concept-art framing); higher levels follow your tank. Phones start at Medium.
 */
export const ZOOM_LEVELS = [
  { name: 'Whole battlefield', zoom: 1 },
  { name: 'Medium zoom', zoom: 1.3 },
  { name: 'Close zoom', zoom: 1.9 },
] as const;

export class Camera {
  x = 0;
  y = 0;
  scale = 1;
  zoomIndex = 0;
  private initialised = false;

  constructor(private cfg: GameConfig) {}

  get following() {
    return ZOOM_LEVELS[this.zoomIndex].zoom > 1;
  }

  /** Step to the next zoom level (wrapping) and return its name. */
  cycleZoom(): string {
    this.zoomIndex = (this.zoomIndex + 1) % ZOOM_LEVELS.length;
    return ZOOM_LEVELS[this.zoomIndex].name;
  }

  /** Vertical band worth showing: helicopter lane down to just below the deepest valley. */
  private contentBounds(deepest: number) {
    return { top: 20, bottom: Math.min(this.cfg.worldHeight, deepest + 50) };
  }

  /**
   * bottomInset: screen pixels at the bottom covered by touch controls. The battlefield is
   * framed above them so no tank ends up hidden under a button.
   */
  update(vw: number, vh: number, target: Point | null, deepest: number, dtMs: number, bottomInset = 0) {
    const W = this.cfg.worldWidth;
    const H = this.cfg.worldHeight;
    const b = this.contentBounds(deepest);
    const usableH = Math.max(100, vh - bottomInset);
    let scale: number;
    let x: number;
    let y: number;
    if (!this.following || !target) {
      // Whole battlefield: always the full width, edge to edge. On short, wide phone screens
      // that trims a little sky off the top; spare height (desktop) goes to the sky.
      scale = vw / W;
      x = 0;
      y = Math.min(b.top, b.bottom - vh / scale);
    } else {
      // Zoomed views are based on the screen's width, so short, wide phone screens fill
      // edge to edge and trim empty sky rather than shrinking the whole map to fit.
      scale = (vw / W) * ZOOM_LEVELS[this.zoomIndex].zoom;
      const visW = vw / scale;
      const visH = vh / scale;
      const usableVisH = usableH / scale;
      // Look a little past the map edges (drawn as rock) so your tank can stay clear of the
      // corner controls instead of being pinned under them.
      const overscanX = visW * 0.22;
      x = clamp(target.x - visW / 2, -overscanX, Math.max(-overscanX, W - visW + overscanX));
      // May look up into open sky, so a helicopter near the top isn't hidden under the HUD.
      y = clamp(target.y - usableVisH * 0.6, Math.min(b.top, H - usableVisH) - usableVisH * 0.3, H - usableVisH);
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
