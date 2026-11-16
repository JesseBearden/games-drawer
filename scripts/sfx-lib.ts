/**
 * Small audio helpers for the sound-effect scripts (sfx-analyze.ts, sfx-build.ts): decode Ogg
 * Vorbis / PCM WAV into float samples, measure them, and write 16-bit mono WAV, which every
 * browser (iPhone Safari included) can decode.
 */
import fs from 'node:fs';
import { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis';

export interface Pcm {
  /** Mono samples, -1..1. */
  data: Float32Array;
  sampleRate: number;
  /** Channel count of the source before the mono downmix. */
  channels: number;
}

let decoder: OggVorbisDecoder | null = null;

/** Decode an .ogg (Vorbis) or PCM .wav file and mix it down to mono. */
export async function readAudio(file: string): Promise<Pcm> {
  const bytes = new Uint8Array(fs.readFileSync(file));
  if (file.toLowerCase().endsWith('.wav')) return readWav(bytes);
  if (!decoder) {
    decoder = new OggVorbisDecoder();
    await decoder.ready;
  }
  await decoder.reset();
  const out = await decoder.decodeFile(bytes);
  if (out.errors.length) throw new Error(`${file}: ${out.errors.map((e) => e.message).join('; ')}`);
  return { data: mixDown(out.channelData, out.samplesDecoded), sampleRate: out.sampleRate, channels: out.channelData.length };
}

export function freeDecoder() {
  decoder?.free();
  decoder = null;
}

function mixDown(channels: Float32Array[], length: number): Float32Array {
  const mono = new Float32Array(length);
  for (const ch of channels) for (let i = 0; i < length; i++) mono[i] += ch[i] / channels.length;
  return mono;
}

/** Minimal RIFF/WAVE reader: PCM 8/16/24/32-bit integer or 32-bit float. */
export function readWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = 0;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (fmt === 0xfffe) fmt = v.getUint16(body + 24, true);
    } else if (id === 'data') {
      const frameBytes = (bits / 8) * channels;
      const frames = Math.floor(Math.min(size, bytes.length - body) / frameBytes);
      const chs = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < channels; c++) {
          const p = body + f * frameBytes + c * (bits / 8);
          let s: number;
          if (fmt === 3 && bits === 32) s = v.getFloat32(p, true);
          else if (bits === 8) s = (bytes[p] - 128) / 128;
          else if (bits === 16) s = v.getInt16(p, true) / 32768;
          else if (bits === 24) s = ((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8 >> 8) / 8388608;
          else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
          else throw new Error(`unsupported WAV: format ${fmt}, ${bits} bits`);
          chs[c][f] = s;
        }
      }
      return { data: mixDown(chs, frames), sampleRate, channels };
    }
    o = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

