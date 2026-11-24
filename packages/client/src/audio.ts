/**
 * Game sound: recorded samples where we have good ones, Web Audio synthesis for everything else.
 *
 * `Synth` builds each sound from oscillators and filtered noise on any BaseAudioContext, so the
 * same recipes play live (AudioContext) or render offline for testing (OfflineAudioContext). It is
 * also the fallback whenever a sample is missing, still loading or fails to decode.
 * `Sfx` owns the live context: unlocking on a user gesture (required on iPhone), loading the
 * samples picked in sfx-manifest.ts (CC0 files under public/sfx, see CREDITS.md), the master
 * volume/mute, a compressor so a dozen explosions don't clip, and looping ambience
 * (helicopter rotors, wind).
 */
import { SFX_MANIFEST, type SfxCandidate } from './sfx-manifest';

export type SoundName =
  | 'fire'
  | 'explosion'
  | 'bigExplosion'
  | 'heliDown'
  | 'nuke'
  | 'drop'
  | 'chute'
  | 'land'
  | 'shield'
  | 'levelUp'
  | 'perk'
  | 'bounty'
  | 'win'
  | 'myDeath'
  | 'chat'
  | 'tick'
  | 'spreadReady'
  | 'blastWarn'
  // Hearts (card game)
  | 'cardDeal'
  | 'cardPlay'
  | 'cardPass'
  | 'trickTake'
  | 'heartsBroken'
  | 'queenSpades'
  | 'yourTurn'
  | 'handEnd'
  | 'lobbyJoin'
  // Mahjong
  | 'tileClack'
  | 'tileShuffle';

/** Sounds of the tank game: the Tanks screen loads their samples when it opens. */
export const TANK_SOUNDS: SoundName[] = [
  'fire',
  'explosion',
  'bigExplosion',
  'heliDown',
  'nuke',
  'drop',
  'chute',
  'land',
  'shield',
  'levelUp',
  'perk',
  'bounty',
  'win',
  'myDeath',
  'chat',
  'tick',
  'spreadReady',
  'blastWarn',
];

/**
 * Sounds of the Hearts card game. They load on first play (that first play uses the synth) unless
 * preloaded: `sfx.preloadSounds(CARD_SOUNDS)` when a table opens, or `new Sfx({ preload: ... })`.
 */
export const CARD_SOUNDS: SoundName[] = [
  'cardDeal',
  'cardPlay',
  'cardPass',
  'trickTake',
  'heartsBroken',
  'queenSpades',
  'yourTurn',
  'handEnd',
  'lobbyJoin',
];

/** Mahjong's tiles (made in code: no samples to load). */
export const TILE_SOUNDS: SoundName[] = ['tileClack', 'tileShuffle'];

export const SOUND_NAMES: SoundName[] = [...TANK_SOUNDS, ...CARD_SOUNDS, ...TILE_SOUNDS];

/** What any table can play: the only samples that load as soon as audio unlocks (the default `preload`). */
export const SHARED_SOUNDS: SoundName[] = ['chat', 'win'];

/** The looping ambience beds, whose loudness `Sfx.setAmbience` drives. */
export type AmbienceName = 'rotor' | 'wind';
export const AMBIENCE_NAMES: AmbienceName[] = ['rotor', 'wind'];

/** Anything that has a manifest entry: a one-shot sound or an ambience loop. */
export type SfxSlot = SoundName | AmbienceName;

/** Candidate id meaning "use the synthesized version". */
export const SYNTH = 'synth';

/** localStorage key for per-browser sample picks: JSON map of SfxSlot -> candidate id or "synth". */
export const PICKS_KEY = 'tank.sfxPicks';

export interface PlayOptions {
  /** -1 (left) .. 1 (right) */
  pan?: number;
  /** 0..1 multiplier */
  volume?: number;
  /** Explosion size: about 0.4 (small shell) to 1.5 (huge). */
  size?: number;
  /** Seconds from now. */
  delay?: number;
}

const SILENT = 0.0001;

