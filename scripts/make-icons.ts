// Builds the home-screen icons (icon-192.png, icon-512.png) from the tank sprites.
// Run with: npx tsx scripts/make-icons.ts
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const SPRITES = 'packages/client/public/sprites';
const OUT = 'packages/client/public';
const body = PNG.sync.read(fs.readFileSync(path.join(SPRITES, 'tank-body.png')));
const turret = PNG.sync.read(fs.readFileSync(path.join(SPRITES, 'tank-turret.png')));

function blend(dst: PNG, x: number, y: number, r: number, g: number, b: number, a: number) {
  if (x < 0 || y < 0 || x >= dst.width || y >= dst.height || a <= 0) return;
  const i = (y * dst.width + x) * 4;
  const da = dst.data[i + 3] / 255;
  const oa = a + da * (1 - a);
  dst.data[i] = (r * a + dst.data[i] * da * (1 - a)) / oa;
  dst.data[i + 1] = (g * a + dst.data[i + 1] * da * (1 - a)) / oa;
  dst.data[i + 2] = (b * a + dst.data[i + 2] * da * (1 - a)) / oa;
  dst.data[i + 3] = oa * 255;
}

/** Draw src scaled (bilinear) with its top-left at (dx, dy), optionally rotated about (px, py). */
function draw(dst: PNG, src: PNG, dx: number, dy: number, scale: number, angle = 0, px = 0, py = 0) {
  const w = src.width * scale;
  const h = src.height * scale;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pad = Math.max(w, h);
  for (let y = Math.floor(dy - pad); y < dy + h + pad; y++) {
    for (let x = Math.floor(dx - pad); x < dx + w + pad; x++) {
      // Inverse-rotate about the pivot (in destination space).
      const rx = cos * (x - dx - px) + sin * (y - dy - py) + px;
      const ry = -sin * (x - dx - px) + cos * (y - dy - py) + py;
      const sx = rx / scale;
      const sy = ry / scale;
      if (sx < 0 || sy < 0 || sx >= src.width - 1 || sy >= src.height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const px4 = (xx: number, yy: number, c: number) => src.data[(yy * src.width + xx) * 4 + c];
      const lerp = (c: number) =>
        px4(x0, y0, c) * (1 - fx) * (1 - fy) + px4(x0 + 1, y0, c) * fx * (1 - fy) + px4(x0, y0 + 1, c) * (1 - fx) * fy + px4(x0 + 1, y0 + 1, c) * fx * fy;
      blend(dst, x, y, lerp(0), lerp(1), lerp(2), lerp(3) / 255);
    }
  }
}

for (const size of [192, 512]) {
  const png = new PNG({ width: size, height: size });
  // Sky gradient background with a purple hill.
  for (let y = 0; y < size; y++) {
    const t = y / size;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const hill = y > size * (0.72 + 0.06 * Math.sin((x / size) * Math.PI));
      png.data[i] = hill ? 130 : 42 + 40 * t;
      png.data[i + 1] = hill ? 50 : 85 + 20 * t;
      png.data[i + 2] = hill ? 128 : 230 - 10 * t;
      png.data[i + 3] = 255;
    }
  }
  const scale = (size * 0.62) / body.width;
  const bx = (size - body.width * scale) / 2;
  const by = size * 0.74 - body.height * scale;
  // Turret pivot is at (32, 24) in sprite pixels; aim it 35 degrees up.
  const tpx = 32 * scale;
  const tpy = 24 * scale;
  draw(png, turret, size / 2 - tpx - size * 0.02, by - tpy + size * 0.05, scale, -0.6, tpx, tpy);
  draw(png, body, bx, by, scale);
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), PNG.sync.write(png));
  console.log(`icon-${size}.png`);
}
