import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PUZZLE_IMAGES } from '@tank/shared';

const client = fileURLToPath(new URL('..', import.meta.url));
const html = fs.readFileSync(`${client}/index.html`, 'utf8');
const size = (file: string) => fs.statSync(`${client}/public${file}`).size;

describe('the first visit’s weight', () => {
  it('the landing picture comes in smaller sizes', async () => {
    for (const width of [768, 1024]) {
      const file = `/art/together-${width}.webp`;
      expect(html).toContain(`${file} ${width}w`);
      expect((await sharp(`${client}/public${file}`).metadata()).width).toBe(width);
      expect(size(file)).toBeLessThan(size('/art/together.webp') / 2);
    }
  });

  it('what only one game shows doesn’t load on every page', () => {
    expect(html).not.toContain('/art/card-stock.webp');
    expect(html).not.toContain('src="/sprites/windsock.png"');
  });

  it('the Jigsaw picker’s thumbnails are 240 px', async () => {
    let total = 0;
    for (const img of PUZZLE_IMAGES) {
      expect((await sharp(`${client}/public${img.thumb}`).metadata()).width, img.id).toBe(240);
      total += size(img.thumb);
    }
    expect(total).toBeLessThan(500_000); // all come when the picker opens
  });
});
