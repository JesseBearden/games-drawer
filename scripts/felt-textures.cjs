// Draw the felt sheets: one seamless 768 px tile per colour, shown at 384 CSS px.
//
// Felt is a mat of crimped wool fibres, so each sheet is built like one: thousands of short,
// curly fibres are laid on top of each other at random depths (a height map), then lit from
// above, so every fibre has a bright top and a shadowed underside. Heathered felt (the grey mat)
// also mixes lighter and darker wool, and every fibre is dyed a touch differently.
//
// Everything is matched to the user's felt swatch sheet (2026-11-20), colour by colour, by
// measuring their swatch and ours the same way, at the size they're seen (CSS pixels):
//   colour  the swatch's average colour
//   grain   how much the lightness varies (Lab L sd)
//   clumps  soft variation 3-6 px across (brightness sd, 0-255)
//   tint    how much the hue wanders (Lab a and b sd); we use 60% of it, fibre by fibre, since
//           their JPEG adds colour noise of its own and big hue patches look blotchy
//   skew    which way the grain leans: negative, soft dark flecks on a lighter body (light felt);
//           positive, bright fibres on a darker body (strong dark colours)
//   paler   how chroma changes with lightness (negative: lighter fibres are paler)
// plus looks of our own: heather (mixed lighter and darker wool; with blend, distinct light, mid
// and dark wools rather than shades of one), sharp (how crisp the strands are, default 0.9; lower
// is crisper), thick (strand width, x1 by default), density (how many strands; fewer lets the dark
// gaps between them show) and curl (0 wavy strands,
// 1 tight boucle loops).
// Everything wraps at the edges, so the tiles repeat without seams.
//
// Usage: node scripts/felt-textures.cjs [outDir] [name,name...]
//        (default packages/client/public/art/felt, every colour)
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const REPO = path.resolve(__dirname, '..');
const OUT = process.argv[2] ?? path.join(REPO, 'packages/client/public/art/felt');
const N = 768;

const FELTS = {
  paper: { colour: '#e9dac4', grain: 2.1, skew: -0.31, clumps: 1.0, tint: [0.73, 1.17], paler: -0.25, heather: 0.15, curl: 0 },
  // White: calmer than the swatch (user, 2026-11-20: it read a little dirty), so finer grain, few
  // dark flecks and hardly any hue wander.
  white: { colour: '#f6f2ea', grain: 1.1, skew: -0.08, clumps: 0.45, tint: [0.3, 0.45], paler: -0.2, heather: 0.05, curl: 0 },
  // Grey heather: a mix of light grey and charcoal wools (blend), crisp strands (sharp).
  mat: { colour: '#7e828d', grain: 8.1, skew: -0.08, clumps: 3.2, tint: [0.62, 0.61], paler: -0.02, heather: 2.2, curl: 0.5, blend: true, sharp: 0.6, thick: 1.5, density: 0.55 },
  cobalt: { colour: '#062fae', grain: 3.7, skew: 0.53, clumps: 1.4, tint: [2.61, 1.72], paler: -0.1, heather: 0.2, curl: 0 },
  sunflower: { colour: '#fbb505', grain: 2.1, skew: -0.5, clumps: 1.0, tint: [2.37, 1.31], paler: 0.44, heather: 0.1, curl: 0 },
  tomato: { colour: '#dc1218', grain: 2.5, skew: 0.44, clumps: 1.2, tint: [1.5, 1.54], paler: 0.16, heather: 0.15, curl: 0 },
  grass: { colour: '#4d842c', grain: 6.4, skew: 0.06, clumps: 2.3, tint: [1.03, 1.22], paler: 0.02, heather: 0.35, curl: 0 },
  sky: { colour: '#76b1e6', grain: 4.7, skew: -0.25, clumps: 1.8, tint: [1.19, 2.02], paler: -0.25, heather: 0.3, curl: 0.4 },
  mint: { colour: '#a9dab3', grain: 3.0, skew: -0.33, clumps: 1.3, tint: [0.81, 0.6], paler: -0.14, heather: 0.2, curl: 0 },
  butter: { colour: '#f6df8a', grain: 2.0, skew: -0.31, clumps: 0.8, tint: [0.84, 2.24], paler: -0.62, heather: 0.1, curl: 0 },
  lilac: { colour: '#bba0d5', grain: 5.0, skew: -0.27, clumps: 1.9, tint: [0.82, 1.07], paler: -0.14, heather: 0.35, curl: 0.5 },
  peach: { colour: '#f8b493', grain: 2.8, skew: -0.3, clumps: 1.3, tint: [2.12, 1.72], paler: -0.65, heather: 0.15, curl: 0 },
  blush: { colour: '#f6b5bd', grain: 2.7, skew: -0.36, clumps: 1.2, tint: [1.85, 0.64], paler: -0.46, heather: 0.15, curl: 0 },
  kraft: { colour: '#c19a71', grain: 5.2, skew: -0.17, clumps: 2.1, tint: [0.8, 1.03], paler: -0.14, heather: 0.5, curl: 0 },
  // The green card-table felt from the user's Dominoes mock (measured there, not on the swatch sheet).
  baize: { colour: '#617b57', grain: 3.55, skew: 0.04, clumps: 1.5, tint: [0.55, 0.53], paler: -0.07, heather: 0.2, curl: 0 },
  // Lighter, calmer tables to try under Jigsaw, so the pieces stand out (2026-11-20).
  // Jigsaw's table: light grey and calm (about two-thirds the grain of the swatches), so the
  // pieces, with their shadows, stand out.
  dove: { colour: '#b4b7bc', grain: 2.1, skew: -0.2, clumps: 0.8, tint: [0.4, 0.45], paler: -0.05, heather: 0.15, curl: 0 },
  sage: { colour: '#8ea888', grain: 3.5, skew: 0, clumps: 1.4, tint: [0.55, 0.53], paler: -0.07, heather: 0.2, curl: 0 },
  // Tanks' battlefield, from the user's felt Tanks mock (2026-11-20): a muted sky, slate-blue
  // mountains, and ground in layers (olive grass, then tan (kraft), orange, rust and charcoal).
  air: { colour: '#a3bfd9', grain: 2.4, skew: -0.2, clumps: 1.0, tint: [0.5, 0.6], paler: -0.1, heather: 0.15, curl: 0 },
  mist: { colour: '#a9bccf', grain: 3.0, skew: -0.2, clumps: 1.2, tint: [0.5, 0.6], paler: -0.1, heather: 0.2, curl: 0 },
  slate: { colour: '#7f97b2', grain: 3.6, skew: 0, clumps: 1.4, tint: [0.6, 0.7], paler: -0.1, heather: 0.25, curl: 0 },
  olive: { colour: '#748d3a', grain: 5.0, skew: 0.05, clumps: 1.8, tint: [0.9, 1.0], paler: 0, heather: 0.3, curl: 0 },
  orange: { colour: '#d4873c', grain: 3.6, skew: 0, clumps: 1.4, tint: [1.2, 1.2], paler: -0.1, heather: 0.15, curl: 0 },
  rust: { colour: '#b0462f', grain: 3.6, skew: 0.2, clumps: 1.4, tint: [1.2, 1.2], paler: 0, heather: 0.15, curl: 0 },
  charcoal: { colour: '#3e3d43', grain: 4.0, skew: 0.3, clumps: 1.5, tint: [0.4, 0.4], paler: 0, heather: 0.4, curl: 0 },
};