export class Synth {
  private noiseBuf: AudioBuffer;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly out: AudioNode,
  ) {
    const len = Math.floor(ctx.sampleRate * 2);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  get noise() {
    return this.noiseBuf;
  }

  play(name: SoundName, o: PlayOptions = {}) {
    const t = this.ctx.currentTime + 0.005 + (o.delay ?? 0);
    const v = voice(this.ctx, this.out, o.pan ?? 0, o.volume ?? 1);
    const size = o.size ?? 1;
    switch (name) {
      case 'fire':
        return this.fire(t, v);
      case 'explosion':
        return this.explosion(t, v, size);
      case 'bigExplosion':
        this.explosion(t, v, Math.max(1.2, size));
        this.noiseHit(t + 0.12, v, 'lowpass', 320, 90, 1.6, 0.35, 0.08, 0.7);
        return;
      case 'heliDown':
        this.explosion(t, v, 1.1);
        this.tone(t + 0.15, v, 'sine', 1100, 170, 1.1, 0.1, 0.05);
        this.explosion(t + 1.25, v, 0.6);
        return;
      case 'nuke':
        return this.nuke(t, o.volume ?? 1);
      case 'drop':
        this.tone(t, v, 'square', 240, 120, 0.07, 0.16, 0.002);
        this.noiseHit(t, v, 'bandpass', 500, 1600, 0.45, 0.55, 0.06, 1);
        return;
      case 'chute':
        this.noiseHit(t, v, 'bandpass', 1300, 700, 0.12, 0.45, 0.003, 2);
        this.tone(t, v, 'sine', 230, 140, 0.18, 0.22, 0.004);
        return;
      case 'land':
        this.tone(t, v, 'sine', 120, 50, 0.22, 0.55, 0.003);
        this.noiseHit(t, v, 'lowpass', 500, 120, 0.18, 0.3, 0.003, 0.7);
        return;
      case 'shield':
        this.tone(t, v, 'sine', 1320, 1320, 0.7, 0.16, 0.002);
        this.tone(t, v, 'sine', 1980, 1980, 0.5, 0.1, 0.002);
        this.noiseHit(t, v, 'highpass', 3500, 3500, 0.05, 0.08, 0.001, 0.7);
        return;
      case 'levelUp':
        this.notes(t, v, [659.25, 987.77], 0.09, 0.18, 0.25);
        return;
      case 'perk':
        this.notes(t, v, [523.25, 659.25, 783.99, 1046.5], 0.08, 0.2, 0.27, 0.55);
        this.notes(t, v, [1046.5, 1318.5, 1568, 2093], 0.08, 0.15, 0.05, 0.4, 'sine');
        return;
      case 'bounty':
        this.notes(t, v, [1318.5, 1760, 2093], 0.06, 0.16, 0.25, 0.35);
        this.noiseHit(t + 0.1, v, 'highpass', 6000, 6000, 0.25, 0.06, 0.01, 0.7);
        return;
      case 'win':
        this.notes(t, v, [392, 523.25, 659.25, 783.99], 0.14, 0.2, 0.17);
        for (const f of [523.25, 659.25, 783.99, 1046.5]) this.tone(t + 0.6, v, 'triangle', f, f, 1.4, 0.11, 0.02);
        return;
      case 'myDeath':
        this.tone(t, v, 'triangle', 392, 180, 0.7, 0.22, 0.01);
        this.tone(t + 0.06, v, 'triangle', 294, 135, 0.7, 0.12, 0.01);
        return;
      case 'chat':
        this.tone(t, v, 'sine', 880, 880, 0.07, 0.12, 0.003);
        this.tone(t + 0.065, v, 'sine', 1320, 1320, 0.09, 0.1, 0.003);
        return;
      case 'tick':
        this.tone(t, v, 'triangle', 1900, 1700, 0.018, 0.05, 0.001);
        return;
      case 'spreadReady':
        this.notes(t, v, [659.25, 987.77], 0.07, 0.13, 0.13, 0.13, 'sine');
        return;
      case 'blastWarn':
        for (let i = 0; i < 4; i++) this.tone(t + i * 0.22, v, 'triangle', 1046.5, 1046.5, 0.08, 0.14, 0.003);
        return;
      // Hearts: deliberately simple stand-ins for the card samples.
      case 'cardDeal':
        this.noiseHit(t, v, 'bandpass', 3800, 1800, 0.09, 0.35, 0.004, 0.8);
        return;
      case 'cardPlay':
        this.noiseHit(t, v, 'highpass', 2500, 2500, 0.05, 0.35, 0.001, 0.7);
        this.tone(t, v, 'sine', 220, 140, 0.06, 0.2, 0.002);
        return;
      case 'cardPass':
        for (let i = 0; i < 3; i++) this.noiseHit(t + i * 0.07, v, 'bandpass', 3200, 1600, 0.08, 0.3, 0.004, 0.8);
        return;
      case 'trickTake':
        this.noiseHit(t, v, 'bandpass', 1400, 4200, 0.22, 0.32, 0.03, 0.9);
        this.noiseHit(t + 0.18, v, 'highpass', 2500, 2500, 0.05, 0.3, 0.001, 0.7);
        return;
      case 'heartsBroken':
        this.notes(t, v, [987.77, 783.99, 587.33], 0.09, 0.18, 0.22, 0.4);
        this.noiseHit(t, v, 'highpass', 5000, 5000, 0.12, 0.12, 0.002, 0.7);
        return;
      case 'queenSpades':
        this.notes(t, v, [349.23, 329.63, 311.13, 293.66], 0.22, 0.24, 0.24, 0.8);
        return;
      case 'yourTurn':
        this.notes(t, v, [659.25, 987.77], 0.1, 0.16, 0.18, 0.3, 'sine');
        return;
      case 'handEnd':
        this.notes(t, v, [523.25, 659.25, 783.99], 0.1, 0.18, 0.2, 0.45);
        return;
      case 'lobbyJoin':
        this.notes(t, v, [783.99, 587.33], 0.12, 0.18, 0.15, 0.3, 'sine');
        return;
      case 'tileClack':
        this.clack(t, v, 1);
        return;
      case 'tileShuffle':
        this.shuffle(t, v);
        return;
    }
  }

  /** One Mahjong tile knocking another: a hard, bright click and a tiny bounce. */
  private clack(t: number, dest: AudioNode, strength: number, pitch = 1) {
    this.noiseHit(t, dest, 'bandpass', 3400 * pitch, 2600 * pitch, 0.03, 0.8 * strength, 0.0008, 2.2);
    this.tone(t, dest, 'sine', 2100 * pitch, 1800 * pitch, 0.035, 0.14 * strength, 0.0008);
    this.noiseHit(t + 0.016 + Math.random() * 0.01, dest, 'bandpass', 3000 * pitch, 2400 * pitch, 0.02, 0.2 * strength, 0.0008, 2);
  }

  /**
   * Washing the tiles: many hands pushing them about on the felt, so a soft slide under a run of
   * clacks at uneven times and strengths (about 2 s, as long as the shuffle shows).
   */
  private shuffle(t: number, dest: AudioNode) {
    for (let k = 0; k < 4; k++) this.noiseHit(t + k * 0.5, dest, 'lowpass', 900, 500, 0.55, 0.2, 0.08, 0.7);
    let at = t;
    for (let i = 0; i < 34; i++) {
      at += 0.025 + Math.random() * 0.085;
      if (at > t + 2.1) break;
      this.clack(at, dest, 0.5 + Math.random() * 0.5, 0.85 + Math.random() * 0.3);
    }
  }

  private envelope(param: AudioParam, t: number, peak: number, attack: number, dur: number) {
    param.setValueAtTime(SILENT, t);
    param.linearRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(SILENT, t + dur);
  }

  /** An oscillator sliding from f0 to f1 with an attack/decay envelope. */
  private tone(t: number, dest: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, peak: number, attack: number) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = this.ctx.createGain();
    this.envelope(g.gain, t, peak, attack, dur);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** A burst of filtered noise whose filter sweeps from f0 to f1. */
  private noiseHit(t: number, dest: AudioNode, type: BiquadFilterType, f0: number, f1: number, dur: number, peak: number, attack: number, q: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.ctx.createGain();
    this.envelope(g.gain, t, peak, attack, dur);
    src.connect(filter).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private notes(t: number, dest: AudioNode, freqs: number[], spacing: number, dur: number, peak: number, lastDur = dur, type: OscillatorType = 'triangle') {
    freqs.forEach((f, i) => this.tone(t + i * spacing, dest, type, f, f, i === freqs.length - 1 ? lastDur : dur, peak, 0.005));
  }

  private fire(t: number, dest: AudioNode) {
    this.noiseHit(t, dest, 'lowpass', 2600, 280, 0.3, 0.5, 0.003, 0.8);
    this.tone(t, dest, 'sine', 170, 45, 0.28, 0.6, 0.004);
  }

  /** size ~0.4 (shell) .. 1.5 (huge): bigger is lower, longer and heavier. */
  private explosion(t: number, dest: AudioNode, size: number) {
    const dur = 0.55 + 0.85 * size;
    this.noiseHit(t, dest, 'lowpass', 800 + 700 * size, 70, dur, 0.85, 0.004, 0.9);
    this.tone(t, dest, 'sine', 80, 28, dur * 0.75, 0.85 * Math.min(1, size + 0.2), 0.004);
    this.noiseHit(t, dest, 'highpass', 2600, 2600, 0.07, 0.3, 0.001, 0.7);
  }

  private nuke(t: number, volume: number) {
    const v = voice(this.ctx, this.out, 0, volume);
    // A long, swelling rumble under a burst of blasts across the stereo field.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(60, t + 4.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.7);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 4.5);
    src.connect(lp).connect(g).connect(v);
    src.start(t);
    src.stop(t + 4.6);
    this.tone(t, v, 'sine', 55, 26, 4.2, 0.9, 0.5);
    for (let i = 0; i < 12; i++) {
      const pan = Math.random() * 1.6 - 0.8;
      this.explosion(t + Math.random() * 1.2, voice(this.ctx, this.out, pan, volume * 0.6), 0.6 + Math.random() * 0.7);
    }
  }
}

/** gain(volume) -> stereo pan -> out */
function voice(ctx: BaseAudioContext, out: AudioNode, pan: number, volume: number): AudioNode {
  const g = ctx.createGain();
  g.gain.value = Math.max(0, volume);
  if (typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(out);
  } else {
    g.connect(out);
  }
  return g;
}

/**
 * The synthesized ambience beds, already running: rotor (low noise chopped ~14 times a second)
 * and wind (a soft band of noise whose colour drifts slowly). Outputs are before the level gains.
 */
export function synthAmbience(ctx: BaseAudioContext, noise: AudioBuffer): Record<AmbienceName, AudioNode> {
  const rotorSrc = ctx.createBufferSource();
  rotorSrc.buffer = noise;
  rotorSrc.loop = true;
  const rotorLp = ctx.createBiquadFilter();
  rotorLp.type = 'lowpass';
  rotorLp.frequency.value = 420;
  const chop = ctx.createGain();
  chop.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = 14;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.5;
  lfo.connect(lfoDepth).connect(chop.gain);
  rotorSrc.connect(rotorLp).connect(chop);
  rotorSrc.start();
  lfo.start();

  const windSrc = ctx.createBufferSource();
  windSrc.buffer = noise;
  windSrc.loop = true;
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = 'bandpass';
  windFilter.frequency.value = 550;
  windFilter.Q.value = 0.6;
  const drift = ctx.createOscillator();
  drift.frequency.value = 0.09;
  const driftDepth = ctx.createGain();
  driftDepth.gain.value = 220;
  drift.connect(driftDepth).connect(windFilter.frequency);
  windSrc.connect(windFilter);
  windSrc.start(0, 0.7);
  drift.start();
  return { rotor: chop, wind: windFilter };
}

/** decodeAudioData that also works on older Safari, which only has the callback form. */
function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

/** Where public/ is served: the site root, or Vite's `base` if the game is built under a sub-path. */
const PUBLIC_BASE: string = import.meta.env.BASE_URL ?? '/';

/** Read the per-browser pick overrides; anything malformed is ignored. */
export function loadPicks(): Partial<Record<SfxSlot, string>> {
  const out: Partial<Record<SfxSlot, string>> = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PICKS_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      for (const [slot, id] of Object.entries(raw as Record<string, unknown>)) {
        if (slot in SFX_MANIFEST && typeof id === 'string') out[slot as SfxSlot] = id;
      }
    }
  } catch {
    /* no overrides */
  }
  return out;
}

