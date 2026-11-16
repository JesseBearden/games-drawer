import type { GameConfig } from './config';

/**
 * Destructible terrain stored as solid vertical runs ("spans") per column.
 *
 * Column x holds a flat, sorted list [top0, bottom0, top1, bottom1, ...] of half-open
 * ranges [top, bottom). y grows downward. The last span of every column always reaches
 * the world bottom because the bedrock rows can never be carved.
 *
 * All mutation uses integer arithmetic plus Math.sqrt (which IEEE-754 requires to be
 * correctly rounded), so the server and every browser produce identical terrain from the
 * same sequence of craters. That is what lets us sync terrain as "seed + crater list".
 */
export interface TerrainData {
  width: number;
  height: number;
  /** Per column flat span list. */
  cols: number[][];
  /** Original generated surface, used by the renderer to colour untouched grass. */
  surface: number[];
}

export interface CollapseOptions {
  minSliverThickness: number;
  detachedDirtFalls: boolean;
  /** A ledge may reach at most this many times its thickness past its support; 0 = no limit. */
  maxOverhangRatio?: number;
}

/** The collapse rules for a config. Server, client and terrain generation must all use this. */
export function collapseOptionsFor(cfg: Pick<GameConfig, 'minSliverThickness' | 'detachedDirtFalls' | 'maxOverhangRatio'>): CollapseOptions {
  return { minSliverThickness: cfg.minSliverThickness, detachedDirtFalls: cfg.detachedDirtFalls, maxOverhangRatio: cfg.maxOverhangRatio };
}

export interface DirtyRange {
  x0: number;
  x1: number;
}

export class Terrain {
  readonly width: number;
  readonly height: number;
  readonly bedrockTop: number;
  cols: number[][];
  /** Generated surface height per column (does not change when carved). */
  readonly surface: number[];

  constructor(width: number, height: number, bedrock: number, cols: number[][], surface: number[]) {
    this.width = width;
    this.height = height;
    this.bedrockTop = height - bedrock;
    this.cols = cols;
    this.surface = surface;
  }

  static fromData(data: TerrainData, bedrock: number) {
    return new Terrain(
      data.width,
      data.height,
      bedrock,
      data.cols.map((c) => c.slice()),
      data.surface.slice(),
    );
  }

  toData(): TerrainData {
    return { width: this.width, height: this.height, cols: this.cols.map((c) => c.slice()), surface: this.surface.slice() };
  }

  clone(): Terrain {
    return Terrain.fromData(this.toData(), this.height - this.bedrockTop);
  }

  // ---------------------------------------------------------------- queries

