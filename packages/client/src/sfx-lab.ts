// Dev-only page (sfx-lab.html) to audition, pick and measure the game's sounds: the synth version
// and every sample candidate from sfx-manifest.ts.
import {
  AMBIENCE_NAMES,
  CARD_SOUNDS,
  PICKS_KEY,
  Sfx,
  SOUND_NAMES,
  SYNTH,
  Synth,
  synthAmbience,
  TANK_SOUNDS,
  type AmbienceName,
  type SfxSlot,
  type SoundName,
} from './audio';
import { SFX_MANIFEST, type SfxCandidate } from './sfx-manifest';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// Load everything up front: this page exists to compare them all.
const sfx = new Sfx({ preload: SOUND_NAMES });
const num = (id: string) => Number($<HTMLInputElement>(id).value);
const isAmbience = (slot: SfxSlot): slot is AmbienceName => (AMBIENCE_NAMES as string[]).includes(slot);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- picking UI

const cards = new Map<SfxSlot, Map<string, HTMLElement>>();

function variantCard(slot: SfxSlot, id: string, c: SfxCandidate | null): HTMLElement {
  const isDefault = SFX_MANIFEST[slot]?.default === id || (!SFX_MANIFEST[slot]?.candidates.length && id === SYNTH);
  const el = document.createElement('div');
  el.className = 'variant';
  const title = c ? c.label : 'Synth';
  const meta = c
    ? `${esc(c.file.split('/').pop() ?? c.file)} · ${c.duration.toFixed(2)} s${c.loop ? ' loop' : ''} · gain ${c.gain.toFixed(2)}<br>` +
      `${esc(c.author)} · <a href="${esc(c.source)}" target="_blank" rel="noopener">source</a> · CC0`
    : 'Generated in code (audio.ts)';
  el.innerHTML =
    `<div class="row"><button class="play" title="${esc(title)}">▶ ${esc(title)}</button>` +
    `<label><input type="radio" name="pick-${slot}" value="${esc(id)}"> use</label></div>` +
    `<div class="meta">${isDefault ? '<span class="badge">default</span> ' : ''}${meta}<span class="status"></span></div>`;
  const status = el.querySelector<HTMLElement>('.status')!;
  el.querySelector('button')!.addEventListener('click', async () => {
    sfx.unlock();
    status.textContent = '';
    if (isAmbience(slot)) {
      sfx.auditionAmbience(slot, id);
      const slider = $<HTMLInputElement>(slot);
      if (Number(slider.value) === 0) slider.value = '0.8';
      sfx.setAmbience(num('rotor'), num('wind'));
      return;
    }
    const ok = await sfx.audition(slot, id, { pan: num('pan'), size: num('size') });
    if (!ok) {
      status.textContent = ' · could not load, synth played';
      status.className = 'status failed';
    }
  });
  el.querySelector('input')!.addEventListener('change', () => {
    sfx.setPick(slot, id);
    if (isAmbience(slot)) sfx.auditionAmbience(slot, null);
    refreshPicks();
  });
  return el;
}

function renderSlots(container: string, slots: SfxSlot[]) {
  for (const slot of slots) {
    const entry = SFX_MANIFEST[slot];
    const section = document.createElement('section');
    section.className = 'slot';
    const n = entry?.candidates.length ?? 0;
    section.innerHTML = `<h3>${slot} <small>${n ? `${n} sample${n > 1 ? 's' : ''}` : 'synth only: no sample fit'}</small></h3>`;
    const grid = document.createElement('div');
    grid.className = 'variants';
    const byId = new Map<string, HTMLElement>();
    const synthCard = variantCard(slot, SYNTH, null);
    byId.set(SYNTH, synthCard);
    grid.append(synthCard);
    for (const c of entry?.candidates ?? []) {
      const card = variantCard(slot, c.id, c);
      byId.set(c.id, card);
      grid.append(card);
    }
    cards.set(slot, byId);
    section.append(grid);
    $(container).append(section);
  }
}

function refreshPicks() {
  for (const [slot, byId] of cards) {
    const picked = sfx.pickOf(slot);
    for (const [id, el] of byId) {
      el.classList.toggle('picked', id === picked);
      el.querySelector<HTMLInputElement>('input')!.checked = id === picked;
    }
  }
  const overrides = sfx.pickOverrides;
  $<HTMLTextAreaElement>('picks-json').value = Object.keys(overrides).length
    ? `localStorage.setItem('${PICKS_KEY}', '${JSON.stringify(overrides)}')`
    : '// No overrides: this browser plays the manifest defaults.';
}

