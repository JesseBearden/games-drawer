import type { Terrain } from '@tank/shared';
import { getGroundPapers, type PaperName, type PaperPixels } from './sprites';

/**
 * Paints the destructible terrain into a world-sized canvas, as layers of felt (the default look)
 * or torn paper. A texture of strata (felt: olive grass on top, then tan, orange and rust over
 * charcoal) is built once per map from the real sheets; after each crater only the affected
 * columns are repainted.
 *
 * Edges are drawn per pixel so overhangs and crater walls look the same:
 *   - the untouched grass top catches the light (a slightly lighter edge)
 *   - torn paper edges (crater walls, freshly exposed ground) show pale fibres; cut felt edges
 *     are just a little lighter in their own colour
 *   - undersides of overhangs are in shadow
 * Each layer casts a small shadow on the one under it, and its torn bottom edge is pale.
 */
export class TerrainRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: Uint8ClampedArray;
  private W: number;
  private H: number;

  constructor(private terrain: Terrain) {
    this.W = terrain.width;
    this.H = terrain.height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false })!;
    this.texture = buildTexture(terrain);
    this.redraw(0, this.W - 1);
  }

  /** Swap in a new terrain (after a nuke or resync). */
  reset(terrain: Terrain) {
    this.terrain = terrain;
    this.texture = buildTexture(terrain);
    this.redraw(0, this.W - 1);
  }

  redraw(x0: number, x1: number) {
    const W = this.W;
    const H = this.H;
    x0 = Math.max(0, x0 - 3);
    x1 = Math.min(W - 1, x1 + 3);
    const w = x1 - x0 + 1;
    // Solid masks for the columns plus a 3px margin for edge detection.
    const m0 = Math.max(0, x0 - 3);
    const m1 = Math.min(W - 1, x1 + 3);
    const masks: Uint8Array[] = [];
    for (let x = m0; x <= m1; x++) {
      const mask = new Uint8Array(H);
      const c = this.terrain.cols[x];
      for (let i = 0; i < c.length; i += 2) mask.fill(1, Math.max(0, c[i]), Math.min(H, c[i + 1]));
      masks.push(mask);
    }
    const maskAt = (x: number) => (x < m0 || x > m1 ? null : masks[x - m0]);
    const img = this.ctx.createImageData(w, H);
    const out = img.data;
    const tex = this.texture;
    const surface = this.terrain.surface;
    const cut = !!groundLook().cut;
    for (let x = x0; x <= x1; x++) {
      const m = maskAt(x)!;
      const ml = maskAt(x - 1);
      const mr = maskAt(x + 1);
      const ml2 = maskAt(x - 2);
      const mr2 = maskAt(x + 2);
      const s = surface[x];
      for (let y = 0; y < H; y++) {
        if (!m[y]) continue;
        const o = (y * w + (x - x0)) * 4;
        const t = (y * W + x) * 4;
        let r = tex[t];
        let g = tex[t + 1];
        let b = tex[t + 2];
        const airUp1 = y === 0 || !m[y - 1];
        const airSide1 = (ml ? !ml[y] : false) || (mr ? !mr[y] : false);
        const airDown1 = y + 1 < H && !m[y + 1];
        // The original grass top, still there.
        const originalTop = y - s >= 0 && y - s < 3;
        if (airUp1 || airSide1 || airDown1) {
          if (airUp1 && originalTop) [r, g, b] = mix(r, g, b, 255, 255, 240, 0.28);
          else if (airDown1 && !airUp1) [r, g, b] = [r * 0.62, g * 0.62, b * 0.68];
          else if (cut) [r, g, b] = [Math.min(255, r * 1.18), Math.min(255, g * 1.18), Math.min(255, b * 1.18)];
          else [r, g, b] = mix(r, g, b, 250, 243, 226, 0.78);
        } else {
          let nearUp = 0;
          for (let k = 2; k <= 4; k++) {
            if (y - k < 0 || !m[y - k]) {
              nearUp = k;
              break;
            }
          }
          const nearSide = (ml2 ? !ml2[y] : false) || (mr2 ? !mr2[y] : false) || (ml ? !ml[y - 1] || !ml[y + 1] : false) || (mr ? !mr[y - 1] || !mr[y + 1] : false);
          const original = y - s >= 0 && y - s < 9;
          if (cut) {
            /* felt: no pale fibres inside the cut */
          } else if (!original && (nearUp === 2 || nearSide)) [r, g, b] = mix(r, g, b, 250, 243, 226, 0.5);
          else if (!original && nearUp === 3) [r, g, b] = mix(r, g, b, 250, 243, 226, 0.2);
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 255;
      }
    }
    this.ctx.putImageData(img, x0, 0);
  }
}

