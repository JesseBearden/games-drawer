import type { Terrain } from '@tank/shared';

/**
 * Paints the destructible terrain into a world-sized canvas. A banded dirt texture is
 * generated once per map; after each crater only the affected columns are repainted.
 *
 * Edges are drawn per pixel so overhangs and crater walls get the same crisp outline:
 *   - a dark outline where solid meets air
 *   - green grass on the untouched original surface
 *   - an orange rim on freshly exposed dirt
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
        // Distance (in px, up to 4) to the nearest air above/side.
        const airUp1 = y === 0 || !m[y - 1];
        const airSide1 = (ml ? !ml[y] : false) || (mr ? !mr[y] : false);
        const airDown1 = y + 1 < H && !m[y + 1];
        let r: number, g: number, b: number;
        if (airUp1 || airSide1 || airDown1) {
          // Outline
          r = 38;
          g = 18;
          b = 52;
        } else {
          let nearUp = 0;
          for (let k = 2; k <= 6; k++) {
            if (y - k < 0 || !m[y - k]) {
              nearUp = k;
              break;
            }
          }
          const nearSide =
            (ml2 ? !ml2[y] : false) || (mr2 ? !mr2[y] : false) || (ml ? !ml[y - 1] || !ml[y + 1] : false) || (mr ? !mr[y - 1] || !mr[y + 1] : false);
          const original = y - s >= 0 && y - s < 9 && nearUp > 0;
          if (original && nearUp <= 5) {
            // Grass
            const shade = nearUp <= 2 ? 1 : 0.82;
            r = 120 * shade;
            g = 214 * shade;
            b = 72 * shade;
          } else if (nearUp > 0 && nearUp <= 4) {
            r = 233;
            g = 128;
            b = 58;
          } else if (nearSide) {
            r = 214;
            g = 108;
            b = 60;
          } else {
            r = tex[t];
            g = tex[t + 1];
            b = tex[t + 2];
          }
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

/** Purple strata that follow the generated surface, like the concept art. */
function buildTexture(terrain: Terrain): Uint8ClampedArray {
  const W = terrain.width;
  const H = terrain.height;
  const data = new Uint8ClampedArray(W * H * 4);
  const bands = [
    [150, 62, 140],
    [128, 48, 124],
    [140, 56, 132],
    [112, 40, 110],
  ];
  const wobble: number[] = [];
  for (let x = 0; x < W; x++) wobble.push(smoothNoise(x, 90, 7) * 26 + smoothNoise(x, 23, 11) * 8);
  for (let x = 0; x < W; x++) {
    const s = terrain.surface[x];
    for (let y = 0; y < H; y++) {
      const depth = y - s;
      const d = Math.max(0, depth * 0.85 + wobble[x]);
      const band = Math.floor(d / 46);
      const base = bands[((band % bands.length) + bands.length) % bands.length];
      // Darken with depth, plus subtle speckles ("pebbles").
      const dark = 1 - Math.min(0.32, Math.max(0, depth) / 1600);
      const speck = hash(x >> 2, y >> 2) > 0.985 ? 0.82 : 1;
      const edge = (d % 46) < 3 ? 0.9 : 1;
      const k = dark * speck * edge;
      const i = (y * W + x) * 4;
      data[i] = base[0] * k;
      data[i + 1] = base[1] * k;
      data[i + 2] = base[2] * k;
      data[i + 3] = 255;
    }
  }
  return data;
}
