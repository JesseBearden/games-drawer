/**
 * Add a puzzle picture that stays on this computer (a family photo, say):
 *
 *   npm run local-puzzle -- "C:\path\to\photo.jpg" "Wedding day"
 *
 * It goes in local-puzzles/ at the top of the repo, which git ignores, so it's never committed
 * or deployed: only the dev server (npm run dev) shows it, first in the puzzle picker. The copy is
 * turned upright, converted to standard colours, capped at 2400 px wide, and saved with no camera
 * data (no location, no device details). Running it again with the same title replaces that
 * picture. Remove one by deleting its files and its line in local-puzzles/puzzles.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { parseLocalPuzzles } from '@tank/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'local-puzzles');
const [photo, title] = process.argv.slice(2);
if (!photo || !title?.trim()) {
  console.error('Usage: npm run local-puzzle -- <photo.jpg> "<Title>"');
  process.exit(1);
}

const slug = title
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 34)
  .replace(/-+$/, '');
const id = `local-${slug || 'picture'}`;

sharp.cache(false);
const input = fs.readFileSync(photo);
// Upright, standard (sRGB) colours, and no metadata at all: sharp keeps none unless asked.
const image = await sharp(input).rotate().resize({ width: 2400, withoutEnlargement: true }).toColorspace('srgb').jpeg({ quality: 86, mozjpeg: true }).toBuffer();
const { width, height } = await sharp(image).metadata();
fs.mkdirSync(path.join(dir, 'thumbs'), { recursive: true });
fs.writeFileSync(path.join(dir, `${id}.jpg`), image);
fs.writeFileSync(path.join(dir, 'thumbs', `${id}.webp`), await sharp(image).resize(240).webp({ quality: 70 }).toBuffer());

const listFile = path.join(dir, 'puzzles.json');
let list: { id: string; title: string; width: number; height: number }[] = [];
try {
  list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
} catch {
  /* first picture */
}
list = list.filter((p) => p.id !== id);
list.push({ id, title: title.trim(), width: width!, height: height!});
if (parseLocalPuzzles(list).length !== list.length) {
  console.error('That title or picture size isn’t allowed (titles are 40 letters at most).');
  process.exit(1);
}
fs.writeFileSync(listFile, JSON.stringify(list, null, 2) + '\n');
console.log(`Added "${title.trim()}" (${width}×${height}) as ${id}. Reload the puzzle page (with npm run dev running) to see it first in the picker.`);
