/**
 * Builds the game's sample sounds from downloaded CC0 packs:
 *   npx tsx scripts/sfx-build.ts <downloads-dir>
 *
 * <downloads-dir> holds each pack unpacked in its own folder (the `src` paths below), e.g.
 * kenney-sci-fi-sounds/extracted/Audio/... from https://kenney.nl/assets/sci-fi-sounds. For each
 * file it: decodes (Ogg Vorbis or WAV), mixes to mono, trims/speeds/loops as listed, removes
 * leading silence and the silent tail, resamples (windowed sinc), peak-normalizes to -1 dBFS and
 * writes 16-bit mono WAV (Ogg isn't reliable in iPhone Safari's decodeAudioData). Then it writes
 * packages/client/src/sfx-manifest.ts, with a per-candidate gain that puts each sample at the
 * K-weighted loudness of the synth version it replaces, and CREDITS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav, freeDecoder, loudnessDb, readAudio } from './sfx-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'packages/client/public');
const DOWNLOADED = '2026-11-16';

/**
 * Loudness of each synth version (K-weighted dB, loudest 400 ms, or the average for the ambience
 * beds), measured in the sound lab with `await __sfxLab.targets(6)`. Re-measure if a recipe changes.
 */
const TARGET_DB: Record<string, number> = {
  fire: -21,
  explosion: -14.1,
  bigExplosion: -13.4,
  heliDown: -13.6,
  nuke: -7.5,
  drop: -31.1,
  chute: -30.9,
  land: -23.9,
  shield: -25.5,
  levelUp: -28.4,
  perk: -22.6,
  bounty: -23.7,
  win: -23.6,
  myDeath: -26,
  chat: -36.4,
  tick: -52.1,
  spreadReady: -33.3,
  blastWarn: -36.3,
  cardDeal: -34.9,
  cardPlay: -32,
  cardPass: -32.7,
  trickTake: -31.7,
  heartsBroken: -26.2,
  queenSpades: -25,
  yourTurn: -28.4,
  handEnd: -27,
  lobbyJoin: -29.9,
  rotor: -24.9,
  wind: -13.8,
};

interface Source {
  pack: string;
  url: string;
  author: string;
}
const kenney = (slug: string, title: string): Source => ({
  pack: `Kenney ${title}`,
  url: `https://kenney.nl/assets/${slug}`,
  author: 'Kenney (kenney.nl)',
});
const oga = (slug: string, title: string, author: string): Source => ({
  pack: `OpenGameArt "${title}"`,
  url: `https://opengameart.org/content/${slug}`,
  author,
});
const K_IMPACT = kenney('impact-sounds', 'Impact Sounds');
const K_SCIFI = kenney('sci-fi-sounds', 'Sci-Fi Sounds');
const K_INTERFACE = kenney('interface-sounds', 'Interface Sounds');
const K_DIGITAL = kenney('digital-audio', 'Digital Audio');
const K_RPG = kenney('rpg-audio', 'RPG Audio');
const K_CASINO = kenney('casino-audio', 'Casino Audio');
const K_JINGLES = kenney('music-jingles', 'Music Jingles');
const O_CANNON = oga('cannon-fire', 'Cannon fire', 'Thimras');
const O_BATTLE = oga('battle-at-sea', 'Battle at sea', 'Thimras');
const O_BANGS = oga('25-cc0-bang-firework-sfx', '25 CC0 bang / firework SFX', 'rubberduck');
const O_MECH = oga('mechanical-explosion', 'Mechanical Explosion', 'Spring Spring');
const O_HELI = oga('helicopter-sfx', 'Helicopter SFX', 'WuxiaScrub');
const O_PROP = oga('propeller-cartoon-loop', 'Propeller (Cartoon) Loop', 'Mish7913');
const O_WIND_LOOP = oga('wind-whoosh-loop', 'wind whoosh loop', 'SketchMan3');

interface FileSpec {
  /** Path under the downloads dir. */
  src: string;
  from: Source;
  /** Output sample rate. */
  rate: number;
  /** Seconds of the source to keep (before any speed change). */
  start?: number;
  end?: number;
  /** Playback speed baked in: 0.5 = an octave lower and twice as long. */
  speed?: number;
  /** Fade-out length in seconds at the end (default: a short anti-click fade). */
  fadeOut?: number;
  /** Make a seamless loop of `loop.length` seconds from `start`, crossfading the seam. */
  loop?: { length: number; crossfade: number };
  /** Already a seamless loop: keep it whole and resample it as periodic. */
  periodic?: boolean;
}

