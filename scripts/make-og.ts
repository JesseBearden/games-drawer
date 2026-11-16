// Builds the link-preview image (og.png, 1200x630) shown when an invite link is shared.
// It is drawn from the real terrain generator and sprites, so it looks like the game.
// Run with: npx tsx scripts/make-og.ts
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, generateTerrain, TANK_COLORS } from '../packages/shared/src/index';

const OUT = 'packages/client/public/og.png';
const SPRITES = 'packages/client/public/sprites';
const W = 1200;
const H = 630;
const load = (n: string) => PNG.sync.read(fs.readFileSync(path.join(SPRITES, `${n}.png`)));

const img = new PNG({ width: W, height: H });
const px = (x: number, y: number) => (y * W + x) * 4;

function blend(x: number, y: number, r: number, g: number, b: number, a: number) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = px(x, y);
  img.data[i] = r * a + img.data[i] * (1 - a);
  img.data[i + 1] = g * a + img.data[i + 1] * (1 - a);
  img.data[i + 2] = b * a + img.data[i + 2] * (1 - a);
  img.data[i + 3] = 255;
}

/** Bilinear-scaled sprite, optionally rotated about (px, py) in destination pixels and mirrored. */
function sprite(src: PNG, dx: number, dy: number, scale: number, angle = 0, pivX = 0, pivY = 0, flip = false, tint?: (r: number, g: number, b: number) => [number, number, number]) {
  const w = src.width * scale;
  const h = src.height * scale;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pad = Math.max(w, h);
  for (let y = Math.floor(dy - pad); y < dy + h + pad; y++) {
    for (let x = Math.floor(dx - pad); x < dx + w + pad; x++) {
      let lx = cos * (x - dx - pivX) + sin * (y - dy - pivY) + pivX;
      const ly = -sin * (x - dx - pivX) + cos * (y - dy - pivY) + pivY;
      if (flip) lx = w - lx;
      const sx = lx / scale;
      const sy = ly / scale;
      if (sx < 0 || sy < 0 || sx >= src.width - 1 || sy >= src.height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const s = (xx: number, yy: number, c: number) => src.data[(yy * src.width + xx) * 4 + c];
      const lerp = (c: number) => s(x0, y0, c) * (1 - fx) * (1 - fy) + s(x0 + 1, y0, c) * fx * (1 - fy) + s(x0, y0 + 1, c) * (1 - fx) * fy + s(x0 + 1, y0 + 1, c) * fx * fy;
      let [r, g, b] = [lerp(0), lerp(1), lerp(2)];
      if (tint) [r, g, b] = tint(r, g, b);
      blend(x, y, r, g, b, lerp(3) / 255);
    }
  }
}

/** Recolour cyan parts like the client does (tank colours). */
function tintTo(colorIndex: number) {
  const target = TANK_COLORS[colorIndex];
  return (r: number, g: number, b: number): [number, number, number] => {
    const rr = r / 255, gg = g / 255, bb = b / 255;
    const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
    const l = (max + min) / 2;
    if (max === min) return [r, g, b];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
    h *= 60;
    if (s < 0.3 || h < 150 || h > 215) return [r, g, b];
    const nl = Math.min(0.97, Math.max(0.05, (l / 0.56) * target.light));
    const ns = Math.min(1, s * target.sat);
    const c = (1 - Math.abs(2 * nl - 1)) * ns;
    const hp = target.hue / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [a, bq, cq] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = nl - c / 2;
    return [(a + m) * 255, (bq + m) * 255, (cq + m) * 255];
  };
}

// Sky
for (let y = 0; y < H; y++) {
  const t = y / H;
  for (let x = 0; x < W; x++) {
    const i = px(x, y);
    img.data[i] = 42 + 80 * t;
    img.data[i + 1] = 85 + 26 * t;
    img.data[i + 2] = 230 - 6 * t;
    img.data[i + 3] = 255;
  }
}

// Muted background mountains
for (const [base, amp, col, seed] of [
  [250, 120, [78, 95, 214], 3],
  [330, 100, [64, 80, 200], 9],
] as const) {
  for (let x = 0; x < W; x++) {
    const v = Math.sin(x * 0.011 + seed) * 0.5 + Math.sin(x * 0.027 + seed * 2) * 0.3 + Math.sin(x * 0.061 + seed) * 0.2;
    const top = base - v * amp;
    for (let y = Math.max(0, Math.floor(top)); y < H; y++) blend(x, y, col[0], col[1], col[2], 0.85);
  }
}

// Terrain from the real generator, framed on the interesting band.
const cfg = DEFAULT_CONFIG;
const terrain = generateTerrain(cfg, 20261115);
const scale = 0.85;
const worldX0 = 160;
const worldY0 = 170;
const bands = [
  [150, 62, 140],
  [128, 48, 124],
  [140, 56, 132],
  [112, 40, 110],
];
for (let x = 0; x < W; x++) {
  const wx = Math.floor(worldX0 + x / scale);
  const surf = terrain.surface[Math.min(cfg.worldWidth - 1, wx)];
  for (let y = 0; y < H; y++) {
    const wy = worldY0 + y / scale;
    if (!terrain.solidAt(wx, wy)) continue;
    const depth = wy - surf;
    const above = terrain.solidAt(wx, wy - 2 / scale);
    let c: number[];
    if (!above) c = [38, 18, 52];
    else if (depth < 7) c = [120, 214, 72];
    else if (depth < 11) c = [233, 128, 58];
    else {
      const n = Math.floor(Math.max(0, depth * 0.85 + Math.sin(wx * 0.01) * 20) / 46);
      const band = bands[n % bands.length];
      const k = 1 - Math.min(0.32, depth / 1600);
      c = band.map((v) => v * k);
    }
    blend(x, y, c[0], c[1], c[2], 1);
  }
}

const toScreen = (wx: number, wy: number) => [(wx - worldX0) * scale, (wy - worldY0) * scale];
const body = load('tank-body');
const turret = load('tank-turret');
const heli = load('helicopter');
const chute = load('parachute');
const boom = load('explosion');
const shell = load('shell');
const tankScale = 0.62;

function tank(wx: number, color: number, angleDeg: number) {
  const wy = terrain.groundBelow(wx, 0);
  const [sx, sy] = toScreen(wx, wy);
  const bw = body.width * tankScale;
  const bh = body.height * tankScale;
  const flip = angleDeg > 90;
  const a = ((flip ? 180 - angleDeg : angleDeg) * Math.PI) / 180;
  const pivX = 32 * tankScale;
  const pivY = 24 * tankScale;
  const tx = flip ? sx + pivX - turret.width * tankScale : sx - pivX;
  sprite(turret, tx, sy - bh - 4 - pivY + 6, tankScale, flip ? a : -a, flip ? turret.width * tankScale - pivX : pivX, pivY, flip, tintTo(color));
  sprite(body, sx - bw / 2, sy - bh, tankScale, 0, 0, 0, false, tintTo(color));
  return [sx, sy - bh] as const;
}

// A few tanks having a go at each other.
const shooter = tank(420, 0, 52);
tank(760, 1, 128);
tank(1180, 2, 120);
tank(1490, 5, 140);

// A shell lobbed from the cyan tank over the big ridge, most of the way to the red tank.
const [ex, ey] = toScreen(1010, terrain.groundBelow(1010, 0));
const sx0 = shooter[0] + 30;
const sy0 = shooter[1] - 25;
const apex = Math.min(sy0, ey) - 230;
const arc = (t: number): [number, number] => {
  // Quadratic Bezier through a high control point: a clean artillery arc.
  const cx = (sx0 + ex) / 2;
  const cy = apex - (Math.max(sy0, ey) - apex) * 0.15;
  const x = (1 - t) * (1 - t) * sx0 + 2 * (1 - t) * t * cx + t * t * ex;
  const y = (1 - t) * (1 - t) * sy0 + 2 * (1 - t) * t * cy + t * t * ey;
  return [x, y];
};
for (let i = 0; i < 300; i++) {
  const t = (i / 300) * 0.42;
  const [x, y] = arc(t);
  const a = 0.15 + (t / 0.42) * 0.75;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) blend(x + dx, y + dy, 255, 160, 80, a * (dx || dy ? 0.5 : 1));
}
const [shx, shy] = arc(0.42);
const [nx, ny] = arc(0.43);
sprite(shell, shx - 14, shy - 8, 0.6, Math.atan2(ny - shy, nx - shx), 14, 8);
// An earlier shot's explosion further along.
const [bx, by] = toScreen(1330, terrain.groundBelow(1330, 0));
sprite(boom, bx - 60, by - 75, 0.95, 0.3, 60, 60);

// Helicopter dropping a tank in from the top left, and a parachute coming down.
sprite(heli, 80, 30, 1.0);
sprite(body, 112, 112, 0.45, 0, 0, 0, false, tintTo(4));
sprite(chute, 655, 14, 0.75);
sprite(body, 683, 96, 0.45, 0, 0, 0, false, tintTo(3));

fs.writeFileSync(OUT, PNG.sync.write(img));
console.log(`${OUT} written`);
