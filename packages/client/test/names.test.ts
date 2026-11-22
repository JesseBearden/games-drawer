import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nameHtml } from '../src/html';

describe('names in sentences', () => {
  it('stay on one line, escaped', () => {
    expect(nameHtml('Aunt <Mary>')).toBe('<span class="pc-nw">Aunt &lt;Mary&gt;</span>');
  });

  it('are never put bare into a card game’s sentences', () => {
    for (const file of ['heartsView', 'spadesView', 'dominoesView', 'threeThirteenView']) {
      const src = fs.readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
      const bare = src.split('\n').filter((l) => l.includes('escapeHtml(') && l.includes('this.name(') && !l.includes('pc-nm'));
      expect(bare, file).toEqual([]);
    }
  });
});