renderSlots('tank-slots', TANK_SOUNDS);
renderSlots('ambience-slots', AMBIENCE_NAMES);
renderSlots('card-slots', CARD_SOUNDS);
refreshPicks();

$('copy-picks').addEventListener('click', async () => {
  const json = JSON.stringify(sfx.pickOverrides, null, 2);
  let ok = false;
  try {
    await navigator.clipboard.writeText(json);
    ok = true;
  } catch {
    const ta = $<HTMLTextAreaElement>('picks-json');
    ta.value = json;
    ta.select();
    ok = document.execCommand?.('copy') ?? false;
  }
  $('copy-status').textContent = ok ? 'Copied.' : 'Select the text below and copy it.';
});
$('reset-picks').addEventListener('click', () => {
  for (const slot of [...SOUND_NAMES, ...AMBIENCE_NAMES]) sfx.setPick(slot, null);
  for (const slot of AMBIENCE_NAMES) sfx.auditionAmbience(slot, null);
  refreshPicks();
});
for (const id of ['rotor', 'wind']) {
  $(id).addEventListener('input', () => {
    sfx.unlock();
    sfx.setAmbience(num('rotor'), num('wind'));
  });
}
$('stop-ambience').addEventListener('click', () => {
  $<HTMLInputElement>('rotor').value = '0';
  $<HTMLInputElement>('wind').value = '0';
  sfx.setAmbience(0, 0);
});

// ---------------------------------------------------------------- measuring

export interface SoundReport {
  name: SoundName;
  peak: number;
  peakAfterLimiter: number;
  rms: number;
  /** Seconds until the sound falls below -60 dB for good. */
  length: number;
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const SR = 44100;
/** A centred mono source comes out of a StereoPannerNode 3 dB down in each channel. */
const PAN_LAW_DB = 20 * Math.log10(Math.SQRT1_2);

/** Render one synth sound offline and measure it, with and without the game's compressor. */
export async function analyze(name: SoundName, size = 0.6): Promise<SoundReport> {
  const seconds = 6;
  const render = async (withCompressor: boolean) => {
    const ctx = new OfflineAudioContext(2, SR * seconds, SR);
    let out: AudioNode = ctx.destination;
    if (withCompressor) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      const master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(comp).connect(ctx.destination);
      out = master;
    }
    new Synth(ctx, out).play(name, { size });
    return ctx.startRendering();
  };
  const raw = await render(false);
  const limited = await render(true);
  let peak = 0;
  let sum = 0;
  let last = 0;
  const l = raw.getChannelData(0);
  for (let i = 0; i < l.length; i++) {
    const a = Math.abs(l[i]);
    if (a > peak) peak = a;
    sum += l[i] * l[i];
    if (a > 0.001) last = i;
  }
  let peakAfter = 0;
  const ll = limited.getChannelData(0);
  for (let i = 0; i < ll.length; i++) peakAfter = Math.max(peakAfter, Math.abs(ll[i]));
  return { name, peak, peakAfterLimiter: peakAfter, rms: Math.sqrt(sum / Math.max(1, last)), length: last / SR };
}

export async function analyzeAll() {
  const out: SoundReport[] = [];
  for (const n of SOUND_NAMES) out.push(await analyze(n));
  return out;
}

/** Mean square per sample frame, averaged over channels. */
function power(buf: AudioBuffer): Float32Array {
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += (d[i] * d[i]) / buf.numberOfChannels;
  }
  return out;
}

/**
 * Approximate K-weighting (ITU-R BS.1770), built from the same filters scripts/sfx-lib.ts uses
 * when it sets each sample's gain: a +4 dB shelf above 1.68 kHz and a 38 Hz high-pass.
 */
function kWeighting(ctx: BaseAudioContext): { input: AudioNode; output: AudioNode } {
  const shelf = ctx.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 1682;
  shelf.gain.value = 4;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 38;
  hp.Q.value = -6.02;
  shelf.connect(hp);
  return { input: shelf, output: hp };
}

/** Loudest 400 ms window (dB): "momentary loudness", the metric scripts/sfx-lib.ts uses too. */
function loudestDb(p: Float32Array, sr: number) {
  const win = Math.round(sr * 0.4);
  let sum = 0;
  let best = 0;
  for (let i = 0; i < p.length; i++) {
    sum += p[i];
    if (i >= win) sum -= p[i - win];
    best = Math.max(best, sum / win);
  }
  return 10 * Math.log10(best || 1e-12);
}

function averageDb(p: Float32Array, from = 0) {
  let sum = 0;
  for (let i = from; i < p.length; i++) sum += p[i];
  return 10 * Math.log10(sum / Math.max(1, p.length - from) || 1e-12);
}

function peakOf(buf: AudioBuffer) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) for (const x of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
  return peak;
}

