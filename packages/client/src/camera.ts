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

/** World units of sky kept above the highest hill in the whole-battlefield view. */
const SKY_ABOVE_HILLS = 150;
/** The whole-battlefield view never shows less than this much height (world units). */
const MIN_BAND = 420;

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
   * The whole battlefield must always fit top to bottom: from a little sky above the highest
   * hill (room for a tank, its name and the start of a shot) down past the deepest valley.
   */
  private wholeBand(deepest: number, highest: number) {
    const b = this.contentBounds(deepest);
    return { top: Math.max(b.top, Math.min(highest - SKY_ABOVE_HILLS, b.bottom - MIN_BAND)), bottom: b.bottom };
  }

  /**
   * bottomInset / rightInset: screen pixels covered by the control strip (along the bottom, or
   * down the right side on a phone held sideways). The whole battlefield is framed clear of it
   * so no tank ends up hidden under a button.
   */
  update(vw: number, vh: number, target: Point | null, deepest: number, dtMs: number, bottomInset = 0, highest = deepest, rightInset = 0) {
    const W = this.cfg.worldWidth;
    const H = this.cfg.worldHeight;
    const b = this.contentBounds(deepest);
    const usableH = Math.max(100, vh - bottomInset);
    let scale: number;
    let x: number;
    let y: number;
    if (!this.following || !target) {
      // Whole battlefield: the full width, edge to edge, unless that would cut the hills or the
      // valleys off (short, wide phone screens). Then it shrinks until they fit, and the ground
      // past the map's edges (drawn dimmed) fills the sides. Spare height goes to the sky. It all
      // sits above the control strip; below the strip there's just more ground.
      const band = this.wholeBand(deepest, highest);
      const usableW = Math.max(100, vw - rightInset);
      scale = Math.min(usableW / W, usableH / (band.bottom - band.top));
      x = -Math.max(0, usableW / scale - W) / 2;
      y = band.bottom - usableH / scale;
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
