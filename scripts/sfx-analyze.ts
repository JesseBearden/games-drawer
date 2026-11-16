/**
 * Measure candidate sound files (ogg/wav) so defaults can be picked objectively:
 *   npx tsx scripts/sfx-analyze.ts [--env] [--notes] <file-or-dir> [...more]
 * Prints duration, peak, loudness (loudest 100 ms RMS), onset delay, tail, clipping, low-end share
 * and brightness for each file. --env adds a loudness envelope (dB per 250 ms); --notes adds the
 * strongest pitch per 80 ms frame (for telling rising/falling or major/minor jingles apart).
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, freeDecoder, measure, readAudio, type Pcm } from './sfx-lib';

const args = process.argv.slice(2);
const showEnv = args.includes('--env');
const showNotes = args.includes('--notes');
const files: string[] = [];
const walk = (p: string) => {
  if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f));
  else if (/\.(ogg|wav)$/i.test(p)) files.push(p);
};
for (const arg of args.filter((a) => !a.startsWith('--'))) walk(arg);

function envelope({ data, sampleRate }: Pcm, step = 0.25) {
  const n = Math.round(sampleRate * step);
  const out: string[] = [];
  for (let i = 0; i < data.length; i += n) {
    let s = 0;
    const end = Math.min(data.length, i + n);
    for (let j = i; j < end; j++) s += data[j] * data[j];
    out.push(Math.max(-60, db(Math.sqrt(s / Math.max(1, end - i)))).toFixed(0));
  }
  return out.join(' ');
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Strongest fundamental per frame by a harmonic sum of Goertzel magnitudes over MIDI 40..100. */
function notes({ data, sampleRate }: Pcm) {
  const frame = 2048;
  const hop = Math.round(sampleRate * 0.08);
  let globalPeak = 0;
  for (const x of data) globalPeak = Math.max(globalPeak, Math.abs(x));
  const mag = (start: number, f: number) => {
    if (f >= sampleRate / 2) return 0;
    const w = (2 * Math.PI * f) / sampleRate;
    const c = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < frame; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
      const s0 = data[start + i] * win + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2);
  };
  const seq: string[] = [];
  for (let start = 0; start + frame <= data.length; start += hop) {
    let rms = 0;
    for (let i = start; i < start + frame; i++) rms += data[i] * data[i];
    if (Math.sqrt(rms / frame) < globalPeak * 0.05) {
      if (seq[seq.length - 1] !== '.') seq.push('.');
      continue;
    }
    let best = -1;
    let bestMidi = 0;
    for (let m = 40; m <= 100; m++) {
      const f = 440 * 2 ** ((m - 69) / 12);
      const score = mag(start, f) + 0.5 * mag(start, 2 * f) + 0.33 * mag(start, 3 * f);
      if (score > best) {
        best = score;
        bestMidi = m;
      }
    }
    const name = NOTE_NAMES[bestMidi % 12] + (Math.floor(bestMidi / 12) - 1);
    if (seq[seq.length - 1] !== name) seq.push(name);
  }
  return seq.join(' ');
}
if (!files.length) {
  console.error('usage: tsx scripts/sfx-analyze.ts <file-or-dir> [...]');
  process.exit(1);
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-inf');
const f2 = (x: number) => x.toFixed(2);
console.log(['file', 'sr', 'ch', 'dur', 'peak', 'loud', 'onset', 'end', 'clip', 'low', 'zcr'].join('\t'));
for (const f of files) {
  try {
    const pcm = await readAudio(f);
    const m = measure(pcm);
    console.log(
      [path.basename(f), pcm.sampleRate, pcm.channels, f2(m.duration), f1(m.peakDb), f1(m.loudDb), f2(m.onset), f2(m.end), m.clipped, f2(m.low), Math.round(m.zcr)].join('\t'),
    );
    if (showEnv) console.log(`  env: ${envelope(pcm)}`);
    if (showNotes) console.log(`  notes: ${notes(pcm)}`);
  } catch (e) {
    console.log(`${path.basename(f)}\tERROR ${(e as Error).message}`);
  }
}
freeDecoder();
