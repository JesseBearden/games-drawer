import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AMBIENCE_NAMES, SOUND_NAMES, SYNTH } from '../src/audio';
import { SFX_MANIFEST } from '../src/sfx-manifest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC = path.join(ROOT, 'packages/client/public');
const SFX_DIR = path.join(PUBLIC, 'sfx');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** Repo-relative path (forward slashes) -> its CREDITS.md table row. */
function creditRows(): Map<string, string> {
  const rows = new Map<string, string>();
  const text = fs.readFileSync(path.join(ROOT, 'CREDITS.md'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (m) rows.set(m[1], line);
  }
  return rows;
}

const shipped = walk(SFX_DIR).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

describe('sound credits', () => {
  it('ships some samples', () => {
    expect(shipped.length).toBeGreaterThan(0);
  });

  it('credits every file under public/sfx as CC0 (or made on a paid ElevenLabs plan) with a source link', () => {
    const rows = creditRows();
    const missing = shipped.filter((f) => !rows.has(f));
    expect(missing, 'files without a CREDITS.md row').toEqual([]);
    for (const f of shipped) {
      const row = rows.get(f)!;
      expect(row, f).toMatch(/CC0 1\.0|ElevenLabs Starter plan \(commercial use\)/);
      expect(row, f).toMatch(/\]\(https:\/\/[^)]+\)/);
    }
  });

  it('keeps the original of every ElevenLabs sound in sfx-sources/elevenlabs', () => {
    for (const [f, row] of creditRows()) {
      if (!row.includes('ElevenLabs Starter plan')) continue;
      const original = row.match(/\(https:\/\/elevenlabs\.io[^)]*\), `([^`]+)`/)?.[1];
      expect(original, f).toBeTruthy();
      expect(fs.existsSync(path.join(ROOT, 'sfx-sources/elevenlabs', original!)), `${f}: ${original}`).toBe(true);
    }
  });

  it('has no CREDITS.md rows for files that are gone', () => {
    const stale = [...creditRows().keys()].filter((f) => f.startsWith('packages/client/public/sfx/') && !fs.existsSync(path.join(ROOT, f)));
    expect(stale).toEqual([]);
  });

  it('ships only formats iPhone Safari can decode (16-bit PCM WAV, MP3 or M4A)', () => {
    for (const f of shipped) {
      expect(f, f).toMatch(/\.(wav|mp3|m4a)$/);
      if (!f.endsWith('.wav')) continue;
      const head = fs.readFileSync(path.join(ROOT, f)).subarray(0, 36);
      expect(head.toString('latin1', 0, 4), f).toBe('RIFF');
      expect(head.toString('latin1', 8, 12), f).toBe('WAVE');
      expect(head.readUInt16LE(20), `${f} PCM`).toBe(1);
      expect(head.readUInt16LE(34), `${f} bits`).toBe(16);
    }
  });
});

describe('sound manifest', () => {
  it('has an entry for every sound and ambience loop', () => {
    for (const slot of [...SOUND_NAMES, ...AMBIENCE_NAMES]) expect(SFX_MANIFEST[slot], slot).toBeDefined();
  });

  it('points only at files that exist', () => {
    const missing: string[] = [];
    for (const [slot, entry] of Object.entries(SFX_MANIFEST)) {
      for (const c of entry.candidates) if (!fs.existsSync(path.join(PUBLIC, c.file))) missing.push(`${slot}: ${c.file}`);
    }
    expect(missing).toEqual([]);
  });

  it('has valid defaults, unique ids and sane gains', () => {
    for (const [slot, entry] of Object.entries(SFX_MANIFEST)) {
      const ids = entry.candidates.map((c) => c.id);
      expect(new Set(ids).size, `${slot} duplicate ids`).toBe(ids.length);
      expect([SYNTH, ...ids], `${slot} default`).toContain(entry.default);
      for (const c of entry.candidates) {
        expect(c.gain, `${slot}/${c.id} gain`).toBeGreaterThan(0);
        expect(c.gain, `${slot}/${c.id} gain`).toBeLessThan(8);
        expect(c.source, `${slot}/${c.id} source`).toMatch(/^https:\/\//);
      }
    }
  });
});