/** The candidate a slot plays with these overrides (null = synth). Unknown ids fall back to the default. */
export function resolvePick(slot: SfxSlot, picks: Partial<Record<SfxSlot, string>> = {}): SfxCandidate | null {
  const entry = SFX_MANIFEST[slot];
  if (!entry) return null;
  const want = picks[slot];
  if (want === SYNTH) return null;
  const chosen = want && entry.candidates.find((c) => c.id === want);
  if (chosen) return chosen;
  return entry.candidates.find((c) => c.id === entry.default) ?? null;
}

type AmbienceSlot = {
  /** Driven by setAmbience. */
  level: GainNode;
  /** 1 while the synth bed is audible, 0 while a sample loop plays instead. */
  synth: GainNode;
  /** The sample loop currently playing (if any) and its gain node. */
  loop: { src: AudioBufferSourceNode; gain: GainNode; file: string } | null;
  /** A candidate id (or "synth") the sound lab is auditioning instead of the pick. */
  audition: string | null;
};

/** Minimum gap between two plays of the same sound, so floods don't stack into noise. */
const MIN_GAP_MS: Partial<Record<SoundName, number>> = {
  tick: 45,
  fire: 25,
  explosion: 30,
  chat: 150,
  land: 60,
  cardDeal: 30,
  cardPlay: 40,
  lobbyJoin: 150,
  yourTurn: 300,
};