function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rnd) => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const wrap = (v) => ((v % N) + N) % N;

/**
 * Lay the fibres: each is a round strand at its own depth; where strands cross, the higher one
 * shows. Returns the height of the top strand at each pixel, that strand's wool shade, and its
 * dye (a small shift in hue).
 */
function layFibres(rnd, curl, blend, thick = 1, density = 1) {
  const height = new Float32Array(N * N);
  const wool = new Float32Array(N * N);
  const dyeA = new Float32Array(N * N);
  const dyeB = new Float32Array(N * N);
  const count = Math.round(52000 * density);
  for (let i = 0; i < count; i++) {
    // Most fibres lie roughly along the sheet (felt is laid down in one direction), some any way.
    const a0 = rnd() < 0.6 ? gauss(rnd) * 0.6 + (rnd() < 0.5 ? 0 : Math.PI) : rnd() * Math.PI * 2;
    let x = rnd() * N, y = rnd() * N, a = a0;
    // Crimped wool: wavy strands that bend one way, then the other, now and then looping.
    const len = (24 + rnd() * 46) * (1 - 0.45 * curl);
    let bend = (rnd() < 0.5 ? -1 : 1) * (0.02 + rnd() * 0.05) * (1 + 1.6 * curl);
    const r = (0.6 + rnd() * 0.35) * thick;
    const z = rnd() * 3;
    // Heathered felt mixes separate wools (light, mid, charcoal); plain felt varies a little.
    const pick = rnd();
    const shade = blend ? (pick < 0.4 ? 1.1 : pick < 0.72 ? 0 : -1.4) + gauss(rnd) * 0.2 : gauss(rnd);
    const da = gauss(rnd), db = gauss(rnd);
    for (let t = 0; t < len; t += 0.5) {
      // Thinner where it dives into the felt at each end.
      const taper = Math.min(1, t / 6, (len - t) / 6);
      const rr = r * (0.55 + 0.45 * taper);
      const top = z + taper * 0.8;
      const x0 = Math.floor(x - rr), x1 = Math.ceil(x + rr), y0 = Math.floor(y - rr), y1 = Math.ceil(y + rr);
      for (let py = y0; py <= y1; py++)
        for (let px = x0; px <= x1; px++) {
          const d2 = (px - x) ** 2 + (py - y) ** 2;
          if (d2 > rr * rr) continue;
          const hgt = top + Math.sqrt(1 - d2 / (rr * rr)) * rr;
          const k = wrap(py) * N + wrap(px);
          if (hgt > height[k]) {
            height[k] = hgt;
            wool[k] = shade;
            dyeA[k] = da;
            dyeB[k] = db;
          }
        }
      if (rnd() < 0.035) bend = -bend;
      a += bend + gauss(rnd) * 0.07;
      x += Math.cos(a) * 0.5;
      y += Math.sin(a) * 0.5;
    }
  }
  return { height, wool, dyeA, dyeB };
}

