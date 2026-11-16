// Slices "Original Requirements/Vibrant artillery game sprite atlas-1.png" into trimmed,
// downscaled sprites under packages/client/public/sprites, plus a manifest with sizes.
// Run with: npm run sprites
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const ATLAS = 'Original Requirements/Vibrant artillery game sprite atlas-1.png';
const OUT_DIR = 'packages/client/public/sprites';

// Cell grid from inspecting occupied column/row runs of the atlas.
const COLS: [number, number][] = [[40, 360], [380, 720], [730, 1080], [1100, 1420]];
const ROWS: [number, number][] = [[60, 360], [400, 700], [780, 1040]];

interface SpriteSpec {
  name: string;
  row: number;
  col: number;
  /** Output scale relative to the source pixels. */
  scale: number;
}

// Tank body and turret share one scale so they stay proportional.
const TANK_SCALE = 0.5;
const SPECS: SpriteSpec[] = [
  { name: 'tank-body', row: 0, col: 0, scale: TANK_SCALE },
  { name: 'tank-turret', row: 0, col: 1, scale: TANK_SCALE },
  { name: 'helicopter', row: 0, col: 2, scale: 0.5 },
  { name: 'parachute', row: 0, col: 3, scale: 0.5 },
  { name: 'shell', row: 1, col: 0, scale: 0.3 },
  { name: 'explosion', row: 1, col: 1, scale: 0.6 },
  { name: 'smoke', row: 1, col: 2, scale: 0.5 },
  { name: 'heart', row: 1, col: 3, scale: 0.35 },
  { name: 'windsock', row: 2, col: 1, scale: 0.35 },
  { name: 'windsock-calm', row: 2, col: 2, scale: 0.35 },
];

const atlas = PNG.sync.read(fs.readFileSync(ATLAS));

function alphaAt(x: number, y: number) {
  return atlas.data[(y * atlas.width + x) * 4 + 3];
}

function trimmedBox(x0: number, x1: number, y0: number, y1: number) {
  let minX = x1, maxX = x0, minY = y1, maxY = y0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (alphaAt(x, y) > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  // 2px transparent padding so filtering never clips the outline.
  return { x: minX - 2, y: minY - 2, w: maxX - minX + 5, h: maxY - minY + 5 };
}

/** Area-averaging downscale with premultiplied alpha. */
function downscale(box: { x: number; y: number; w: number; h: number }, scale: number) {
  const ow = Math.max(1, Math.round(box.w * scale));
  const oh = Math.max(1, Math.round(box.h * scale));
  const out = new PNG({ width: ow, height: oh });
  const sx = box.w / ow;
  const sy = box.h / oh;
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      const fx0 = box.x + ox * sx, fx1 = fx0 + sx;
      const fy0 = box.y + oy * sy, fy1 = fy0 + sy;
      for (let y = Math.floor(fy0); y < Math.ceil(fy1); y++) {
        const wy = Math.min(fy1, y + 1) - Math.max(fy0, y);
        if (wy <= 0) continue;
        for (let x = Math.floor(fx0); x < Math.ceil(fx1); x++) {
          const wx = Math.min(fx1, x + 1) - Math.max(fx0, x);
          if (wx <= 0) continue;
          const w = wx * wy;
          let pr = 0, pg = 0, pb = 0, pa = 0;
          if (x >= 0 && y >= 0 && x < atlas.width && y < atlas.height) {
            const i = (y * atlas.width + x) * 4;
            pa = atlas.data[i + 3] / 255;
            pr = atlas.data[i] * pa;
            pg = atlas.data[i + 1] * pa;
            pb = atlas.data[i + 2] * pa;
          }
          r += pr * w; g += pg * w; b += pb * w; a += pa * w; wsum += w;
        }
      }
      const i = (oy * ow + ox) * 4;
      const fa = a / wsum;
      out.data[i] = fa > 0 ? Math.round(r / wsum / fa) : 0;
      out.data[i + 1] = fa > 0 ? Math.round(g / wsum / fa) : 0;
      out.data[i + 2] = fa > 0 ? Math.round(b / wsum / fa) : 0;
      // Snap near-opaque pixels to fully opaque; the source is ~250 alpha everywhere.
      const alpha = Math.round(fa * 255);
      out.data[i + 3] = alpha >= 236 ? 255 : alpha;
    }
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const manifest: Record<string, { w: number; h: number; srcW: number; srcH: number }> = {};
for (const spec of SPECS) {
  const [x0, x1] = COLS[spec.col];
  const [y0, y1] = ROWS[spec.row];
  const box = trimmedBox(x0, x1, y0, y1);
  const png = downscale(box, spec.scale);
  fs.writeFileSync(path.join(OUT_DIR, `${spec.name}.png`), PNG.sync.write(png));
  manifest[spec.name] = { w: png.width, h: png.height, srcW: box.w, srcH: box.h };
  console.log(spec.name, box, '->', png.width, 'x', png.height);
}
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