const J = 'kenney-music-jingles/extracted/Audio';
const files: Record<string, FileSpec> = {
  // ---- tank: cannon, explosions
  'tank/cannon-fire-thimras': { src: 'oga-cannon-fire/cannon_fire_0.ogg', from: O_CANNON, rate: 22050, end: 1.2, fadeOut: 0.6 },
  'tank/bang-09-rubberduck': { src: 'oga-25-cc0-bang-firework-sfx/extracted/bang_09.ogg', from: O_BANGS, rate: 22050, end: 0.9, fadeOut: 0.4 },
  'tank/explosion-crunch-000': { src: 'kenney-sci-fi-sounds/extracted/Audio/explosionCrunch_000.ogg', from: K_SCIFI, rate: 22050 },
  'tank/explosion-crunch-001': { src: 'kenney-sci-fi-sounds/extracted/Audio/explosionCrunch_001.ogg', from: K_SCIFI, rate: 22050 },
  'tank/explosion-crunch-003': { src: 'kenney-sci-fi-sounds/extracted/Audio/explosionCrunch_003.ogg', from: K_SCIFI, rate: 22050 },
  'tank/explosion-crunch-004': { src: 'kenney-sci-fi-sounds/extracted/Audio/explosionCrunch_004.ogg', from: K_SCIFI, rate: 22050 },
  'tank/low-explosion-000': { src: 'kenney-sci-fi-sounds/extracted/Audio/lowFrequency_explosion_000.ogg', from: K_SCIFI, rate: 22050 },
  'tank/low-explosion-001': { src: 'kenney-sci-fi-sounds/extracted/Audio/lowFrequency_explosion_001.ogg', from: K_SCIFI, rate: 22050 },
  'tank/cannon-hit-thimras': { src: 'oga-battle-at-sea/cannon_hit_1.ogg', from: O_BATTLE, rate: 22050, end: 3.0, fadeOut: 0.8 },
  'tank/mechanical-explosion-springspring': { src: 'oga-mechanical-explosion/mechanical_explosion.wav', from: O_MECH, rate: 24000 },
  'tank/ship-destroyed-thimras': { src: 'oga-battle-at-sea/ship_destroyed_short.ogg', from: O_BATTLE, rate: 16000, start: 0.2, end: 6.7, fadeOut: 2 },
  // ---- tank: helicopter drop, parachute, landing, shield
  'tank/metal-latch': { src: 'kenney-rpg-audio/extracted/Audio/metalLatch.ogg', from: K_RPG, rate: 24000 },
  'tank/interface-drop-002': { src: 'kenney-interface-sounds/extracted/Audio/drop_002.ogg', from: K_INTERFACE, rate: 24000 },
  'tank/cloth-1': { src: 'kenney-rpg-audio/extracted/Audio/cloth1.ogg', from: K_RPG, rate: 24000 },
  'tank/cloth-3': { src: 'kenney-rpg-audio/extracted/Audio/cloth3.ogg', from: K_RPG, rate: 24000 },
  'tank/impact-soft-heavy-003': { src: 'kenney-impact-sounds/extracted/Audio/impactSoft_heavy_003.ogg', from: K_IMPACT, rate: 22050 },
  'tank/impact-plate-heavy-001': { src: 'kenney-impact-sounds/extracted/Audio/impactPlate_heavy_001.ogg', from: K_IMPACT, rate: 22050 },
  'tank/impact-punch-heavy-000': { src: 'kenney-impact-sounds/extracted/Audio/impactPunch_heavy_000.ogg', from: K_IMPACT, rate: 22050 },
  'tank/force-field-000': { src: 'kenney-sci-fi-sounds/extracted/Audio/forceField_000.ogg', from: K_SCIFI, rate: 24000 },
  'tank/force-field-002': { src: 'kenney-sci-fi-sounds/extracted/Audio/forceField_002.ogg', from: K_SCIFI, rate: 24000 },
  'tank/impact-metal-light-003': { src: 'kenney-impact-sounds/extracted/Audio/impactMetal_light_003.ogg', from: K_IMPACT, rate: 24000 },
  // ---- jingles and UI (shared by both games)
  'ui/jingle-pizzi-02': { src: `${J}/Pizzicato jingles/jingles_PIZZI02.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-pizzi-07': { src: `${J}/Pizzicato jingles/jingles_PIZZI07.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-pizzi-15': { src: `${J}/Pizzicato jingles/jingles_PIZZI15.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-pizzi-16': { src: `${J}/Pizzicato jingles/jingles_PIZZI16.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-nes-00': { src: `${J}/8-Bit jingles/jingles_NES00.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-nes-03': { src: `${J}/8-Bit jingles/jingles_NES03.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-nes-09': { src: `${J}/8-Bit jingles/jingles_NES09.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-nes-12': { src: `${J}/8-Bit jingles/jingles_NES12.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-steel-02': { src: `${J}/Steel jingles/jingles_STEEL02.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-steel-10': { src: `${J}/Steel jingles/jingles_STEEL10.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-steel-15': { src: `${J}/Steel jingles/jingles_STEEL15.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-steel-16': { src: `${J}/Steel jingles/jingles_STEEL16.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-sax-07': { src: `${J}/Sax jingles/jingles_SAX07.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-hit-03': { src: `${J}/Hit jingles/jingles_HIT03.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/jingle-hit-11': { src: `${J}/Hit jingles/jingles_HIT11.ogg`, from: K_JINGLES, rate: 24000 },
  'ui/handle-coins': { src: 'kenney-rpg-audio/extracted/Audio/handleCoins.ogg', from: K_RPG, rate: 24000 },
  'ui/confirmation-001': { src: 'kenney-interface-sounds/extracted/Audio/confirmation_001.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/confirmation-002': { src: 'kenney-interface-sounds/extracted/Audio/confirmation_002.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/confirmation-004': { src: 'kenney-interface-sounds/extracted/Audio/confirmation_004.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/maximize-006': { src: 'kenney-interface-sounds/extracted/Audio/maximize_006.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/maximize-008': { src: 'kenney-interface-sounds/extracted/Audio/maximize_008.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/maximize-009': { src: 'kenney-interface-sounds/extracted/Audio/maximize_009.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/question-001': { src: 'kenney-interface-sounds/extracted/Audio/question_001.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/question-004': { src: 'kenney-interface-sounds/extracted/Audio/question_004.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/bong-001': { src: 'kenney-interface-sounds/extracted/Audio/bong_001.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/pluck-002': { src: 'kenney-interface-sounds/extracted/Audio/pluck_002.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/glass-001': { src: 'kenney-interface-sounds/extracted/Audio/glass_001.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/glass-004': { src: 'kenney-interface-sounds/extracted/Audio/glass_004.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/tick-001': { src: 'kenney-interface-sounds/extracted/Audio/tick_001.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/tick-002': { src: 'kenney-interface-sounds/extracted/Audio/tick_002.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/click-002': { src: 'kenney-interface-sounds/extracted/Audio/click_002.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/error-003': { src: 'kenney-interface-sounds/extracted/Audio/error_003.ogg', from: K_INTERFACE, rate: 24000 },
  'ui/power-up-9': { src: 'kenney-digital-audio/extracted/Audio/powerUp9.ogg', from: K_DIGITAL, rate: 24000 },
  'ui/power-up-12': { src: 'kenney-digital-audio/extracted/Audio/powerUp12.ogg', from: K_DIGITAL, rate: 24000 },
  'ui/low-three-tone': { src: 'kenney-digital-audio/extracted/Audio/lowThreeTone.ogg', from: K_DIGITAL, rate: 24000 },
  'ui/impact-glass-heavy-001': { src: 'kenney-impact-sounds/extracted/Audio/impactGlass_heavy_001.ogg', from: K_IMPACT, rate: 24000 },
  // ---- cards (Hearts)
  'cards/card-slide-1': { src: 'kenney-casino-audio/extracted/Audio/card-slide-1.ogg', from: K_CASINO, rate: 28000 },
  'cards/card-slide-3': { src: 'kenney-casino-audio/extracted/Audio/card-slide-3.ogg', from: K_CASINO, rate: 28000 },
  'cards/card-slide-4': { src: 'kenney-casino-audio/extracted/Audio/card-slide-4.ogg', from: K_CASINO, rate: 28000 },
  'cards/card-place-1': { src: 'kenney-casino-audio/extracted/Audio/card-place-1.ogg', from: K_CASINO, rate: 28000 },
  'cards/card-place-2': { src: 'kenney-casino-audio/extracted/Audio/card-place-2.ogg', from: K_CASINO, rate: 28000 },
  'cards/card-place-4': { src: 'kenney-casino-audio/extracted/Audio/card-place-4.ogg', from: K_CASINO, rate: 28000 },
  'cards/card-shove-1': { src: 'kenney-casino-audio/extracted/Audio/card-shove-1.ogg', from: K_CASINO, rate: 28000 },
  'cards/card-shove-2': { src: 'kenney-casino-audio/extracted/Audio/card-shove-2.ogg', from: K_CASINO, rate: 28000 },
  'cards/card-shove-4': { src: 'kenney-casino-audio/extracted/Audio/card-shove-4.ogg', from: K_CASINO, rate: 28000 },
  'cards/card-fan-1': { src: 'kenney-casino-audio/extracted/Audio/card-fan-1.ogg', from: K_CASINO, rate: 28000 },
  'cards/cards-pack-take-out-1': { src: 'kenney-casino-audio/extracted/Audio/cards-pack-take-out-1.ogg', from: K_CASINO, rate: 28000 },
  // ---- ambience loops
  'ambience/helicopter-wuxiascrub': { src: 'oga-helicopter-sfx/heli_0.ogg', from: O_HELI, rate: 22050, start: 13, loop: { length: 47 / 11.8, crossfade: 0.3 } },
  'ambience/propeller-cartoon-mish7913': { src: 'oga-propeller-cartoon-loop/propeller_cartoon_loop.wav', from: O_PROP, rate: 22050, periodic: true },
  'ambience/wind-whoosh-loop-sketchman3': { src: 'oga-wind-whoosh-loop/wind_woosh_loop.ogg', from: O_WIND_LOOP, rate: 22050, periodic: true },
};

interface Pick {
  file: keyof typeof files;
  label: string;
}
type SlotSpec = { default: string; candidates: Pick[] };

/** Candidate ids are the file's base name. `default` is a candidate id or "synth". */
const slots: Record<string, SlotSpec> = {
  fire: {
    default: 'cannon-fire-thimras',
    candidates: [
      { file: 'tank/cannon-fire-thimras', label: 'Cannon fire (deep boom)' },
      { file: 'tank/bang-09-rubberduck', label: 'Firework bang (sharp)' },
      { file: 'tank/low-explosion-001', label: 'Low boom 1 s' },
    ],
  },
  explosion: {
    default: 'explosion-crunch-001',
    candidates: [
      { file: 'tank/explosion-crunch-001', label: 'Crunchy explosion 1.4 s' },
      { file: 'tank/explosion-crunch-000', label: 'Crunchy explosion 0.8 s' },
      { file: 'tank/explosion-crunch-003', label: 'Crunchy explosion 1.6 s' },
      { file: 'tank/low-explosion-001', label: 'Low boom 1 s' },
    ],
  },
  bigExplosion: {
    default: 'explosion-crunch-004',
    candidates: [
      { file: 'tank/explosion-crunch-004', label: 'Deep crunchy explosion 2 s' },
      { file: 'tank/low-explosion-000', label: 'Low boom 2 s' },
      { file: 'tank/cannon-hit-thimras', label: 'Cannonball hit, multi-stage 3 s' },
    ],
  },
  heliDown: {
    default: 'mechanical-explosion-springspring',
    candidates: [
      { file: 'tank/mechanical-explosion-springspring', label: 'Explosion with clattering metal' },
      { file: 'tank/explosion-crunch-003', label: 'Crunchy explosion 1.6 s' },
      { file: 'tank/explosion-crunch-004', label: 'Deep crunchy explosion 2 s' },
    ],
  },
  nuke: {
    default: 'ship-destroyed-thimras',
    candidates: [
      { file: 'tank/ship-destroyed-thimras', label: 'Chain of explosions 6.5 s' },
      { file: 'tank/cannon-hit-thimras', label: 'Cannonball hit, multi-stage 3 s' },
      { file: 'tank/low-explosion-000', label: 'Low boom 2 s' },
    ],
  },
  drop: {
    default: 'metal-latch',
    candidates: [
      { file: 'tank/metal-latch', label: 'Metal latch release' },
      { file: 'tank/interface-drop-002', label: 'UI drop' },
    ],
  },
  chute: {
    default: 'cloth-1',
    candidates: [
      { file: 'tank/cloth-1', label: 'Cloth flap' },
      { file: 'tank/cloth-3', label: 'Cloth flap (short)' },
    ],
  },
  land: {
    default: 'impact-soft-heavy-003',
    candidates: [
      { file: 'tank/impact-soft-heavy-003', label: 'Heavy soft thud' },
      { file: 'tank/impact-plate-heavy-001', label: 'Heavy plate impact' },
      { file: 'tank/impact-punch-heavy-000', label: 'Heavy punch thump' },
    ],
  },
  shield: {
    default: 'force-field-002',
    candidates: [
      { file: 'tank/force-field-002', label: 'Force field' },
      { file: 'tank/force-field-000', label: 'Force field (lower)' },
      { file: 'tank/impact-metal-light-003', label: 'Light metal ting' },
    ],
  },
  levelUp: {
    default: 'jingle-pizzi-16',
    candidates: [
      { file: 'ui/jingle-pizzi-16', label: 'Pizzicato: rising fifth' },
      { file: 'ui/jingle-nes-09', label: '8-bit: rising fifth' },
      { file: 'ui/jingle-steel-16', label: 'Steel drum: rising fifth' },
    ],
  },
  perk: {
    default: 'confirmation-004',
    candidates: [
      { file: 'ui/confirmation-004', label: 'Rising major arpeggio' },
      { file: 'ui/maximize-006', label: 'Soft arpeggio' },
      { file: 'ui/power-up-9', label: 'Digital power-up' },
    ],
  },
  bounty: {
    default: 'jingle-pizzi-02',
    candidates: [
      { file: 'ui/jingle-pizzi-02', label: 'Pizzicato: rising run' },
      { file: 'ui/jingle-nes-12', label: '8-bit: rising run' },
      { file: 'ui/handle-coins', label: 'Handful of coins' },
    ],
  },
  win: {
    default: 'jingle-steel-10',
    candidates: [
      { file: 'ui/jingle-steel-10', label: 'Steel drum: rising to the tonic' },
      { file: 'ui/jingle-nes-03', label: '8-bit: rising to the tonic' },
      { file: 'ui/jingle-steel-02', label: 'Steel drum: long rising run' },
    ],
  },
  myDeath: {
    default: 'jingle-pizzi-07',
    candidates: [
      { file: 'ui/jingle-pizzi-07', label: 'Pizzicato: sad chromatic fall' },
      { file: 'ui/jingle-nes-00', label: '8-bit: sad chromatic fall' },
      { file: 'ui/jingle-sax-07', label: 'Sax: sad chromatic fall' },
    ],
  },
  chat: {
    default: 'maximize-009',
    candidates: [
      { file: 'ui/maximize-009', label: 'Two-note blip up' },
      { file: 'ui/pluck-002', label: 'Pluck' },
      { file: 'ui/glass-001', label: 'Glass ting' },
    ],
  },
  tick: {
    default: 'tick-002',
    candidates: [
      { file: 'ui/tick-002', label: 'Tick' },
      { file: 'ui/tick-001', label: 'Tick (brighter)' },
      { file: 'ui/click-002', label: 'Click' },
    ],
  },
  spreadReady: {
    default: 'confirmation-001',
    candidates: [
      { file: 'ui/confirmation-001', label: 'Three-note confirm' },
      { file: 'ui/confirmation-002', label: 'Bright confirm' },
      { file: 'ui/maximize-006', label: 'Soft arpeggio' },
    ],
  },
  blastWarn: {
    default: 'power-up-12',
    candidates: [
      { file: 'ui/power-up-12', label: 'Four alternating beeps' },
      { file: 'ui/error-003', label: 'Error buzz' },
      { file: 'ui/low-three-tone', label: 'Low ominous tones' },
    ],
  },
  cardDeal: {
    default: 'card-slide-4',
    candidates: [
      { file: 'cards/card-slide-4', label: 'Card slide (short)' },
      { file: 'cards/card-slide-1', label: 'Card slide' },
      { file: 'cards/card-slide-3', label: 'Card slide (fuller)' },
    ],
  },
  cardPlay: {
    default: 'card-place-1',
    candidates: [
      { file: 'cards/card-place-1', label: 'Card placed' },
      { file: 'cards/card-place-2', label: 'Card placed (soft)' },
      { file: 'cards/card-place-4', label: 'Card placed (light)' },
    ],
  },
  cardPass: {
    default: 'card-shove-4',
    candidates: [
      { file: 'cards/card-shove-4', label: 'Cards shoved across' },
      { file: 'cards/card-shove-1', label: 'Cards shoved (crisper)' },
      { file: 'cards/card-fan-1', label: 'Cards fanned' },
    ],
  },
  trickTake: {
    default: 'card-fan-1',
    candidates: [
      { file: 'cards/card-fan-1', label: 'Cards gathered' },
      { file: 'cards/card-shove-2', label: 'Cards swept' },
      { file: 'cards/cards-pack-take-out-1', label: 'Cards pulled' },
    ],
  },
  heartsBroken: {
    default: 'jingle-hit-03',
    candidates: [
      { file: 'ui/jingle-hit-03', label: 'Dramatic rising hit' },
      { file: 'ui/glass-004', label: 'Glass chime' },
      { file: 'ui/impact-glass-heavy-001', label: 'Glass knock' },
    ],
  },
  queenSpades: {
    default: 'jingle-sax-07',
    candidates: [
      { file: 'ui/jingle-sax-07', label: 'Sax: wah-wah-wah fall' },
      { file: 'ui/jingle-nes-00', label: '8-bit: sad chromatic fall' },
      { file: 'ui/jingle-hit-11', label: 'Dramatic hit' },
    ],
  },
  yourTurn: {
    default: 'confirmation-002',
    candidates: [
      { file: 'ui/confirmation-002', label: 'Bright rising chime' },
      { file: 'ui/question-001', label: 'Falling chime' },
      { file: 'ui/bong-001', label: 'Soft bong' },
    ],
  },
  handEnd: {
    default: 'jingle-pizzi-15',
    candidates: [
      { file: 'ui/jingle-pizzi-15', label: 'Pizzicato cadence' },
      { file: 'ui/jingle-steel-15', label: 'Steel drum cadence' },
    ],
  },
  lobbyJoin: {
    default: 'question-004',
    candidates: [
      { file: 'ui/question-004', label: 'Ding-dong' },
      { file: 'ui/maximize-008', label: 'Rising blip' },
      { file: 'ui/pluck-002', label: 'Pluck' },
    ],
  },
  rotor: {
    default: 'helicopter-wuxiascrub',
    candidates: [
      { file: 'ambience/helicopter-wuxiascrub', label: 'Helicopter (recorded, steady pass)' },
      { file: 'ambience/propeller-cartoon-mish7913', label: 'Cartoon propeller' },
    ],
  },
  wind: {
    default: 'wind-whoosh-loop-sketchman3',
    candidates: [
      { file: 'ambience/wind-whoosh-loop-sketchman3', label: 'Wind whoosh' },
    ],
  },
};

// ------------------------------------------------------------------ DSP

const sinc = (u: number) => (u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u));

/** Windowed-sinc resampling to `outLen` samples; `periodic` treats the input as a loop. */
function resample(x: Float32Array, outLen: number, periodic: boolean): Float32Array {
  const n = x.length;
  if (outLen === n) return x.slice();
  const step = n / outLen; // input samples per output sample
  const cutoff = Math.min(1, 1 / step) * 0.94;
  const half = Math.ceil(12 / cutoff);
  const out = new Float32Array(outLen);
  for (let j = 0; j < outLen; j++) {
    const center = j * step;
    let acc = 0;
    for (let i = Math.ceil(center - half); i <= Math.floor(center + half); i++) {
      let k = i;
      if (periodic) k = ((i % n) + n) % n;
      else if (i < 0 || i >= n) continue;
      const t = i - center;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / half) + 0.08 * Math.cos((2 * Math.PI * t) / half);
      acc += x[k] * cutoff * sinc(cutoff * t) * w;
    }
    out[j] = acc;
  }
  return out;
}

function peakOf(x: Float32Array) {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

interface Built {
  key: string;
  rel: string;
  duration: number;
  loop: boolean;
  bytes: number;
  changes: string;
  seam?: number;
}

async function build(key: string, spec: FileSpec, downloads: string): Promise<Built> {
  const pcm = await readAudio(path.join(downloads, spec.src));
  const sr = pcm.sampleRate;
  let x = pcm.data;
  const changes: string[] = [];
  const srcKind = spec.src.toLowerCase().endsWith('.wav') ? 'WAV' : 'Ogg Vorbis';
  changes.push(`converted ${srcKind}${pcm.channels > 1 ? ' stereo' : ''} to 16-bit mono WAV at ${spec.rate / 1000} kHz`);
  const isLoop = !!spec.loop || !!spec.periodic;

  if (spec.loop) {
    const s = Math.round((spec.start ?? 0) * sr);
    const len = Math.round(spec.loop.length * sr);
    const xf = Math.round(spec.loop.crossfade * sr);
    if (s + len + xf > x.length) throw new Error(`${key}: loop runs past the end`);
    const seg = x.subarray(s, s + len + xf);
    const out = seg.slice(0, len);
    for (let i = 0; i < xf; i++) {
      const a = (Math.PI / 2) * (i / xf);
      out[i] = seg[i] * Math.sin(a) + seg[len + i] * Math.cos(a); // equal-power seam
    }
    x = out;
    changes.push(`cut a ${spec.loop.length.toFixed(2)} s loop from ${spec.start ?? 0} s with a ${spec.loop.crossfade} s crossfade at the seam`);
  } else if (!spec.periodic) {
    if (spec.start !== undefined || spec.end !== undefined) {
      const s = Math.round((spec.start ?? 0) * sr);
      const e = Math.min(x.length, Math.round((spec.end ?? x.length / sr) * sr));
      x = x.slice(s, e);
      changes.push(`trimmed to ${(spec.start ?? 0).toFixed(2)}–${(e / sr).toFixed(2)} s`);
    }
    // Drop leading silence (keep 5 ms) and the inaudible tail.
    const peak = peakOf(x);
    let first = 0;
    while (first < x.length && Math.abs(x[first]) < peak * 0.01) first++;
    let last = x.length - 1;
    while (last > first && Math.abs(x[last]) < peak * 0.001) last--;
    const from = Math.max(0, first - Math.round(0.005 * sr));
    const to = Math.min(x.length, last + Math.round(0.02 * sr));
    if (from > 0.01 * sr) changes.push(`removed ${(from / sr).toFixed(2)} s of leading silence`);
    x = x.slice(from, to);
  }

  let outLen = Math.round((x.length * spec.rate) / sr);
  if (spec.speed) {
    outLen = Math.round(outLen / spec.speed);
    changes.push(`slowed to ${spec.speed}x speed (pitch down)`);
  }
  x = resample(x, outLen, isLoop);

  if (!isLoop) {
    const fadeIn = Math.min(x.length, Math.round(0.002 * spec.rate));
    for (let i = 0; i < fadeIn; i++) x[i] *= i / fadeIn;
    const fade = Math.min(x.length, Math.round((spec.fadeOut ?? 0.015) * spec.rate));
    for (let i = 0; i < fade; i++) x[x.length - 1 - i] *= (i / fade) ** 2;
    if (spec.fadeOut) changes.push(`${spec.fadeOut} s fade-out`);
  }

  const gain = 10 ** (-1 / 20) / peakOf(x);
  for (let i = 0; i < x.length; i++) x[i] *= gain;
  changes.push('peak-normalized to -1 dBFS');

  const rel = `sfx/${key}.wav`;
  const bytes = encodeWav(x, spec.rate);
  fs.mkdirSync(path.dirname(path.join(PUBLIC, rel)), { recursive: true });
  fs.writeFileSync(path.join(PUBLIC, rel), bytes);

  // How big the jump at the loop point is, relative to a typical sample-to-sample step.
  let seam: number | undefined;
  if (isLoop) {
    let sum = 0;
    for (let i = 1; i < x.length; i++) sum += Math.abs(x[i] - x[i - 1]);
    seam = Math.abs(x[0] - x[x.length - 1]) / (sum / (x.length - 1));
  }
  built.set(key, x);
  return { key, rel, duration: x.length / spec.rate, loop: isLoop, bytes: bytes.length, changes: changes.join('; '), seam };
}

const built = new Map<string, Float32Array>();

// ------------------------------------------------------------------ main

const downloads = process.argv[2];
if (!downloads || !fs.existsSync(downloads)) {
  console.error('usage: npx tsx scripts/sfx-build.ts <downloads-dir>');
  process.exit(1);
}

// Start from a clean output folder so dropped candidates don't linger.
fs.rmSync(path.join(PUBLIC, 'sfx'), { recursive: true, force: true });

const results = new Map<string, Built>();
for (const [key, spec] of Object.entries(files)) {
  const r = await build(key, spec, downloads);
  results.set(key, r);
  console.log(`${r.rel.padEnd(52)} ${r.duration.toFixed(2).padStart(5)} s ${(r.bytes / 1024).toFixed(0).padStart(4)} KB${r.seam !== undefined ? `  seam ${r.seam.toFixed(1)}x` : ''}`);
}
freeDecoder();

const used = new Set<string>();
const lines: string[] = [];
for (const [slot, s] of Object.entries(slots)) {
  const target = TARGET_DB[slot];
  if (target === undefined) throw new Error(`no loudness target for ${slot}`);
  const ids = s.candidates.map((c) => path.basename(c.file));
  if (s.default !== 'synth' && !ids.includes(s.default)) throw new Error(`${slot}: default ${s.default} is not a candidate`);
  lines.push(`  ${slot}: {`, `    default: '${s.default}',`, '    candidates: [');
  for (const c of s.candidates) {
    const r = results.get(c.file);
    if (!r) throw new Error(`${slot}: unknown file ${c.file}`);
    used.add(c.file);
    const spec = files[c.file];
    const level = loudnessDb(built.get(c.file)!, spec.rate, r.loop);
    const gain = 10 ** ((target - level) / 20);
    if (gain > 4 || gain < 0.02) console.warn(`! ${slot}/${c.file}: gain ${gain.toFixed(3)} (level ${level.toFixed(1)} dB, target ${target} dB)`);
    lines.push(
      '      {',
      `        id: '${path.basename(c.file)}',`,
      `        file: '${r.rel}',`,
      `        label: ${JSON.stringify(c.label)},`,
      `        source: '${spec.from.url}',`,
      `        author: ${JSON.stringify(spec.from.author)},`,
      `        duration: ${r.duration.toFixed(2)},`,
      `        gain: ${gain.toFixed(3)},`,
      ...(r.loop ? ['        loop: true,'] : []),
      '      },',
    );
  }
  lines.push('    ],', '  },');
}
for (const key of Object.keys(files)) if (!used.has(key)) console.warn(`! ${key} is built but no slot uses it`);

const manifest = `// Generated by scripts/sfx-build.ts: edit the lists there and re-run rather than editing this file.
// Every file is CC0 (see CREDITS.md). \`gain\` puts each sample at the K-weighted loudness of the synth
// version it replaces; \`default\` is the candidate the game plays unless this browser overrides it
// (localStorage "tank.sfxPicks", set from the sound lab), or "synth" for the generated version.
import type { SfxSlot } from './audio';

export interface SfxCandidate {
  /** Unique within its sound. */
  id: string;
  /** Path under public/ (served from the site root). */
  file: string;
  label: string;
  /** Page the original was downloaded from. */
  source: string;
  author: string;
  /** Seconds. */
  duration: number;
  /** Linear gain to apply when playing (before volume and pan). */
  gain: number;
  /** Seamless loop (ambience). */
  loop?: boolean;
}

export interface SfxEntry {
  /** A candidate id, or "synth". */
  default: string;
  candidates: SfxCandidate[];
}

export const SFX_MANIFEST: Record<SfxSlot, SfxEntry> = {
${lines.join('\n')}
};
`;
fs.writeFileSync(path.join(ROOT, 'packages/client/src/sfx-manifest.ts'), manifest);

// ------------------------------------------------------------------ credits

const rows = [...results.values()].map((r) => {
  const spec = files[r.key];
  const original = spec.src.split('/').pop();
  return `| \`packages/client/public/${r.rel}\` | [${spec.from.pack}](${spec.from.url}), \`${original}\` | ${spec.from.author} | CC0 1.0 | ${DOWNLOADED} | ${r.changes} |`;
});
const credits = `# Credits

## Sound effects

Every sample under \`packages/client/public/sfx/\` is dedicated to the public domain under
[Creative Commons Zero (CC0 1.0)](https://creativecommons.org/publicdomain/zero/1.0/). Attribution
isn't required, but thank you to the authors below, especially [Kenney](https://kenney.nl) for the
bulk of them.

The Kenney packs' own \`License.txt\` files state CC0; the OpenGameArt items are listed as CC0 on
their pages. Files were processed by \`scripts/sfx-build.ts\` (generated table: re-run it rather
than editing by hand). Sounds without a sample here are synthesized in code
(\`packages/client/src/audio.ts\`).

| File | Source | Author | License | Downloaded | Changes |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
fs.writeFileSync(path.join(ROOT, 'CREDITS.md'), credits);

const total = [...results.values()].reduce((s, r) => s + r.bytes, 0);
console.log(`\n${results.size} files, ${(total / 1024 / 1024).toFixed(2)} MB total`);