/** Soft tufts and clumps: smooth noise that repeats every tile, mostly 2-8 CSS px across. */
function clouds(rnd) {
  const buf = new Float32Array(N * N);
  for (const [cells, amp] of [[24, 0.15], [48, 0.45], [96, 1], [192, 0.7]]) {
    const g = Array.from({ length: cells * cells }, () => rnd() * 2 - 1);
    const at = (i, j) => g[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
    const smooth = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < N; y++) {
      const gy = (y / N) * cells, j = Math.floor(gy), ty = smooth(gy - j);
      for (let x = 0; x < N; x++) {
        const gx = (x / N) * cells, i = Math.floor(gx), tx = smooth(gx - i);
        const top = at(i, j) * (1 - tx) + at(i + 1, j) * tx;
        const bottom = at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx;
        buf[y * N + x] += amp * (top * (1 - ty) + bottom * ty);
      }
    }
  }
  return buf;
}

/** Blur a square n x n picture that wraps at its edges. */
function blurWrapped(src, n, sigma) {
  if (sigma === 0) return src;
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ks = k.reduce((a, b) => a + b, 0);
  const w = (v) => ((v % n) + n) % n;
  const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[y * n + w(x + i)] * k[i + r];
      tmp[y * n + x] = s / ks;
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[w(y + i) * n + x] * k[i + r];
      out[y * n + x] = s / ks;
    }
  return out;
}

/**
 * Light the fibres from above: a strand's upper edge faces the light, its lower edge is in its
 * own shadow, and the gaps deep in the felt get less light. Returns brightness around 0.
 */
function light(height, wool, heather, sharp = 0.9) {
  const h = blurWrapped(height, N, sharp);
  const deep = blurWrapped(height, N, 4);
  const L = [-0.25, -0.75, 0.6];
  const ln = Math.hypot(...L);
  const flat = L[2] / ln;
  const v = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const k = y * N + x;
      const gx = (h[y * N + wrap(x + 1)] - h[y * N + wrap(x - 1)]) / 2;
      const gy = (h[wrap(y + 1) * N + x] - h[wrap(y - 1) * N + x]) / 2;
      const nx = -gx, ny = -gy, nn = Math.hypot(nx, ny, 1);
      const diffuse = Math.max(0, (nx * L[0] + ny * L[1] + L[2]) / (nn * ln)) / flat - 1;
      const occlusion = Math.max(-0.45, Math.min(0.6, (h[k] - deep[k]) * 0.3));
      v[k] = diffuse * 0.9 + occlusion + wool[k] * heather * 0.35;
    }
  return v;
}

