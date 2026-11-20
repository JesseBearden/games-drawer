// Draw the ivory the felt look's dominoes are made of: one seamless tile of warm cream with a
// faint grain running one way (ivory and bone grow in fine layers), slightly yellower in the
// darker streaks, and no shine (it's a satin finish). Low contrast on purpose: it should read as
// a material, not a pattern.
// Usage: node scripts/ivory-texture.cjs [out.webp]   (default packages/client/public/art/ivory.webp)
const path = require('node:path');
const sharp = require('sharp');

const REPO = path.resolve(__dirname, '..');
const OUT = process.argv[2] ?? path.join(REPO, 'packages/client/public/art/ivory.webp');
const N = 512;
const BASE = [244, 236, 219]; // #f4ecdb
const STREAK = [233, 220, 192]; // the darker, yellower grain

function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth noise that repeats every tile, with cx cells across and cy cells down. */
function noise(rnd, cx, cy) {
  const g = Array.from({ length: cx * cy }, () => rnd() * 2 - 1);
  const at = (i, j) => g[(((j % cy) + cy) % cy) * cx + (((i % cx) + cx) % cx)];
  const s = (t) => t * t * (3 - 2 * t);
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const gy = (y / N) * cy, j = Math.floor(gy), ty = s(gy - j);
    for (let x = 0; x < N; x++) {
      const gx = (x / N) * cx, i = Math.floor(gx), tx = s(gx - i);
      const a = at(i, j) * (1 - tx) + at(i + 1, j) * tx;
      const b = at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx;
      out[y * N + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

(async () => {
  const rnd = mulberry(4242);
  // Grain runs down the tile: many cells across, few down, so the streaks are long and thin.
  const layers = [
    [noise(rnd, 10, 2), 0.55],
    [noise(rnd, 24, 3), 0.35],
    [noise(rnd, 56, 4), 0.2],
    [noise(rnd, 6, 6), 0.25], // soft clouding, so the streaks aren't perfectly even
  ];
  const v = new Float32Array(N * N);
  for (const [l, a] of layers) for (let i = 0; i < v.length; i++) v[i] += l[i] * a;
  let lo = Infinity, hi = -Infinity;
  for (const x of v) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
  const px = Buffer.alloc(N * N * 3);
  for (let i = 0; i < v.length; i++) {
    // 0 = base ivory, 1 = full streak; most of the tile stays near the base.
    const t = Math.max(0, (v[i] - lo) / (hi - lo) - 0.35) / 0.65;
    const k = t * t * 0.7;
    for (let c = 0; c < 3; c++) px[i * 3 + c] = Math.round(BASE[c] + (STREAK[c] - BASE[c]) * k);
  }
  await sharp(px, { raw: { width: N, height: N, channels: 3 } }).webp({ quality: 92 }).toFile(OUT);
  console.log(path.relative(REPO, OUT));
})();