  solidAt(x: number, y: number): boolean {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cx >= this.width) return false;
    if (cy >= this.height) return true;
    if (cy < 0) return false;
    const c = this.cols[cx];
    for (let i = 0; i < c.length; i += 2) {
      if (cy < c[i]) return false;
      if (cy < c[i + 1]) return true;
    }
    return false;
  }

  /** Top of the first span starting at or below `fromY` in column x (world height if none). */
  groundBelow(x: number, fromY: number): number {
    const cx = clampInt(Math.floor(x), 0, this.width - 1);
    const c = this.cols[cx];
    for (let i = 0; i < c.length; i += 2) {
      if (c[i] >= fromY) return c[i];
    }
    return this.height;
  }

  /** Highest solid point of column x. */
  topAt(x: number): number {
    const cx = clampInt(Math.floor(x), 0, this.width - 1);
    return this.cols[cx][0];
  }

  /** True if column x has solid cells anywhere in [y0, y1). */
  solidInRange(x: number, y0: number, y1: number): boolean {
    const cx = Math.floor(x);
    if (cx < 0 || cx >= this.width) return false;
    const c = this.cols[cx];
    for (let i = 0; i < c.length; i += 2) {
      if (c[i] < y1 && c[i + 1] > y0) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- mutation

  /**
   * Carve a circle and run the collapse rules. Returns the columns that changed.
   * Inputs are rounded to integers so every peer carves exactly the same cells.
   */
  carve(cxIn: number, cyIn: number, rIn: number, opts: CollapseOptions): DirtyRange | null {
    const cx = Math.round(cxIn);
    const cy = Math.round(cyIn);
    const r = Math.max(1, Math.round(rIn));
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(this.width - 1, cx + r);
    let changed = false;
    let dx0 = Infinity;
    let dx1 = -Infinity;
    for (let x = x0; x <= x1; x++) {
      const d = x - cx;
      const hh = Math.floor(Math.sqrt(r * r - d * d));
      const top = Math.max(0, cy - hh);
      const bottom = Math.min(this.bedrockTop, cy + hh + 1);
      if (bottom <= top) continue;
      if (subtractRange(this.cols[x], top, bottom)) {
        changed = true;
        if (x < dx0) dx0 = x;
        if (x > dx1) dx1 = x;
      }
    }
    if (!changed) return null;
    const collapsed = this.collapse(opts);
    if (collapsed) {
      dx0 = Math.min(dx0, collapsed.x0);
      dx1 = Math.max(dx1, collapsed.x1);
    }
    return { x0: dx0, x1: dx1 };
  }

  /**
   * Collapse rules, run after every crater:
   *  1. Thin slivers (any non-bedrock span thinner than minSliverThickness) crumble away.
   *  2. Dirt no longer connected to the bedrock falls straight down, column by column,
   *     and merges with whatever it lands on.
   * Attached overhangs stay no matter how long they are.
   */
  collapse(opts: CollapseOptions): DirtyRange | null {
    let dx0 = Infinity;
    let dx1 = -Infinity;
    for (let pass = 0; pass < 4; pass++) {
      let changedThisPass = false;
      if (opts.minSliverThickness > 0) {
        for (let x = 0; x < this.width; x++) {
          const c = this.cols[x];
          if (c.length <= 2) continue;
          for (let i = c.length - 4; i >= 0; i -= 2) {
            if (c[i + 1] - c[i] < opts.minSliverThickness) {
              c.splice(i, 2);
              changedThisPass = true;
              if (x < dx0) dx0 = x;
              if (x > dx1) dx1 = x;
            }
          }
        }
      }
      if (opts.maxOverhangRatio && opts.maxOverhangRatio > 0) {
        const trimmed = this.trimOverhangs(opts.maxOverhangRatio);
        if (trimmed) {
          changedThisPass = true;
          if (trimmed.x0 < dx0) dx0 = trimmed.x0;
          if (trimmed.x1 > dx1) dx1 = trimmed.x1;
        }
      }
      if (opts.detachedDirtFalls) {
        const floating = this.findFloating();
        if (floating) {
          for (let x = 0; x < this.width; x++) {
            const flags = floating[x];
            if (!flags) continue;
            if (this.dropFloating(x, flags)) {
              changedThisPass = true;
              if (x < dx0) dx0 = x;
              if (x > dx1) dx1 = x;
            }
          }
        }
      }
      if (!changedThisPass) break;
    }
    return dx0 <= dx1 ? { x0: dx0, x1: dx1 } : null;
  }

  /**
   * Crumble ledge cells that stick out too far. A non-bottom span (air below it) is part of a
   * ledge; walk sideways through overlapping spans to the nearest column where that dirt is
   * solid down to bedrock. If that support is more than `ratio` x the ledge's thickness away,
   * the span crumbles. Long thin ledges get trimmed back; thick ones can reach further.
   */
  private trimOverhangs(ratio: number): DirtyRange | null {
    const W = this.width;
    const doomed: [number, number][] = [];
    for (let x = 0; x < W; x++) {
      const c = this.cols[x];
      for (let i = 0; i + 2 < c.length; i += 2) {
        const thickness = c[i + 1] - c[i];
        const limit = Math.ceil(ratio * thickness);
        const reach = Math.min(this.supportDistance(x, c[i], c[i + 1], -1, limit), this.supportDistance(x, c[i], c[i + 1], 1, limit));
        if (reach > limit) doomed.push([x, i]);
      }
    }
    if (!doomed.length) return null;
    // Remove from the end of each column first so indices stay valid.
    doomed.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    for (const [x, i] of doomed) this.cols[x].splice(i, 2);
    return { x0: doomed[0][0], x1: doomed[doomed.length - 1][0] };
  }

  /** Columns from x to where [top, bottom) continues as dirt solid to bedrock (Infinity if none within limit). */
  private supportDistance(x: number, top: number, bottom: number, dir: -1 | 1, limit: number): number {
    let t = top;
    let b = bottom;
    for (let step = 1; step <= limit + 1; step++) {
      const nx = x + dir * step;
      if (nx < 0 || nx >= this.width) return Infinity;
      const c = this.cols[nx];
      let found = -1;
      for (let j = 0; j < c.length; j += 2) {
        if (c[j] < b && c[j + 1] > t) {
          found = j;
          break;
        }
      }
      if (found < 0) return Infinity; // the ledge ends this way
      if (found === c.length - 2) return step; // this column is solid to bedrock
      t = c[found];
      b = c[found + 1];
    }
    return Infinity;
  }

  /** Marks spans not connected to bedrock. Returns null when nothing floats. */
  private findFloating(): (Uint8Array | null)[] | null {
    const W = this.width;
    // Fast path: no column has more than one span, so nothing can float.
    let anyMulti = false;
    for (let x = 0; x < W; x++) {
      if (this.cols[x].length > 2) {
        anyMulti = true;
        break;
      }
    }
    if (!anyMulti) return null;

    // grounded[x][k] = 1 if span k of column x is connected to bedrock.
    const grounded: Uint8Array[] = new Array(W);
    for (let x = 0; x < W; x++) grounded[x] = new Uint8Array(this.cols[x].length >> 1);
    const stack: number[] = [];
    for (let x = 0; x < W; x++) {
      const k = (this.cols[x].length >> 1) - 1;
      grounded[x][k] = 1;
      stack.push(x, k);
    }
    while (stack.length) {
      const k = stack.pop()!;
      const x = stack.pop()!;
      const c = this.cols[x];
      const top = c[k * 2];
      const bottom = c[k * 2 + 1];
      for (const nx of [x - 1, x + 1]) {
        if (nx < 0 || nx >= W) continue;
        const nc = this.cols[nx];
        const g = grounded[nx];
        for (let j = 0; j < nc.length; j += 2) {
          if (nc[j] >= bottom) break;
          if (nc[j + 1] > top && !g[j >> 1]) {
            g[j >> 1] = 1;
            stack.push(nx, j >> 1);
          }
        }
      }
    }
    let any = false;
    const result: (Uint8Array | null)[] = new Array(W).fill(null);
    for (let x = 0; x < W; x++) {
      const g = grounded[x];
      let floatFlags: Uint8Array | null = null;
      for (let k = 0; k < g.length; k++) {
        if (!g[k]) {
          floatFlags ??= new Uint8Array(g.length);
          floatFlags[k] = 1;
          any = true;
        }
      }
      result[x] = floatFlags;
    }
    return any ? result : null;
  }

  /** Drop floating spans of one column straight down, lowest first. */
  private dropFloating(x: number, flags: Uint8Array): boolean {
    const c = this.cols[x];
    let changed = false;
    // Walk from the second-lowest span upward; the lowest span is always grounded.
    for (let k = flags.length - 2; k >= 0; k--) {
      if (!flags[k]) continue;
      const i = k * 2;
      const thickness = c[i + 1] - c[i];
      const restOn = c[i + 2]; // top of the span directly below
      const newBottom = restOn;
      const newTop = newBottom - thickness;
      if (newTop !== c[i]) changed = true;
      // Merge into the span below.
      c[i + 2] = newTop;
      c.splice(i, 2);
    }
    return changed;
  }
}

/** Remove [top, bottom) from a flat span list in place. Returns true if anything changed. */
export function subtractRange(c: number[], top: number, bottom: number): boolean {
  let changed = false;
  for (let i = 0; i < c.length; i += 2) {
    const a = c[i];
    const b = c[i + 1];
    if (b <= top) continue;
    if (a >= bottom) break;
    changed = true;
    if (a < top && b > bottom) {
      // Split.
      c.splice(i + 1, 0, top, bottom);
      return true;
    }
    if (a >= top && b <= bottom) {
      c.splice(i, 2);
      i -= 2;
    } else if (a < top) {
      c[i + 1] = top;
    } else {
      c[i] = bottom;
    }
  }
  return changed;
}

function clampInt(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ------------------------------------------------------------------ generation

function hash01(seed: number, i: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(seed: number, x: number, wavelength: number): number {
  const fx = x / wavelength;
  const i = Math.floor(fx);
  const t = fx - i;
  const s = t * t * (3 - 2 * t);
  const a = hash01(seed, i);
  const b = hash01(seed, i + 1);
  return a + (b - a) * s;
}

/** Steepens the transition between terraces so the land forms shelves with steep risers. */
function terrace(h: number, step: number, sharpness: number): number {
  const base = Math.floor(h / step) * step;
  const t = (h - base) / step;
  const tk = t * t * t;
  const ik = (1 - t) * (1 - t) * (1 - t);
  const shaped = tk / (tk + ik);
  return base + step * (sharpness * shaped + (1 - sharpness) * t);
}

export function generateTerrain(cfg: GameConfig, seed: number): Terrain {
  const W = cfg.worldWidth;
  const H = cfg.worldHeight;
  const minSurface = Math.floor(H * 0.3);
  const maxSurface = Math.floor(H * 0.86);
  const raw: number[] = new Array(W);
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = 0; x < W; x++) {
    const n =
      valueNoise(seed, x, 620) * 1.0 +
      valueNoise(seed + 17, x, 260) * 0.55 +
      valueNoise(seed + 41, x, 110) * 0.22 +
      valueNoise(seed + 73, x, 37) * 0.05;
    raw[x] = n;
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  const surface: number[] = new Array(W);
  const range = maxSurface - minSurface;
  for (let x = 0; x < W; x++) {
    // Normalise to 0..1, then push towards the extremes for deep valleys and high ridges.
    let t = (raw[x] - lo) / (hi - lo);
    t = t * t * (3 - 2 * t);
    const h = terrace(t * range, range / 6, 0.75);
    surface[x] = Math.round(maxSurface - h);
  }
  const cols: number[][] = new Array(W);
  for (let x = 0; x < W; x++) cols[x] = [surface[x], H];
  const terrain = new Terrain(W, H, cfg.bedrock, cols, surface);

  // Notch a few overhangs into steep risers so ledges exist from the start.
  const opts = collapseOptionsFor(cfg);
  let notches = 0;
  for (let x = 40; x < W - 40 && notches < 3; x += 7) {
    const drop = surface[x + 6] - surface[x - 6];
    if (Math.abs(drop) > 70 && hash01(seed + 99, x) < 0.35) {
      const lowSide = drop > 0 ? 1 : -1;
      const cy = Math.max(surface[x - 6], surface[x + 6]) - 18;
      terrain.carve(x + lowSide * 4, cy, 22, opts);
      notches++;
      x += 200;
    }
  }
  return terrain;
}