function mix(r: number, g: number, b: number, r2: number, g2: number, b2: number, k: number): [number, number, number] {
  return [r + (r2 - r) * k, g + (g2 - g) * k, b + (b2 - b) * k];
}

function hash(x: number, y: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothNoise(x: number, scale: number, seed: number) {
  const fx = x / scale;
  const i = Math.floor(fx);
  const t = fx - i;
  const s = t * t * (3 - 2 * t);
  const a = hash(i, seed);
  const b = hash(i + 1, seed);
  return a + (b - a) * s;
}

/**
 * Looks for the ground: the layers under the grass, top to bottom, repeating (`shade` darkens a
 * paper), and how thick each is. Colours close together read as one hillside; the first look
 * (peach, kraft, butter at full strength) read as sherbet.
 */
type Ground = {
  layers: { paper: PaperName; shade: number }[];
  depth: number;
  /** The grass on top (default grass). */
  grass?: PaperName;
  /** Below the layers, the ground is this all the way down (instead of the layers repeating). */
  deep?: PaperName;
  /** Felt is cut, not torn: smooth edges (no pale fibres, barely any wobble). */
  cut?: boolean;
};
const GROUNDS: Record<string, Ground> = {
  // Brown paper in four close shades.
  kraft: {
    layers: [
      { paper: 'kraft', shade: 1 },
      { paper: 'kraft', shade: 0.88 },
      { paper: 'kraft', shade: 0.95 },
      { paper: 'kraft', shade: 0.82 },
    ],
    depth: 64,
  },
  // Brown with rust and ochre, all toned down.
  earth: {
    layers: [
      { paper: 'kraft', shade: 0.97 },
      { paper: 'peach', shade: 0.78 },
      { paper: 'kraft', shade: 0.84 },
      { paper: 'butter', shade: 0.8 },
    ],
    depth: 60,
  },
  // Felt (the user's Tanks mock): olive grass, then tan, orange and rust layers over charcoal.
  felt: {
    layers: [
      { paper: 'kraft', shade: 1.04 },
      { paper: 'orange', shade: 1 },
      { paper: 'rust', shade: 1 },
    ],
    depth: 58,
    grass: 'olive',
    deep: 'charcoal',
    cut: true,
  },
  // Red canyon clay.
  clay: {
    layers: [
      { paper: 'peach', shade: 0.86 },
      { paper: 'peach', shade: 0.74 },
      { paper: 'kraft', shade: 0.9 },
      { paper: 'peach', shade: 0.8 },
    ],
    depth: 66,
  },
};
/** In development, ?ground=kraft|earth|clay|felt on the page you start from tries the other looks. */
const GROUND_PICK = import.meta.env.DEV ? new URLSearchParams(location.search).get('ground') : null;
function groundLook(): Ground {
  return (GROUND_PICK && GROUNDS[GROUND_PICK]) || GROUNDS.felt;
}
/** Flat colours, if the paper sheets aren't loaded (never in practice). */
const FLAT: Record<string, [number, number, number]> = {
  grass: [71, 134, 83],
  kraft: [187, 146, 106],
  peach: [242, 189, 150],
  butter: [247, 227, 162],
  olive: [116, 141, 58],
  orange: [212, 135, 60],
  rust: [176, 70, 47],
  charcoal: [62, 61, 67],
};

/** Paper strata that follow the generated surface, with torn edges between them. */
function buildTexture(terrain: Terrain): Uint8ClampedArray {
  const W = terrain.width;
  const H = terrain.height;
  const data = new Uint8ClampedArray(W * H * 4);
  const papers = getGroundPapers();
  const look = groundLook();
  const LAYERS = look.layers;
  const LAYER_DEPTH = look.depth;
  /** How far the shadow under each strip reaches. */
  const SHADOW = 9;
  // Where each torn edge runs: a slow wave, plus small rips that change every few pixels.
  const wobble: number[] = [];
  const grassEdge: number[] = [];
  for (let x = 0; x < W; x++) {
    // A gentle wave (the first layer under the grass stays thick).
    wobble.push(smoothNoise(x, 90, 7) * 18 + smoothNoise(x, 23, 11) * 6);
    grassEdge.push(25 + smoothNoise(x, 40, 5) * 9 + (smoothNoise(x, 3, 19) - 0.5) * (look.cut ? 0.8 : 3));
  }
  const tearAt = (x: number, band: number) => (smoothNoise(x, 2.6, 31 + band * 7) - 0.5) * (look.cut ? 0.8 : 4);
  const sample = (p: PaperPixels | undefined, name: string, x: number, y: number): [number, number, number] => {
    if (!p) return FLAT[name];
    const i = ((y % p.size) * p.size + (x % p.size)) * 4;
    return [p.data[i], p.data[i + 1], p.data[i + 2]];
  };
  for (let x = 0; x < W; x++) {
    const s = terrain.surface[x];
    const ge = grassEdge[x];
    for (let y = 0; y < H; y++) {
      const depth = y - s;
      let r: number, g: number, b: number;
      let fromTop: number; // distance below the edge of the layer above (for its shadow)
      let toBottom: number; // distance above this layer's own torn bottom edge
      if (depth < ge) {
        const grass = look.grass ?? 'grass';
        [r, g, b] = sample(papers?.[grass], grass, x, y);
        fromTop = 99;
        toBottom = ge - depth;
      } else {
        const d = depth - ge + wobble[x];
        const band = Math.floor(d / LAYER_DEPTH);
        // Each band's top edge is torn a little differently.
        const within = d - band * LAYER_DEPTH;
        const tear = tearAt(x, band);
        const inBand = within + tear < 0 ? band - 1 : band;
        const layer =
          look.deep && inBand >= LAYERS.length
            ? { paper: look.deep, shade: 1 }
            : LAYERS[((inBand % LAYERS.length) + LAYERS.length) % LAYERS.length];
        [r, g, b] = sample(papers?.[layer.paper], layer.paper, x, y);
        r *= layer.shade;
        g *= layer.shade;
        b *= layer.shade;
        fromTop = inBand === band ? within + tear : 99;
        const next = (band + 1) * LAYER_DEPTH + tearAt(x, band + 1);
        toBottom = inBand === band ? next - d : -(within + tear);
        // Deep down it's one thick sheet: no edges between its bands.
        if (look.deep && inBand > LAYERS.length) fromTop = toBottom = 99;
        if (depth < ge + SHADOW) fromTop = depth - ge; // right under the grass
      }
      // Strips of paper on top of each other: the layer above casts a shadow on this one (darkest
      // right under its edge), each strip is a little lighter at its top than its bottom, and its
      // own torn bottom edge shows pale fibres.
      if (fromTop >= 0 && fromTop < SHADOW) {
        const t = fromTop / SHADOW;
        const k = 0.6 + 0.4 * t * t * (3 - 2 * t);
        r *= k;
        g *= k;
        b *= k;
      } else if (!look.cut && toBottom >= 0 && toBottom < 2.2) {
        [r, g, b] = mix(r, g, b, 252, 247, 234, 0.5);
      }
      if (fromTop >= 0 && fromTop < 99) {
        const k = 1.04 - 0.1 * Math.min(1, fromTop / LAYER_DEPTH);
        r *= k;
        g *= k;
        b *= k;
      }
      // Deeper is a touch darker.
      const dark = 1 - Math.min(0.16, Math.max(0, depth) / 2600);
      const i = (y * W + x) * 4;
      data[i] = r * dark;
      data[i + 1] = g * dark;
      data[i + 2] = b * dark;
      data[i + 3] = 255;
    }
  }
  return data;
}