/** 16-bit PCM mono WAV. */
export function encodeWav(data: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

export const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** K-weighted loudness in dB: loudest 400 ms window for one-shots, the average for loops. */
export function loudnessDb(data: Float32Array, sampleRate: number, loop = false): number {
  const k = kWeight(data, sampleRate);
  const ms = loop ? meanSquare(k) : loudestWindow(k, sampleRate, LOUDNESS_WINDOW_S);
  return 10 * Math.log10(ms || 1e-12);
}

/** One biquad section over a whole buffer (direct form I). */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * Approximate K-weighting (ITU-R BS.1770): a +4 dB high shelf at 1.68 kHz and a high-pass at
 * 38 Hz, so sub-bass counts for less and presence for more, roughly as ears hear it. Uses the Web
 * Audio spec's biquad formulas (highshelf with slope 1, highpass Q given in dB) so the sound lab's
 * BiquadFilterNodes measure the synth versions identically.
 */
export function kWeight(data: Float32Array, sampleRate: number): Float32Array {
  const shelfW = (2 * Math.PI * K_SHELF_HZ) / sampleRate;
  const A = 10 ** (K_SHELF_DB / 40);
  const cs = Math.cos(shelfW);
  const alphaS = (Math.sin(shelfW) / 2) * Math.SQRT2;
  const sa = 2 * alphaS * Math.sqrt(A);
  const shelved = biquad(
    data,
    A * (A + 1 + (A - 1) * cs + sa),
    -2 * A * (A - 1 + (A + 1) * cs),
    A * (A + 1 + (A - 1) * cs - sa),
    A + 1 - (A - 1) * cs + sa,
    2 * (A - 1 - (A + 1) * cs),
    A + 1 - (A - 1) * cs - sa,
  );
  const hpW = (2 * Math.PI * K_HIGHPASS_HZ) / sampleRate;
  const ch = Math.cos(hpW);
  const alphaQ = Math.sin(hpW) / (2 * 10 ** (K_HIGHPASS_Q_DB / 20));
  return biquad(shelved, (1 + ch) / 2, -(1 + ch), (1 + ch) / 2, 1 + alphaQ, -2 * ch, 1 - alphaQ);
}
export const K_SHELF_HZ = 1682;
export const K_SHELF_DB = 4;
export const K_HIGHPASS_HZ = 38;
export const K_HIGHPASS_Q_DB = -6.02;

/** Window for "momentary" loudness, as in EBU R128. */
export const LOUDNESS_WINDOW_S = 0.4;

/**
 * Mean square of the loudest window (sounds shorter than the window count as padded with
 * silence). The sound lab measures the synth versions the same way, so the two are comparable.
 */
export function loudestWindow(data: Float32Array, sampleRate: number, seconds = 0.1): number {
  const win = Math.max(1, Math.round(sampleRate * seconds));
  let sum = 0;
  let best = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
    if (i >= win) sum -= data[i - win] * data[i - win];
    best = Math.max(best, sum / win);
  }
  return best;
}

/** Mean square over the whole buffer (for steady loops). */
export function meanSquare(data: Float32Array): number {
  let sum = 0;
  for (const x of data) sum += x * x;
  return sum / Math.max(1, data.length);
}

export interface Measure {
  duration: number;
  /** Peak sample, dBFS. */
  peakDb: number;
  /** Loudest 100 ms window (RMS), dBFS: a rough "momentary loudness". */
  loudDb: number;
  /** Seconds before the sound first reaches -20 dB below its peak. */
  onset: number;
  /** Seconds until the sound falls below -50 dB re peak for good. */
  end: number;
  /** Samples at or above full scale (clipping). */
  clipped: number;
  /** Share of energy below ~200 Hz (0..1): high for booms and thuds. */
  low: number;
  /** Zero crossings per second / 2: a rough brightness in Hz. */
  zcr: number;
}

export function measure(p: Pcm): Measure {
  const { data, sampleRate: sr } = p;
  let peak = 0;
  let clipped = 0;
  for (const x of data) {
    const a = Math.abs(x);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
  }
  let onset = 0;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) >= peak * 0.1) {
      onset = i / sr;
      break;
    }
  }
  let end = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    if (Math.abs(data[i]) >= peak * 0.00316) {
      end = i / sr;
      break;
    }
  }
  const best = loudestWindow(data, sr);
  // One-pole low-pass at 200 Hz to estimate how much of the energy is low rumble.
  const a = Math.exp((-2 * Math.PI * 200) / sr);
  let y = 0;
  let lowE = 0;
  let allE = 0;
  let zc = 0;
  for (let i = 0; i < data.length; i++) {
    y = (1 - a) * data[i] + a * y;
    lowE += y * y;
    allE += data[i] * data[i];
    if (i && (data[i] >= 0) !== (data[i - 1] >= 0)) zc++;
  }
  return {
    duration: data.length / sr,
    peakDb: db(peak),
    loudDb: db(Math.sqrt(best)),
    onset,
    end,
    clipped,
    low: allE ? lowE / allE : 0,
    zcr: zc / 2 / (data.length / sr),
  };
}
