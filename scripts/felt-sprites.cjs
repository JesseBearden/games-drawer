// Cut Tanks' felt sprites out of the user's felt sprite sheet (scripts/art/felt-sprite-sheet.webp,
// 2026-11-21) into public/sprites, at the paper sprites' sizes, so the game draws them the same
// way. The tank's body and turret are grey felt in the sheet; the player-coloured parts (the
// hull and the turret's dome and barrel) are turned into the cyan the game recolours per player
// (sprites.ts tint), keeping the felt's light and dark. Tracks, wheels and the turret ring stay
// charcoal.
// Usage: node scripts/felt-sprites.cjs [sheet] [outDir]
// Prints the turret's pivot (dome centre, on the barrel's axis) for TURRET_PIVOT in renderer.ts.
const path = require('node:path');
const sharp = require('sharp');

const REPO = path.resolve(__dirname, '..');
const SHEET = process.argv[2] ?? path.join(__dirname, 'art/felt-sprite-sheet.webp');
const OUT = process.argv[3] ?? path.join(REPO, 'packages/client/public/sprites');

// Where each sprite sits in the sheet (a 4 x 3 grid), and how wide to make it (the paper sprites'
// widths, so everything stays the size it was in the game).
const CELLS = {
  body: [0, 0, 370, 360],
  turret: [370, 0, 720, 360],
  helicopter: [720, 0, 1080, 360, 274],
  parachute: [1080, 0, 1448, 360, 220],
  heart: [0, 360, 370, 720, 138],
  'heart-empty': [370, 360, 720, 720, 138],
  windsock: [1080, 360, 1448, 720, 152],
  smoke: [720, 720, 1080, 1086, 190],
};
const BODY_WIDTH = 232;

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** HSL (h in degrees, s and l 0-1) to RGB 0-255. */
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

async function load() {
  const { data, info } = await sharp(SHEET).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

/** Bounding box of the opaque pixels in a grid cell. */
function bbox(img, [x0, y0, x1, y1]) {
  let l = Infinity, t = Infinity, r = -1, b = -1;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (img.data[(y * img.W + x) * 4 + 3] > 30) {
        l = Math.min(l, x);
        r = Math.max(r, x);
        t = Math.min(t, y);
        b = Math.max(b, y);
      }
  return { left: l, top: t, width: r - l + 1, height: b - t + 1 };
}

/** Copy a box out of the sheet, as raw RGBA. */
function crop(img, box) {
  const out = Buffer.alloc(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) img.data.copy(out, y * box.width * 4, ((box.top + y) * img.W + box.left) * 4, ((box.top + y) * img.W + box.left + box.width) * 4);
  return { data: out, W: box.width, H: box.height };
}

/** Turn the player-coloured felt into the game's cyan (rows above `untilRow` only). */
function toCyan(px, untilRow, meanL) {
  for (let y = 0; y < Math.min(px.H, untilRow); y++)
    for (let x = 0; x < px.W; x++) {
      const i = (y * px.W + x) * 4;
      if (px.data[i + 3] < 10) continue;
      const l = lum(px.data[i], px.data[i + 1], px.data[i + 2]);
      const [r, g, b] = hsl(186, 0.66, Math.min(0.95, Math.max(0.06, (0.53 * l) / meanL)));
      px.data[i] = r;
      px.data[i + 1] = g;
      px.data[i + 2] = b;
    }
}

/** The first row (from the top) that's mostly dark: where the tracks begin. */
function trackTop(px, darker = 0.2, share = 0.35) {
  for (let y = Math.floor(px.H * 0.4); y < px.H; y++) {
    let dark = 0, n = 0;
    for (let x = 0; x < px.W; x++) {
      const i = (y * px.W + x) * 4;
      if (px.data[i + 3] < 128) continue;
      n++;
      if (lum(px.data[i], px.data[i + 1], px.data[i + 2]) < darker) dark++;
    }
    if (n && dark / n > share) return y;
  }
  return px.H;
}

function meanLum(px, untilRow) {
  let s = 0, n = 0;
  for (let y = 0; y < untilRow; y++)
    for (let x = 0; x < px.W; x++) {
      const i = (y * px.W + x) * 4;
      if (px.data[i + 3] < 200) continue;
      s += lum(px.data[i], px.data[i + 1], px.data[i + 2]);
      n++;
    }
  return s / n;
}

const save = (px, width, height, file) =>
  sharp(px.data, { raw: { width: px.W, height: px.H, channels: 4 } })
    .resize(width, height)
    .png()
    .toFile(path.join(OUT, file));

(async () => {
  const img = await load();

  // The tank: body and turret at one scale, so the turret fits the hull.
  const bodyBox = bbox(img, CELLS.body);
  const turretBox = bbox(img, CELLS.turret);
  const f = BODY_WIDTH / bodyBox.width;
  const body = crop(img, bodyBox);
  const tracks = trackTop(body);
  const meanL = meanLum(body, tracks);
  toCyan(body, tracks, meanL);
  await save(body, BODY_WIDTH, Math.round(bodyBox.height * f), 'tank-body.png');

  const turret = crop(img, turretBox);
  // The ring under the dome (dark) stays charcoal: find where the dome's light felt ends.
  const ring = trackTop(turret, 0.36, 0.5);
  // Barrel: the opaque rows in the turret's right fifth; its axis is their middle.
  const x0 = Math.floor(turret.W * 0.8);
  let ys = [];
  for (let y = 0; y < turret.H; y++) for (let x = x0; x < turret.W; x++) if (turret.data[(y * turret.W + x) * 4 + 3] > 128) ys.push(y);
  const axis = (Math.min(...ys) + Math.max(...ys)) / 2;
  // Dome: the opaque columns in the rows above the barrel; its centre is their middle.
  let xs = [];
  for (let y = 0; y < Math.floor(axis - 22); y++) for (let x = 0; x < turret.W; x++) if (turret.data[(y * turret.W + x) * 4 + 3] > 128) xs.push(x);
  const domeCentre = (Math.min(...xs) + Math.max(...xs)) / 2;
  toCyan(turret, ring, meanL);
  await save(turret, Math.round(turretBox.width * f), Math.round(turretBox.height * f), 'tank-turret.png');
  console.log(`body ${BODY_WIDTH}x${Math.round(bodyBox.height * f)} (tracks from row ${Math.round(tracks * f)}), turret ${Math.round(turretBox.width * f)}x${Math.round(turretBox.height * f)}`);
  console.log(`TURRET_PIVOT = { x: ${Math.round(domeCentre * f)}, y: ${Math.round(axis * f)} }; ring from row ${Math.round(ring * f)}`);

  // Everything else at the paper sprites' widths.
  for (const [name, cell] of Object.entries(CELLS)) {
    if (name === 'body' || name === 'turret') continue;
    const box = bbox(img, cell);
    const w = cell[4];
    await save(crop(img, box), w, Math.round((box.height * w) / box.width), `${name}.png`);
    console.log(name, w, Math.round((box.height * w) / box.width));
  }
})();