/** Sounds that repeat a lot get a slight random pitch so they don't sound machine-gunned. */
const VARY_PITCH = new Set<SoundName>(['fire', 'explosion', 'land', 'tick', 'cardDeal', 'cardPlay', 'cardPass', 'trickTake']);

const PREFS_KEY = 'tank.sound';
/** A sound that wouldn't download is tried again after this long. */
const LOAD_RETRY_MS = 10_000;

export interface SfxOptions {
  /** Sounds whose samples start loading as soon as audio unlocks (others load on first play). */
  preload?: readonly SoundName[];
}

/** The live game sound: owns the AudioContext, mixer, samples, ambience and player preferences. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private synth: Synth | null = null;
  private master: GainNode | null = null;
  private amb: Record<AmbienceName, AmbienceSlot> | null = null;
  private last = new Map<SoundName, number>();
  private recentBooms: number[] = [];
  /** Decoded samples by file, and the in-flight/finished loads (null = failed, use the synth). */
  private buffers = new Map<string, AudioBuffer>();
  private loads = new Map<string, Promise<AudioBuffer | null>>();
  private picks: Partial<Record<SfxSlot, string>>;
  private preload: readonly SoundName[];
  private ambienceRequested = false;
  volume = 0.8;
  muted = false;

  constructor(opts: SfxOptions = {}) {
    this.preload = opts.preload ?? SHARED_SOUNDS;
    this.picks = loadPicks();
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
      if (saved && typeof saved.volume === 'number') this.volume = Math.max(0, Math.min(1, saved.volume));
      if (saved && typeof saved.muted === 'boolean') this.muted = saved.muted;
    } catch {
      /* defaults */
    }
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') this.ctx.suspend().catch(() => {});
      else this.ctx.resume().catch(() => {});
    });
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /**
   * Create/resume the AudioContext. Browsers (iPhone especially) only allow this inside a user
   * gesture, so call it from tap/click/key handlers. Safe to call repeatedly. The first call also
   * starts loading the picked samples in the background; until each arrives its synth version plays.
   */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : this.volume;
      master.connect(comp).connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.synth = new Synth(ctx, master);
      for (const name of this.preload) {
        const c = resolvePick(name, this.picks);
        if (c) void this.load(c.file);
      }
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  play(name: SoundName, o: PlayOptions = {}) {
    if (!this.synth || !this.ready || this.muted) return;
    const now = performance.now();
    const gap = MIN_GAP_MS[name];
    if (gap && now - (this.last.get(name) ?? -1e9) < gap) return;
    this.last.set(name, now);
    if (name === 'explosion' || name === 'bigExplosion') {
      // Many blasts at once (spreads, nukes): keep it a roar, not a wall of clipping.
      this.recentBooms = this.recentBooms.filter((t) => now - t < 400);
      if (this.recentBooms.length >= 6) return;
      this.recentBooms.push(now);
    }
    this.playPick(name, resolvePick(name, this.picks), o);
  }

  /**
   * Also load these sounds' samples as soon as audio is unlocked (now, if it already is): e.g.
   * `preloadSounds(CARD_SOUNDS)` when a Hearts table opens, so its first card sounds aren't synth.
   */
  preloadSounds(names: readonly SoundName[]) {
    this.preload = [...new Set([...this.preload, ...names])];
    if (!this.ctx) return;
    for (const name of names) {
      const c = resolvePick(name, this.picks);
      if (c) void this.load(c.file);
    }
  }

  /** rotor, wind: 0..1 loudness for the looping ambience. */
  setAmbience(rotor: number, wind: number) {
    if (!this.ctx) return;
    // Nothing runs until there's something to hear: card and puzzle tables never build it.
    if (!this.amb && (rotor > 0 || wind > 0)) this.ensureAmbience();
    if (!this.amb) return;
    if (!this.ambienceRequested) {
      // Only games that use ambience pay for downloading its loops.
      this.ambienceRequested = true;
      for (const slot of AMBIENCE_NAMES) this.refreshAmbience(slot);
    }
    const t = this.ctx.currentTime;
    this.amb.rotor.level.gain.setTargetAtTime(Math.max(0, Math.min(1, rotor)) * 0.22, t, 0.15);
    this.amb.wind.level.gain.setTargetAtTime(0.012 + Math.max(0, Math.min(1, wind)) * 0.05, t, 0.6);
  }

  /** Leaving the game that had ambience: silence (not the faint wind of a calm day), loops stopped. */
  stopAmbience() {
    if (!this.amb || !this.ctx) return;
    this.ambienceRequested = false;
    for (const name of AMBIENCE_NAMES) {
      this.amb[name].level.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
      this.stopLoop(this.amb[name]);
    }
  }

  private ensureAmbience() {
    if (this.ctx && this.master && this.synth) this.amb ??= this.buildAmbience(this.ctx, this.master, this.synth.noise);
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.volume > 0) this.muted = false;
    this.apply();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.apply();
    return this.muted;
  }

  // ---- Sample picks (used by the sound lab; the game only needs the defaults) ----

  /** The candidate id (or "synth") a slot currently uses in this browser. */
  pickOf(slot: SfxSlot): string {
    return resolvePick(slot, this.picks)?.id ?? SYNTH;
  }

  /** Override a slot's pick for this browser (null = back to the manifest default) and save it. */
  setPick(slot: SfxSlot, id: string | null) {
    if (id === null || id === SFX_MANIFEST[slot]?.default) delete this.picks[slot];
    else this.picks[slot] = id;
    try {
      if (Object.keys(this.picks).length) localStorage.setItem(PICKS_KEY, JSON.stringify(this.picks));
      else localStorage.removeItem(PICKS_KEY);
    } catch {
      /* ignore */
    }
    const c = resolvePick(slot, this.picks);
    if (c && this.ctx) void this.load(c.file);
    if ((AMBIENCE_NAMES as string[]).includes(slot)) this.refreshAmbience(slot as AmbienceName);
  }

  /** The current overrides (slot -> id), e.g. to copy into the manifest defaults. */
  get pickOverrides(): Partial<Record<SfxSlot, string>> {
    return { ...this.picks };
  }

  /**
   * Play one specific version of a sound right away, ignoring picks and rate limits: "synth" or a
   * candidate id. Waits for the sample to load; resolves false if it could not be played as a sample.
   */
  async audition(name: SoundName, id: string, o: PlayOptions = {}): Promise<boolean> {
    if (!this.synth || !this.ctx) return false;
    const c = id === SYNTH ? null : (SFX_MANIFEST[name]?.candidates.find((x) => x.id === id) ?? null);
    if (c) await this.load(c.file);
    this.playPick(name, c, o);
    return !c || this.buffers.has(c.file);
  }

  /** Make an ambience bed play a specific version (or null to go back to its pick) without saving. */
  auditionAmbience(slot: AmbienceName, id: string | null) {
    this.ensureAmbience();
    if (!this.amb) return;
    this.ambienceRequested = true;
    this.amb[slot].audition = id;
    this.refreshAmbience(slot);
  }

  /** Fetch and decode a sample once; resolves null (and the synth keeps playing) if that fails. */
  load(file: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    let p = this.loads.get(file);
    if (!p) {
      p = fetch(PUBLIC_BASE + file)
        .then((r) => {
          if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((data) => decode(ctx, data))
        .then((buf) => {
          this.buffers.set(file, buf);
          return buf;
        })
        .catch(() => {
          // A blip shouldn't mean the stand-in sound for as long as the page is open.
          setTimeout(() => this.loads.delete(file), LOAD_RETRY_MS);
          return null;
        });
      this.loads.set(file, p);
    }
    return p;
  }

  private playPick(name: SoundName, c: SfxCandidate | null, o: PlayOptions) {
    const buf = c && this.buffers.get(c.file);
    if (!c || !buf) {
      if (c) void this.load(c.file); // not preloaded (or still loading): synth this time
      this.synth?.play(name, o);
      return;
    }
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005 + (o.delay ?? 0);
    let volume = o.volume ?? 1;
    let rate = 1;
    const size = o.size ?? 1;
    if (name === 'explosion') {
      // Like the synth: bigger blasts are lower, longer and louder.
      rate = Math.max(0.75, Math.min(1.15, 1.2 - 0.3 * size));
      volume *= Math.min(1, 0.6 + 0.4 * size);
    } else if (name === 'bigExplosion' && size > 1.2) {
      rate = 0.85;
    }
    if (VARY_PITCH.has(name)) rate *= 1 + (Math.random() - 0.5) * 0.08;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(voice(ctx, this.master!, o.pan ?? 0, volume * c.gain));
    src.start(t);
  }

  private apply() {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.03);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }));
    } catch {
      /* ignore */
    }
  }

  private buildAmbience(ctx: AudioContext, out: AudioNode, noise: AudioBuffer): Record<AmbienceName, AmbienceSlot> {
    const beds = synthAmbience(ctx, noise);
    const slot = (bed: AudioNode): AmbienceSlot => {
      const level = ctx.createGain();
      level.gain.value = 0;
      level.connect(out);
      const synth = ctx.createGain();
      bed.connect(synth).connect(level);
      return { level, synth, loop: null, audition: null };
    };
    return { rotor: slot(beds.rotor), wind: slot(beds.wind) };
  }

  /** The loop an ambience bed should play now: the lab's audition, else the pick (null = synth). */
  private ambienceCandidate(name: AmbienceName): SfxCandidate | null {
    const id = this.amb?.[name].audition ?? null;
    if (id === null) return resolvePick(name, this.picks);
    if (id === SYNTH) return null;
    return SFX_MANIFEST[name]?.candidates.find((x) => x.id === id) ?? null;
  }

  /** Swap an ambience bed between its synth version and its picked (or auditioned) sample loop. */
  private refreshAmbience(name: AmbienceName) {
    const ctx = this.ctx;
    const slot = this.amb?.[name];
    if (!ctx || !slot || !this.ambienceRequested) return;
    const c = this.ambienceCandidate(name);
    const useSynth = () => {
      slot.synth.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
      this.stopLoop(slot);
    };
    if (!c) return useSynth();
    if (slot.loop?.file === c.file) return;
    useSynth(); // until the loop is ready (or for good, if it fails)
    void this.load(c.file).then((buf) => {
      // Ignore a load that finished after the pick changed again.
      if (!buf || this.ambienceCandidate(name)?.file !== c.file || slot.loop) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(c.gain, ctx.currentTime, 0.05);
      src.connect(gain).connect(slot.level);
      src.start(0, Math.random() * buf.duration);
      slot.synth.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      slot.loop = { src, gain, file: c.file };
    });
  }

  private stopLoop(slot: AmbienceSlot) {
    if (!slot.loop || !this.ctx) return;
    const { src, gain } = slot.loop;
    gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    src.stop(this.ctx.currentTime + 0.3);
    slot.loop = null;
  }
}