/**
 * The synth version's K-weighted level, as a centred mono source before panning (what a sample
 * with gain 1 would need to match): loudest 400 ms for sounds, average for the ambience beds.
 */
export async function synthLevel(slot: SfxSlot, size = 1): Promise<number> {
  if (isAmbience(slot)) {
    const ctx = new OfflineAudioContext(1, SR * 4, SR);
    const k = kWeighting(ctx);
    k.output.connect(ctx.destination);
    const noise = new Synth(ctx, ctx.destination).noise;
    synthAmbience(ctx, noise)[slot].connect(k.input);
    return averageDb(power(await ctx.startRendering()), SR);
  }
  const ctx = new OfflineAudioContext(2, SR * 6, SR);
  const k = kWeighting(ctx);
  k.output.connect(ctx.destination);
  new Synth(ctx, k.input).play(slot, { size });
  return loudestDb(power(await ctx.startRendering()), SR) - PAN_LAW_DB;
}

/** A sample's K-weighted level at the given gain (loudest 400 ms, or the average for loops). */
async function sampleLevel(buf: AudioBuffer, gain: number, loop: boolean): Promise<number> {
  const ctx = new OfflineAudioContext(1, buf.length, buf.sampleRate);
  const k = kWeighting(ctx);
  k.output.connect(ctx.destination);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(k.input);
  src.start();
  const p = power(await ctx.startRendering());
  return loop ? averageDb(p) : loudestDb(p, buf.sampleRate);
}

/** Synth levels for every slot, averaged over a few renders because the noise is random. */
export async function targets(renders = 4) {
  const out: Record<string, number> = {};
  for (const slot of [...SOUND_NAMES, ...AMBIENCE_NAMES]) {
    let sum = 0;
    for (let i = 0; i < renders; i++) sum += await synthLevel(slot);
    out[slot] = Math.round((sum / renders) * 10) / 10;
  }
  return out;
}

async function decodeCandidate(c: SfxCandidate): Promise<AudioBuffer | null> {
  try {
    const r = await fetch(import.meta.env.BASE_URL + c.file);
    if (!r.ok) return null;
    return await new OfflineAudioContext(1, 1, SR).decodeAudioData(await r.arrayBuffer());
  } catch {
    return null;
  }
}

export interface LevelRow {
  slot: SfxSlot;
  version: string;
  /** K-weighted dB: loudest 400 ms (average for loops), as played at volume 1 before panning. */
  level: number;
  peak: number;
  length: number;
}

export async function levels(): Promise<LevelRow[]> {
  const rows: LevelRow[] = [];
  for (const slot of [...SOUND_NAMES, ...AMBIENCE_NAMES]) {
    rows.push({ slot, version: SYNTH, level: await synthLevel(slot), peak: NaN, length: NaN });
    for (const c of SFX_MANIFEST[slot]?.candidates ?? []) {
      const buf = await decodeCandidate(c);
      if (!buf) {
        rows.push({ slot, version: `${c.id} (failed to load)`, level: NaN, peak: NaN, length: NaN });
        continue;
      }
      const level = await sampleLevel(buf, c.gain, isAmbience(slot));
      rows.push({ slot, version: c.id, level, peak: db(peakOf(buf) * c.gain), length: buf.duration });
    }
  }
  return rows;
}

$('analyze').addEventListener('click', async () => {
  $('report').innerHTML = '<tr><td>Measuring…</td></tr>';
  const rows = await levels();
  const synthLevels = new Map(rows.filter((r) => r.version === SYNTH).map((r) => [r.slot, r.level]));
  const fmt = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)} dB` : '–');
  $('report').innerHTML =
    '<tr><th>Sound</th><th>Version</th><th>Level</th><th>vs synth</th><th>Peak (with gain)</th><th>Length</th></tr>' +
    rows
      .map((r) => {
        const diff = r.version === SYNTH ? NaN : r.level - (synthLevels.get(r.slot) ?? NaN);
        return (
          `<tr><td>${r.slot}</td><td>${esc(r.version)}</td><td>${fmt(r.level)}</td>` +
          `<td class="${Math.abs(diff) > 3 ? 'bad' : ''}">${Number.isFinite(diff) ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)} dB` : ''}</td>` +
          `<td class="${r.peak > 6 ? 'bad' : ''}">${fmt(r.peak)}</td><td>${Number.isFinite(r.length) ? `${r.length.toFixed(2)} s` : ''}</td></tr>`
        );
      })
      .join('');
});

(window as unknown as { __sfxLab: unknown }).__sfxLab = { analyze, analyzeAll, synthLevel, targets, levels, sfx };
