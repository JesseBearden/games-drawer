// Cut the user's felt Mahjong tiles (scripts/art/mahjong/felt-*.webp, 2026-11-23) into one sprite
// sheet for the game: packages/client/public/art/mahjong/felt.webp. Every face is cut to its solid
// body (the baked shadow left behind: the game draws its own depth) and sized to one tile shape.
// Cells follow the tile kinds in packages/shared/src/mahjong.ts (MJ_KINDS): dots 1-9, bamboo 1-9,
// characters 1-9, winds E S W N, dragons red green white, flowers 1-4, seasons 1-4; then the back
// (the middle of the three backs in backs-flat-felt-tile.webp: fuzzy blue felt).
// Usage: node scripts/mahjong-tiles.cjs
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');

const ART = path.join(__dirname, 'art/mahjong');
const OUT = path.join(__dirname, '../packages/client/public/art/mahjong');
/** One cell: the tile shape every face is sized to (about the faces' own average shape). */
const CW = 132;
const CH = 192;
const COLS = 9;

async function load(file) {
  const { data, info } = await sharp(path.join(ART, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height, file };
}

/** Runs of true along 0..n-1, longer than 20 px. */
function runs(n, f) {
  const r = [];
  let s = -1;
  for (let i = 0; i <= n; i++) {
    const v = i < n && f(i);
    if (v && s < 0) s = i;
    if (!v && s >= 0) {
      if (i - s > 20) r.push([s, i]);
      s = -1;
    }
  }
  return r;
}

/** Each tile's solid body (alpha > 250), row by row then left to right. */
function tiles(img) {
  const on = (x, y) => img.data[(y * img.W + x) * 4 + 3] > 250;
  const out = [];
  const rows = runs(img.H, (y) => {
    let c = 0;
    for (let x = 0; x < img.W; x++) if (on(x, y) && ++c > 5) return true;
    return false;
  });
  for (const [y0, y1] of rows) {
    const cols = runs(img.W, (x) => {
      for (let y = y0; y < y1; y++) if (on(x, y)) return true;
      return false;
    });
    for (const [x0, x1] of cols) {
      let top = Infinity, bottom = -1;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (on(x, y)) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
      out.push({ left: x0, top, width: x1 - x0, height: bottom - top + 1 });
    }
  }
  return out;
}

async function cell(img, box) {
  return sharp(path.join(ART, img.file)).extract(box).resize(CW, CH, { fit: 'fill' }).png().toBuffer();
}

(async () => {
  const dots = await load('felt-dots.webp');
  const bamboo = await load('felt-bamboo.webp');
  const chars = await load('felt-characters.webp');
  const honors = await load('felt-honors-flowers.webp');
  const backs = await load('backs-flat-felt-tile.webp');
  const faces = [];
  for (const img of [dots, bamboo, chars]) {
    const t = tiles(img);
    if (t.length !== 9) throw new Error(`${img.file}: found ${t.length} tiles, not 9`);
    for (const b of t) faces.push(await cell(img, b));
  }
  // Honours sheet: E S W N red / green white plum orchid bamboo / chrysanthemum spring summer autumn winter.
  const h = tiles(honors);
  if (h.length !== 15) throw new Error(`honours: found ${h.length} tiles, not 15`);
  for (const b of h) faces.push(await cell(honors, b));
  const b = tiles(backs);
  if (b.length !== 3) throw new Error(`backs: found ${b.length}, not 3`);
  faces.push(await cell(backs, b[1]));
  const rows = Math.ceil(faces.length / COLS);
  const sheet = sharp({ create: { width: CW * COLS, height: CH * rows, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(
    faces.map((input, i) => ({ input, left: (i % COLS) * CW, top: Math.floor(i / COLS) * CH })),
  );
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'felt.webp');
  await sheet.webp({ quality: 82, alphaQuality: 90, effort: 6 }).toFile(file);
  console.log(`${faces.length} cells, ${CW}x${CH}, ${COLS} across: ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
})();