// ------------------------------------------------------------------ colour (CIE Lab, D65)

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toLin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function rgbToLab([r, g, b]) {
  const [R, G, B] = [toLin(r), toLin(g), toLin(b)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
// OKLab: like Lab, but lightening a strong blue keeps it blue (Lab drifts it towards purple).
function rgbToOk([r, g, b]) {
  const [R, G, B] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function okToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(fromLin);
}
function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  return [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z].map(fromLin);
}

/**
 * Paint (in OKLab): lightness moves with the fibres and clumps; chroma follows lightness the way the swatch
 * does (`paler`), so shadows on strong colours stay rich; each fibre's dye and a soft cloud nudge
 * the hue.
 */
function paint(f, k) {
  const [L0, a0, b0] = rgbToOk(f.base);
  const C0 = Math.hypot(a0, b0);
  const C0lab = Math.hypot(...rgbToLab(f.base).slice(1));
  const ua = C0 ? a0 / C0 : 0, ub = C0 ? b0 / C0 : 0;
  const px = new Float32Array(N * N * 3);
  for (let i = 0; i < N * N; i++) {
    // Shadows between fibres are softened by k.lean (more lean, fewer dark flecks).
    const v = f.v[i] >= 0 ? f.v[i] : -f.v[i] * -k.lean / (1 + -f.v[i] * 0.4);
    const dL = v * k.gain + f.cloud[i] * k.clump;
    const C = Math.max(0, C0 * (1 + (C0lab ? (f.paler * dL) / C0lab : 0)));
    const a = ua * C + f.dyeA[i] * k.tintA * 0.003;
    const b = ub * C + f.dyeB[i] * k.tintB * 0.003;
    const rgb = okToRgb([L0 + dL / 100, a, b]);
    px[i * 3] = rgb[0];
    px[i * 3 + 1] = rgb[1];
    px[i * 3 + 2] = rgb[2];
  }
  // Keep the average exactly the flat colour that shows before the texture loads.
  const out = Buffer.alloc(N * N * 3);
  for (let ch = 0; ch < 3; ch++) {
    let m = 0;
    for (let i = 0; i < N * N; i++) m += px[i * 3 + ch];
    const shift = f.base[ch] - m / (N * N);
    for (let i = 0; i < N * N; i++) out[i * 3 + ch] = Math.max(0, Math.min(255, Math.round(px[i * 3 + ch] + shift)));
  }
  return out;
}

/** Measure ours as the swatch was measured: shrunk to CSS pixels, then lightness, clumps and hue. */
async function measure(rgb) {
  const n = N / 2;
  const small = await sharp(rgb, { raw: { width: N, height: N, channels: 3 } }).resize(n, n, { kernel: 'lanczos3' }).raw().toBuffer();
  const Y = new Float32Array(n * n);
  const Ls = new Float32Array(n * n), As = new Float32Array(n * n), Bs = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const p = [small[i * 3], small[i * 3 + 1], small[i * 3 + 2]];
    Y[i] = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    [Ls[i], As[i], Bs[i]] = rgbToLab(p);
  }
  const sd = (v) => {
    let m = 0;
    for (const x of v) m += x;
    m /= v.length;
    let s = 0;
    for (const x of v) s += (x - m) ** 2;
    return Math.sqrt(s / v.length);
  };
  const b3 = blurWrapped(Y, n, 3), b6 = blurWrapped(Y, n, 6);
  const diff = b3.map((v, i) => v - b6[i]);
  let m = 0, s2 = 0, s3 = 0;
  for (const x of Ls) m += x;
  m /= Ls.length;
  for (const x of Ls) s2 += (x - m) ** 2;
  const sL = Math.sqrt(s2 / Ls.length);
  for (const x of Ls) s3 += ((x - m) / sL) ** 3;
  return { grain: sL, clumps: sd(diff), tintA: sd(As), tintB: sd(Bs), skew: s3 / Ls.length };
}

async function make(name, spec, seed) {
  const rnd = mulberry(seed);
  const { height, wool, dyeA, dyeB } = layFibres(rnd, spec.curl, spec.blend, spec.thick, spec.density);
  const f = {
    base: hex(spec.colour),
    paler: spec.paler,
    v: light(height, wool, spec.heather, spec.sharp),
    cloud: clouds(rnd),
    dyeA,
    dyeB,
  };
  // Turn each part up or down until ours measures like their swatch (each nudges the others a
  // little, so go round a few times).
  const k = { gain: 3, clump: 0.3, tintA: 0.5, tintB: 0.5, lean: 0.55 };
  let rgb = paint(f, k);
  let got;
  for (let i = 0; i < 9; i++) {
    got = await measure(rgb);
    k.gain *= spec.grain / got.grain;
    k.lean = Math.min(2.5, Math.max(0.15, k.lean * Math.exp((got.skew - spec.skew) * 0.9)));
    k.clump = Math.max(0, k.clump * (1 + (spec.clumps / got.clumps - 1) * 1.5));
    k.tintA = Math.max(0, k.tintA * (1 + ((spec.tint[0] * 0.6) / got.tintA - 1) * 1.5));
    k.tintB = Math.max(0, k.tintB * (1 + ((spec.tint[1] * 0.6) / got.tintB - 1) * 1.5));
    rgb = paint(f, k);
  }
  got = await measure(rgb);
  const file = path.join(OUT, `${name}.webp`);
  await sharp(rgb, { raw: { width: N, height: N, channels: 3 } }).webp({ quality: 92 }).toFile(file);
  return { file, k, got };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.argv[3]?.split(',');
  let seed = 1;
  for (const [name, spec] of Object.entries(FELTS)) {
    seed++;
    if (only && !only.includes(name)) continue;
    const { file, got } = await make(name, spec, seed * 7919);
    const g = (v) => v.toFixed(2).padStart(6);
    console.log(
      name.padEnd(10),
      (fs.statSync(file).size / 1024).toFixed(0).padStart(4) + ' KB',
      'grain',
      g(got.grain),
      'clumps',
      g(got.clumps),
      'tint',
      g(got.tintA),
      g(got.tintB),
      'skew',
      g(got.skew),
    );
  }
})();
