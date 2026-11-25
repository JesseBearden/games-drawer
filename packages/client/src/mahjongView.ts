import './mahjong.css';
import { CARD_SOUNDS } from './audio';
import {
  mjClaimWhyNot,
  mjIndex,
  mjLostClaim,
  mjMissedClaim,
  mjMissedKong,
  mjSort,
  mjTileName,
  mjTurnWhyNot,
  WIND_LETTERS,
  WIND_NAMES,
  type GameServerMessage,
  type MahjongView,
  type MjClaim,
  type MjClaimKind,
  type MjLearnChoice,
  type MjMeld,
  type MjTile,
  type MjWhyNot,
} from '@tank/shared';
import { seatFelts } from './felts';
import { patchHtml, syncKeyed, type KeyedItem } from './dom';
import { escapeHtml, nameHtml } from './html';
import { fitScoreTable, fitSeatText, scoreSheetHtml, seatNameHtml, seatRows } from './heartsView';
import { tuckBars } from './tuckBars';
import type { ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The sprite sheet's cells (scripts/mahjong-tiles.cjs): 9 across, 5 down; the back is cell 42. */
const SHEET_COLS = 9;
const SHEET_ROWS = 5;
const BACK = 42;
/** The opening, as the server times it (games/mahjong.ts): the dice show, then the deal. */
const DICE_MS = 1800;
const DEAL_MS = 2200;
/** A finger has to move this far (px) before it drags a tile instead of tapping it. */
const DRAG_SLOP = 8;

type Overlay = null | 'scores' | 'discards' | { seat: number };

/** "5 dots", "East wind", "Red dragon", "Flower 2". */
export const tileName = mjTileName;

/** Where a tile's face is in the sprite sheet. */
function sprite(i: number) {
  return `--tx:${((i % SHEET_COLS) / (SHEET_COLS - 1)) * 100}%;--ty:${(Math.floor(i / SHEET_COLS) / (SHEET_ROWS - 1)) * 100}%`;
}

/** A tile face up (or, with null, face down). */
export function tileHtml(t: MjTile | null, cls = '', attrs = ''): string {
  const face = t !== null;
  return `<span class="mj-t${face ? '' : ' mj-back'}${cls ? ` ${cls}` : ''}" style="${sprite(face ? mjIndex(t) : BACK)}"${face ? ` role="img" aria-label="${tileName(t)}"` : ' aria-hidden="true"'}${attrs}></span>`;
}

/** A set laid down: a Kong is three with the fourth on top of the middle one; a concealed Kong shows its ends face down. */
export function setHtml(m: MjMeld, cls = ''): string {
  const t = m.tiles[0];
  const extra = cls ? ` ${cls}` : '';
  if (m.kind === 'kong') {
    const end = m.concealed ? null : t;
    return `<span class="mj-set mj-kong${extra}" role="img" aria-label="Kong of ${tileName(t)}">${tileHtml(end)}<span class="mj-stack">${tileHtml(t)}${tileHtml(t, 'mj-top')}</span>${tileHtml(end)}</span>`;
  }
  const label = m.kind === 'chow' ? `Chow ${m.tiles.map(tileName).join(', ')}` : `Pung of ${tileName(t)}`;
  return `<span class="mj-set${extra}" role="img" aria-label="${label}">${m.tiles.map((x) => tileHtml(x)).join('')}</span>`;
}

/** Each wall stack's height (0-2), 72 of them, 18 to a side starting at seat 0's. */
export function wallStacks(w: MahjongView['wall']): number[] {
  const s = new Array<number>(72).fill(2);
  let f = w.front;
  for (let k = 0; f > 0 && k < 72; k++) {
    const i = (w.breakAt + k) % 72;
    const take = Math.min(s[i], f);
    s[i] -= take;
    f -= take;
  }
  let b = w.back;
  for (let k = 1; b > 0 && k <= 72; k++) {
    const i = (w.breakAt - k + 144) % 72;
    const take = Math.min(s[i], b);
    s[i] -= take;
    b -= take;
  }
  return s;
}

/**
 * The deal, as at a real table: from the dealer round the table, each player takes four tiles,
 * three times over, then one each, and the dealer one more (13 each, 14 for the dealer). Step i
 * gives `n` tiles to `seat`.
 */
export const DEAL_STEPS = 17;
export function dealStep(i: number, dealer: number): { seat: number; n: number } {
  if (i < 12) return { seat: (dealer + i) % 4, n: 4 };
  if (i < 16) return { seat: (dealer + i - 12) % 4, n: 1 };
  return { seat: dealer, n: 1 };
}

/** After `done` steps of the deal: how many tiles each seat has, and how many left the wall. */
export function dealtSoFar(done: number, dealer: number): { seats: number[]; front: number } {
  const seats = [0, 0, 0, 0];
  let front = 0;
  for (let i = 0; i < Math.min(done, DEAL_STEPS); i++) {
    const s = dealStep(i, dealer);
    seats[s.seat] += s.n;
    front += s.n;
  }
  return { seats, front };
}

const DIE_PIPS: Record<number, [number, number][]> = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [3, 1], [1, 3], [3, 3]],
  5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
  6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]],
};

function dieSvg(n: number) {
  const pips = DIE_PIPS[n].map(([x, y]) => `<circle cx="${x * 10}" cy="${y * 10}" r="3.4"/>`).join('');
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="1.5" y="1.5" width="37" height="37" rx="8"/>${pips}</svg>`;
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Mahjong on the green table (the user's mockups, 2026-11-23). You sit at the bottom with your
 * tiles on a cream felt strip; play goes counter-clockwise, so the player after you is on your
 * right and the one before you (whose discards you can Chow) on your left. Everyone else's tiles
 * are small backs along their edge, with their face-up sets beside them on a strip of kraft felt
 * (tap them to see them big). Each player's recent discards lie in the middle, the newest lifted.
 * Tablets and computers also show the wall round them; phones show the tiles left.
 */
export class MahjongTable implements View {
  readonly landscape = false;
  readonly helpHtml =
    '<p>Make four sets and a pair before anyone else. A set is a <b>Pung</b> (three alike), a <b>Kong</b> (four alike) or a <b>Chow</b> (three in a row, one suit). Winds and dragons only make Pungs and Kongs.</p><p>On your turn you draw a tile (it says <b>New</b>), then tap the tile you want to throw away and tap <b>Discard</b> (or tap it twice).</p><p>When someone throws away a tile you can use, buttons appear: <b>Pung</b> or <b>Kong</b> from anyone, <b>Chow</b> only from the player on your left, and <b>Mahjong</b> when it finishes your hand. You have 15 seconds (a minute when you’re the only person at the table); <b>Pass</b> moves things along.</p><p><b>Learning Mode:</b> every tile thrown away asks what you’d do with it, with no timer. Choose something that can’t be done and it explains why, lighting up the tiles in your hand it’s about.</p><p>Every Pung, Chow and Kong also shows in <b>Messages</b>, so you can see what the others did.</p><p>Flowers and seasons are set aside and replaced. Drag your tiles to put them in any order. Tap anyone’s tiles to see their sets up close.</p><p><b>With points:</b> a hand needs at least 3 points (faan) to win. The end of each hand lists what it was worth and why.</p>';
  private el = $('mahjong-view');
  private view: MahjongView | null = null;
  /** Your concealed tiles in the order you see them (you can drag them about). */
  private order: MjTile[] = [];
  private orderHand = 0;
  private selected: string | null = null;
  /** When you picked the tile that's lifted: a second tap this soon is a double tap, not a discard. */
  private pickedAt = 0;
  /** The claim bar's length, from when the tile was first offered (it never restarts mid-way). */
  private timerMs = 0;
  private pending = false;
  private overlay: Overlay = null;
  /** After a hand (or the game): looking at the table instead of the result. */
  private peek = false;
  private readySent = false;
  private speaking = new Set<string>();
  private drag: { key: string; el: HTMLElement; x: number; y: number; id: number; moving: boolean } | null = null;
  private noClickUntil = 0;
  private observer = new ResizeObserver(() => this.layout());
  private timers: number[] = [];
  /** We asked the page to scroll so the browser's bars can tuck away (undone on leaving). */
  private untuck: () => void;
  /** A Pung, Chow or Kong just made (seat and which of their sets): it lifts for a moment. */
  private fresh: { seat: number; index: number } | null = null;
  /** The deal being shown: when it started, and how many steps of it are on screen. */
  private deal: { at: number; done: number; timer: number } | null = null;
  /**
   * Learning Mode, the tile on offer (which one, by offerKey): the choice explained (its tiles lit
   * in your hand), "are you sure" before passing on your winning tile, or picking between Chows.
   */
  private learn: { key: string; why: MjWhyNot | null; confirm: boolean; chows: boolean } | null = null;
  /** Learning Mode, your own turn: the tiles an explanation is about, and "are you sure" before throwing away a winning hand. */
  private turnHelp: MjTile[] = [];
  private turnConfirm = false;
  /** Learning Mode: a note for a few seconds over your tiles (a chance missed, why a choice can't be made). */
  private tip: string | null = null;
  private tipTimer = 0;
  /** What you asked for with the tile on offer, to explain it if someone else's claim came first. */
  private myClaim: { key: string; claim: MjClaimKind } | null = null;

  constructor(private shell: ShellApi) {
    this.el.hidden = false;
    this.el.innerHTML = `
      <div class="mj" data-layout="tall">
        <div class="mj-op mj-pos-2" data-seat-pos="2"></div>
        <div class="mj-op mj-pos-3" data-seat-pos="3"></div>
        <div class="mj-op mj-pos-1" data-seat-pos="1"></div>
        <div class="mj-mid">
          <div class="mj-wall" aria-hidden="true"><div class="mj-side mj-side-2"></div><div class="mj-side mj-side-3"></div><div class="mj-side mj-side-1"></div><div class="mj-side mj-side-0"></div></div>
          <div class="mj-ponds">
            <div class="mj-pond mj-pond-2"></div>
            <div class="mj-pond mj-pond-3"></div>
            <div class="mj-centre"></div>
            <div class="mj-pond mj-pond-1"></div>
            <div class="mj-pond mj-pond-0"></div>
          </div>
          <div class="mj-round"></div>
        </div>
        <div class="mj-mine">
          <div class="mj-head"><div class="ht-seat ht-pos-0"></div><span class="mj-myflowers"></span><p class="mj-status" aria-live="polite"></p><button class="pc-btn pc-btn-plain mj-scores-btn" type="button">Scores</button></div>
          <div class="mj-hand"></div>
          <div class="mj-actions"></div>
        </div>
        <div class="mj-learn" hidden></div>
        <p class="mj-tip" role="status" hidden></p>
        <div class="ht-overlay mj-overlay" hidden></div>
      </div>`;
    this.el.addEventListener('click', this.onClick);
    const hand = this.handEl();
    hand.addEventListener('pointerdown', this.onPointerDown);
    hand.addEventListener('pointermove', this.onPointerMove);
    hand.addEventListener('pointerup', this.onPointerUp);
    hand.addEventListener('pointercancel', this.onPointerUp);
    hand.addEventListener('lostpointercapture', this.onPointerUp);
    this.observer.observe(this.el);
    // (The middle's own size settles after the rest: the wall and discards follow it.)
    this.observer.observe(this.q('.mj-mid'));
    shell.sfx.preloadSounds(CARD_SOUNDS);
    // In a phone's browser held sideways, a swipe up on the table tucks the browser's bars away,
    // as in Tanks.
    this.untuck = tuckBars(shell.device.small);
  }

  private handEl() {
    return this.el.querySelector('.mj-hand') as HTMLElement;
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string) {
    return this.el.querySelector(sel) as T;
  }

  /** 0 you, 1 on your right (next to play), 2 across, 3 on your left (who plays before you). */
  private pos(seat: number) {
    return (seat - (this.view?.seat ?? 0) + 4) % 4;
  }

  private name(seat: number) {
    return this.view!.seats[seat].name;
  }

  private whose(seat: number) {
    return seat === this.view?.seat ? 'Your' : `${this.name(seat)}’s`;
  }

  onGameMessage(m: GameServerMessage) {
    if (m.t !== 'mahjong') return;
    const prev = this.view;
    const v = m.view;
    this.view = v;
    this.pending = false;
    this.readySent = false;
    if (!prev || prev.phase !== v.phase) this.peek = false;
    // A sheet left open closes when the hand ends or the next one starts (so the result shows,
    // and nothing covers the shuffle or the dealer's dice). One opened during the opening stays.
    if (prev && (prev.hand !== v.hand || (prev.phase !== v.phase && v.phase !== 'playing'))) this.overlay = null;
    this.reconcile(prev, v);
    this.sounds(prev, v);
    if (v.opening === 'deal' && prev && prev.opening !== 'deal') this.startDeal();
    else if (v.opening !== 'deal') this.stopDeal();
    // Where the discard on offer lay, before it moves into someone's set.
    const from = this.el.querySelector<HTMLElement>('.mj-pond .mj-latest')?.getBoundingClientRect() ?? null;
    const made = prev && prev.hand === v.hand && v.phase === 'playing' ? newSet(prev, v) : null;
    if (made) {
      this.fresh = made;
      window.clearTimeout(this.freshTimer);
      this.freshTimer = window.setTimeout(() => {
        this.fresh = null;
        this.renderOthers();
        this.renderMine();
      }, SHOW_CLAIM_MS);
    }
    // Learning Mode: you asked for the tile, and someone else's claim came first.
    if (made && made.seat !== v.seat && prev?.offer && this.myClaim?.key === offerKey(prev) && this.learning()) {
      this.showTip(mjLostClaim(this.myClaim.claim, this.name(made.seat), v.seats[made.seat].melds[made.index].kind));
    }
    if (!this.myTurnToDiscard()) {
      this.turnConfirm = false;
      this.turnHelp = [];
    }
    this.render(prev);
    if (made) this.showClaim(made, prev!.offer && !prev!.offer.kong ? from : null);
  }

  private learning() {
    return !!this.view?.rules.learning && this.view.seat !== null;
  }

  /** Learning Mode: a note over your tiles for a few seconds (tap it to close it sooner). */
  private showTip(text: string | null) {
    window.clearTimeout(this.tipTimer);
    this.tip = text;
    if (text) {
      this.tipTimer = window.setTimeout(() => {
        this.tip = null;
        this.turnHelp = [];
        this.renderTip();
        this.renderMine();
      }, TIP_MS);
    }
    this.renderTip();
  }

  private renderTip() {
    const el = this.q('.mj-tip');
    el.hidden = !this.tip;
    patchHtml(el, this.tip ? escapeHtml(this.tip) : '');
  }

  /**
   * Learning Mode (user, 2026-11-24): someone else's tile is on offer, and a card over the table
   * asks what you'd do with it: the tile big, Pung, Chow, Kong, Mahjong and Pass (all one size,
   * Pass in its own colour), what can't be done explained under them, and See all discards. It
   * leaves your tiles in view. There's no timer.
   */
  private renderLearn() {
    const v = this.view!;
    const box = this.q('.mj-learn');
    const offer = v.offer;
    const o = v.options;
    const show = this.learning() && v.phase === 'playing' && !!offer && !!o && !v.answered && this.overlay === null;
    box.hidden = !show;
    if (!show) {
      patchHtml(box, '');
      return;
    }
    const key = offerKey(v);
    if (this.learn?.key !== key) this.learn = { key, why: null, confirm: false, chows: false };
    const L = this.learn;
    const run = (lo: MjTile) => [0, 1, 2].map((k) => tileHtml(mjSortRun(lo)[k], 'mj-mini')).join('');
    let html = `<div class="ht-panel mj-learn-card" role="dialog" aria-label="What will you do with this tile?"><p class="mj-learn-who">${nameHtml(this.name(offer.seat))} ${offer.kong ? 'added to a Pung' : 'threw away'}</p>`;
    html += `${tileHtml(offer.tile, 'mj-learn-tile')}<p class="mj-learn-name">${tileName(offer.tile)}</p>`;
    if (L.confirm) {
      html += '<p class="mj-learn-why">Are you sure? This tile finishes your hand.</p><div class="mj-learn-btns mj-learn-two">';
      html += '<button class="pc-btn pc-btn-plain" data-learn="win" type="button"><span>Mahjong</span></button><button class="pc-btn pc-btn-main mj-learn-pass" data-learn="pass-anyway" type="button"><span>Pass anyway</span></button></div>';
    } else if (L.chows) {
      html += '<p class="mj-learn-why">Which Chow?</p><div class="mj-learn-btns mj-learn-two">';
      for (const lo of o.chows) html += `<button class="pc-btn pc-btn-plain mj-chow" data-claim="chow" data-chow="${lo}" type="button"><span class="mj-run">${run(lo)}</span></button>`;
      html += '<button class="pc-btn pc-btn-plain" data-learn="back" type="button"><span>Back</span></button></div>';
    } else {
      const b = (c: string, label: string, sub: string) => `<button class="pc-btn pc-btn-plain" data-learn="${c}" type="button"><span>${label}</span><small>${sub}</small></button>`;
      html += `<div class="mj-learn-btns">${b('pung', 'Pung', '3 of a kind')}${b('chow', 'Chow', 'Run')}${b('kong', 'Kong', '4 of a kind')}${b('win', 'Mahjong', '')}`;
      html += '<button class="pc-btn pc-btn-main mj-learn-pass" data-learn="pass" type="button"><span>Pass</span><small></small></button></div>';
      // (Its room is kept when there's nothing to say, so the card doesn't move when there is.)
      html += `<p class="mj-learn-why">${L.why ? escapeHtml(L.why.text) : ''}</p>`;
    }
    html += '<button class="pc-btn pc-btn-plain mj-learn-all" data-act="discards" type="button">See all discards</button></div>';
    patchHtml(box, html);
  }

  /** Learning Mode: a choice on the card. One that can't be made is explained; Pass on your winning tile asks first. */
  private onLearn(c: string) {
    const v = this.view!;
    const L = this.learn;
    const o = v.options;
    const offer = v.offer;
    if (!L || !o || !offer || v.seat === null || this.pending) return;
    if (c === 'back') {
      L.chows = false;
      return this.renderLearn();
    }
    if (c === 'pass' && o.win) {
      L.confirm = true;
      L.why = null;
      return this.renderLearn();
    }
    if (c === 'pass' || c === 'pass-anyway') {
      this.sendClaim({ t: 'pass' });
      this.showTip(mjMissedClaim(o, offer.tile, v.tiles));
      return;
    }
    const why = mjClaimWhyNot(c as MjLearnChoice, {
      tile: offer.tile,
      hand: v.tiles,
      addedKong: offer.kong,
      wallLeft: v.wall.left,
      seat: v.seat,
      from: offer.seat,
      names: v.seats.map((s) => s.name),
      options: o,
    });
    if (why) {
      L.why = why;
      L.confirm = false;
      this.renderLearn();
      return this.renderMine();
    }
    if (c === 'chow' && o.chows.length > 1) {
      L.chows = true;
      L.why = null;
      return this.renderLearn();
    }
    this.sendClaim(c === 'chow' ? { t: 'chow', chow: o.chows[0] } : { t: c as MjClaimKind });
  }

  private sendClaim(c: MjClaim) {
    const v = this.view!;
    this.pending = true;
    this.myClaim = { key: offerKey(v), claim: c.t };
    this.shell.sendGame(c.t === 'chow' ? { t: 'mj-claim', claim: 'chow', chow: c.chow! } : { t: 'mj-claim', claim: c.t });
  }

  /** Learning Mode, your own turn: Mahjong or Kong when it can't be done says why. */
  private onTurnLearn(c: 'win' | 'kong') {
    const v = this.view!;
    const me = v.seat !== null ? v.seats[v.seat] : null;
    if (!me || !v.self) return;
    const why = mjTurnWhyNot(c, { hand: v.tiles, melds: me.melds, self: v.self, drew: v.drawn !== null, wallLeft: v.wall.left });
    if (!why) return;
    this.turnHelp = why.help;
    this.showTip(why.text);
    this.renderMine();
  }

  /** Learning Mode: the tiles in your hand an explanation is about (lit up). */
  private helpTiles(): MjTile[] {
    const v = this.view;
    if (!v || !this.learning()) return [];
    if (this.learn && v.offer && this.learn.key === offerKey(v) && this.learn.why) return this.learn.why.help;
    return this.myTurnToDiscard() ? this.turnHelp : [];
  }

  private freshTimer = 0;

  /**
   * Someone made a Pung, Chow or Kong (user, 2026-11-23: make it obvious): the word pops up by
   * their name, the tile they took slides from the middle into their set, and the set lifts for
   * a moment (renderOthers and renderMine draw it with mj-fresh).
   */
  private showClaim(made: { seat: number; index: number }, from: DOMRect | null) {
    const v = this.view!;
    const meld = v.seats[made.seat].melds[made.index];
    const word = meld.kind === 'chow' ? 'Chow!' : meld.kind === 'pung' ? 'Pung!' : 'Kong!';
    const root = this.q('.mj');
    const box = root.getBoundingClientRect();
    const p = this.pos(made.seat);
    const tag = p === 0 ? this.q('.mj-head .ht-seat') : this.q(`.mj-pos-${p} .ht-seat`);
    const t = tag?.getBoundingClientRect();
    if (t) {
      const pop = document.createElement('div');
      pop.className = `mj-callout mj-callout-${p}`;
      pop.textContent = word;
      pop.setAttribute('aria-hidden', 'true');
      // Beside their tag, toward the middle of the table.
      const x = p === 3 ? t.right - box.left + 10 : p === 1 ? t.left - box.left - 10 : t.left - box.left + t.width / 2;
      const y = p === 2 ? t.bottom - box.top + 8 : p === 0 ? t.top - box.top - 8 : t.top - box.top + t.height / 2;
      pop.style.left = `${x}px`;
      pop.style.top = `${y}px`;
      root.append(pop);
      this.timers.push(window.setTimeout(() => pop.remove(), SHOW_CLAIM_MS - 200));
    }
    // The tile they took slides from where it lay into their set.
    if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const set = p === 0 ? this.el.querySelectorAll<HTMLElement>('.mj-strip .mj-set')[made.index] : this.el.querySelectorAll<HTMLElement>(`.mj-pos-${p} .mj-sets .mj-set`)[made.index];
    const taken = prevOffer(v, made) ?? meld.tiles[0];
    const dest = set ? [...set.querySelectorAll<HTMLElement>('.mj-t')].reverse().find((e) => e.getAttribute('aria-label') === tileName(taken)) : null;
    if (!dest) return;
    const to = dest.getBoundingClientRect();
    // Into a set lying sideways it lands sideways, turning on the way (it leaves the middle upright).
    const turned = !!dest.closest('.mj-turned');
    const turn = turned ? getComputedStyle(set!).getPropertyValue('--turn').trim() || '90deg' : '0deg';
    const fly = document.createElement('span');
    fly.className = turned ? 'mj-t mj-flying mj-sideways' : 'mj-t mj-flying';
    fly.setAttribute('style', `${sprite(mjIndex(taken))};--w:${turned ? to.height : to.width}px;--turn:${turn};left:${to.left - box.left}px;top:${to.top - box.top}px`);
    root.append(fly);
    dest.style.visibility = 'hidden';
    const s = from.width / (turned ? to.height : to.width);
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const anim = fly.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) rotate(calc(${turn} * -1)) scale(${s})`, transformOrigin: 'center' },
        { transform: 'none', transformOrigin: 'center' },
      ],
      { duration: 650, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1.05)' },
    );
    anim.onfinish = () => {
      fly.remove();
      dest.style.visibility = '';
    };
  }

  /** The tiles go out a handful at a time once the dice have been seen (the server allows DEAL_MS). */
  private startDeal() {
    this.stopDeal();
    const stepMs = (DEAL_MS - 300) / DEAL_STEPS;
    const at = performance.now() + DICE_MS;
    const deal = { at, done: 0, timer: 0 };
    deal.timer = window.setInterval(() => {
      if (performance.now() < at) return;
      const done = Math.min(DEAL_STEPS, Math.floor((performance.now() - at) / stepMs) + 1);
      if (done === deal.done) return;
      // A clack for each handful taken off the wall.
      this.shell.play('tileClack', { volume: 0.7 });
      deal.done = done;
      if (done >= DEAL_STEPS) window.clearInterval(deal.timer);
      this.renderOthers();
      this.renderMiddle();
      this.renderMine();
      this.layout();
    }, 40);
    this.deal = deal;
  }

  private stopDeal() {
    if (!this.deal) return;
    window.clearInterval(this.deal.timer);
    this.deal = null;
  }

  /** How many tiles a seat holds, or before the deal how many they will (the dealer 14). */
  private tilesOf(seat: number): number {
    const v = this.view!;
    const n = v.seats[seat].tiles;
    return v.phase === 'opening' && !n ? (seat === v.dealer ? 14 : 13) : n;
  }

  /** While the deal is on screen: what's been dealt so far (null when there's no deal to show). */
  private dealt(): { seats: number[]; front: number } | null {
    const v = this.view;
    if (!this.deal || !v || v.opening !== 'deal' || this.deal.done >= DEAL_STEPS) return null;
    return dealtSoFar(this.deal.done, v.dealer);
  }

  onSpeaking(aliases: Set<string>) {
    this.speaking = aliases;
    for (const el of this.el.querySelectorAll<HTMLElement>('.ht-seat[data-alias]')) el.classList.toggle('speaking', aliases.has(el.dataset.alias!));
  }

  resize() {
    this.layout();
  }

  // ------------------------------------------------------------------ your tiles

  /**
   * Keep the order you put your tiles in; a new hand starts sorted, and new tiles slot in by kind.
   * The order is kept for this tab too, so it's still yours after the phone locks or the page
   * reloads (the view is rebuilt then).
   */
  private reconcile(prev: MahjongView | null, v: MahjongView) {
    const tiles = [...v.tiles];
    if (v.drawn) tiles.splice(tiles.indexOf(v.drawn), 1);
    if (!prev) {
      const saved = this.savedOrder();
      if (saved && saved.hand === v.hand) {
        this.order = saved.order;
        this.orderHand = saved.hand;
      }
    }
    if (this.orderHand !== v.hand || !this.order.length) {
      this.order = mjSort(tiles);
      this.orderHand = v.hand;
      this.saveOrder();
      return;
    }
    const left = [...tiles];
    const kept: MjTile[] = [];
    for (const t of this.order) {
      const i = left.indexOf(t);
      if (i >= 0) {
        kept.push(t);
        left.splice(i, 1);
      }
    }
    for (const t of left) {
      const at = kept.findIndex((x) => mjIndex(x) > mjIndex(t));
      kept.splice(at < 0 ? kept.length : at, 0, t);
    }
    this.order = kept;
    this.saveOrder();
  }

  private orderKey() {
    return `mj-order:${this.shell.roomCode}`;
  }

  private savedOrder(): { hand: number; order: MjTile[] } | null {
    try {
      const s = JSON.parse(sessionStorage.getItem(this.orderKey()) ?? 'null') as unknown;
      if (s && typeof s === 'object' && 'hand' in s && 'order' in s && typeof s.hand === 'number' && Array.isArray(s.order) && s.order.every((t) => typeof t === 'string')) {
        return { hand: s.hand, order: s.order as MjTile[] };
      }
    } catch {
      // Storage blocked or garbled: start sorted.
    }
    return null;
  }

  private saveOrder() {
    try {
      sessionStorage.setItem(this.orderKey(), JSON.stringify({ hand: this.orderHand, order: this.order }));
    } catch {
      // Storage blocked (private browsing on an old iPhone): the order just won't survive a reload.
    }
  }

  /** Your concealed tiles in order, keyed so the same tile keeps its place on screen; the new one last. */
  private handTiles(): { key: string; tile: MjTile; isNew: boolean }[] {
    const seen = new Map<string, number>();
    const key = (t: MjTile) => {
      const n = (seen.get(t) ?? 0) + 1;
      seen.set(t, n);
      return `${t}#${n}`;
    };
    const out = this.order.map((t) => ({ key: key(t), tile: t, isNew: false }));
    const d = this.view?.drawn;
    if (d) out.push({ key: key(d), tile: d, isNew: true });
    return out;
  }

  private myTurnToDiscard() {
    const v = this.view;
    return !!v && v.phase === 'playing' && v.seat !== null && v.turn === v.seat && v.step === 'discard' && !!v.self;
  }

  // ------------------------------------------------------------------ rendering

  private render(prev: MahjongView | null = null) {
    const v = this.view;
    if (!v) return;
    const root = this.q('.mj');
    root.dataset.phase = v.phase;
    root.dataset.opening = v.opening ?? '';
    this.renderOthers();
    this.renderTags();
    this.renderMiddle();
    this.renderMine();
    this.renderOverlay();
    this.renderLearn();
    this.layout();
  }

  private renderTags() {
    const v = this.view!;
    const felts = seatFelts(v.seats);
    let changed = false;
    for (let seat = 0; seat < 4; seat++) {
      const s = v.seats[seat];
      const p = this.pos(seat);
      const el = p === 0 ? this.q('.mj-head .ht-seat') : this.q(`.mj-pos-${p}`).querySelector<HTMLElement>('.ht-seat');
      if (!el) continue;
      const wind = `<b class="mj-wind" title="${WIND_NAMES[s.wind]}${s.wind === 0 ? ', the dealer' : ''}">${WIND_LETTERS[s.wind]}</b>`;
      const you = p === 0 ? '<span class="mj-you">· You</span>' : '';
      changed = patchHtml(el, seatNameHtml(s.name, { bot: s.bot, away: s.away, after: you + wind })) || changed;
      el.dataset.felt = felts[seat];
      el.classList.toggle('turn', v.phase === 'playing' && v.turn === seat);
      el.classList.toggle('mj-dealer', s.wind === 0);
      if (s.alias) el.dataset.alias = s.alias;
      else delete el.dataset.alias;
      el.classList.toggle('speaking', !!s.alias && this.speaking.has(s.alias));
    }
    if (changed) fitSeatText(this.el);
  }

  /** Everyone else: their tag, their tiles face down, and their sets and flowers face up. */
  private renderOthers() {
    const v = this.view!;
    for (let p = 1; p < 4; p++) {
      const seat = ((v.seat ?? 0) + p) % 4;
      const s = v.seats[seat];
      const box = this.q(`.mj-pos-${p}`);
      if (!box.querySelector('.ht-seat')) box.innerHTML = `<div class="ht-seat ht-pos-${p}"></div><button class="mj-theirs" type="button" data-sets="${p}"><span class="mj-backs"></span><span class="mj-sets"></span></button>`;
      const btn = box.querySelector<HTMLElement>('.mj-theirs')!;
      btn.setAttribute('aria-label', `${s.name}: ${s.tiles} tile${s.tiles === 1 ? '' : 's'}${s.melds.length ? `, ${s.melds.length} set${s.melds.length === 1 ? '' : 's'} face up` : ''}. Show them bigger.`);
      const dealt = this.dealt();
      // Through the opening their whole hand's room is kept from the start (tiles not dealt yet
      // are there but unseen), so nothing on the table moves as the tiles arrive (user, 2026-11-24).
      const opening = v.phase === 'opening';
      const shown = dealt ? Math.min(s.tiles, dealt.seats[seat]) : opening && v.opening !== 'deal' ? 0 : s.tiles;
      patchHtml(btn.querySelector('.mj-backs')!, tileHtml(null).repeat(shown) + (opening ? tileHtml(null, 'mj-ghost').repeat(Math.max(0, this.tilesOf(seat) - shown)) : ''));
      const sets = dealt ? '' : s.melds.map((m, i) => setHtml(m, this.fresh?.seat === seat && this.fresh.index === i ? 'mj-fresh' : '')).join('') + (s.flowers.length ? `<span class="mj-set mj-flowers">${s.flowers.map((f) => tileHtml(f, 'mj-flower')).join('')}</span>` : '');
      patchHtml(btn.querySelector('.mj-sets')!, sets);
      btn.classList.toggle('has-sets', !!sets);
    }
  }

  private renderMiddle() {
    const v = this.view!;
    const offer = v.offer;
    for (let seat = 0; seat < 4; seat++) {
      const pond = this.q(`.mj-pond-${this.pos(seat)}`);
      const d = v.seats[seat].discards;
      const items: KeyedItem[] = d.map((t, i) => ({
        key: `${i}${t}`,
        className: `mj-t${offer && !offer.kong && offer.seat === seat && i === d.length - 1 ? ' mj-latest' : ''}`,
        style: sprite(mjIndex(t)),
        make: () => `<span role="img" aria-label="${tileName(t)}"></span>`,
      }));
      syncKeyed(pond, items);
    }
    // The wall: drawn on tablets and computers all hand; on phones only for the opening.
    // During the deal the wall opens a handful at a time.
    const dealt = this.dealt();
    const stacks = wallStacks(dealt ? { ...v.wall, front: dealt.front, back: 0 } : v.wall);
    for (let side = 0; side < 4; side++) {
      const p = this.pos(side);
      const el = this.q(`.mj-side-${p}`);
      let html = '';
      // The right-hand side runs up the screen: its stacks are drawn top first all the same, so
      // each one's lower edge tucks under the one below it, as down the left.
      const ks = Array.from({ length: 18 }, (_, k) => (p === 1 ? 17 - k : k));
      for (const k of ks) {
        const i = side * 18 + k;
        const n = stacks[i];
        // (--k: in the shuffle the wall is built a stack at a time along every side at once.)
        html += `<i class="mj-stack-${n}" style="--k:${k}"></i>`;
      }
      patchHtml(el, html);
    }
    // The middle of the middle: the opening, or See all discards and what's left.
    const c = this.q('.mj-centre');
    let html = '';
    if (v.phase === 'opening') {
      if (v.opening === 'shuffle') {
        // The tiles swirl round the table on three rings, each ring its own way at its own speed, so
        // they keep changing places. Tiles on a ring keep their spacing and the rings are a tile
        // and more apart, so none ever lands on another; each stays upright as it goes.
        const rings: [number, number, number, string][] = [
          [36, 5, 2.3, 'normal'],
          [78, 9, 3.1, 'reverse'],
          [120, 13, 3.9, 'normal'],
        ];
        const swirl = rings
          .map(([r, n, dur, dir]) =>
            Array.from({ length: n }, (_, i) => `<span class="mj-orbit" style="--r:${r}px;--a:${Math.round((360 / n) * i + r)}deg;--dur:${dur}s;--dir:${dir}"><span class="mj-t mj-back" style="${sprite(BACK)}"></span></span>`).join(''),
          )
          .join('');
        html = `<div class="mj-wash">${swirl}</div><p class="mj-note">Shuffling the tiles…</p>`;
      } else {
        html = `<div class="mj-dice${v.dice ? ' rolled' : ''}">${(v.dice ?? [6, 6, 6]).map((n) => `<span class="mj-die">${dieSvg(n)}</span>`).join('')}</div>`;
        html += `<p class="mj-note">${v.dice ? `${v.dice.join(' + ')} = ${v.dice.reduce((a, b) => a + b, 0)}` : v.dealer === v.seat ? 'You deal: roll the dice' : `${nameHtml(this.name(v.dealer))} rolls the dice`}</p>`;
      }
    } else {
      // (On a phone held sideways your strip is one row: Scores and the line saying what's
      // happening come here instead, mahjong.css.)
      html = `<button class="pc-btn pc-btn-plain mj-all" type="button" data-act="discards">See all discards</button><button class="pc-btn pc-btn-plain mj-scores-btn mj-scores-mid" type="button">Scores</button><p class="mj-note mj-left">${v.wall.left} tiles left</p><p class="mj-note mj-mid-status" aria-hidden="true">${this.statusText()}</p>`;
    }
    patchHtml(c, html);
    patchHtml(this.q('.mj-round'), `${WIND_NAMES[v.prevailing]} round`);
  }

  private renderMine() {
    const v = this.view!;
    const me = v.seat !== null ? v.seats[v.seat] : null;
    const myTurn = this.myTurnToDiscard();
    // Your sets (and flowers) at the front, on their kraft strip; then your tiles.
    const hand = this.handEl();
    hand.classList.toggle('my-turn', myTurn);
    let strip = hand.querySelector<HTMLElement>('.mj-strip');
    let row = hand.querySelector<HTMLElement>('.mj-row');
    if (!strip || !row) {
      hand.innerHTML = '<span class="mj-strip"></span><span class="mj-row"></span>';
      strip = hand.querySelector<HTMLElement>('.mj-strip')!;
      row = hand.querySelector<HTMLElement>('.mj-row')!;
    }
    // (Your flowers sit by your name, leaving the strip's room for tiles.)
    const dealt = this.dealt();
    const sets = me && !dealt ? me.melds.map((m, i) => setHtml(m, this.fresh?.seat === v.seat && this.fresh.index === i ? 'mj-fresh' : '')).join('') : '';
    patchHtml(this.q('.mj-myflowers'), me && !dealt ? me.flowers.map((f) => tileHtml(f)).join('') : '');
    patchHtml(strip, sets);
    strip.hidden = !sets;
    // During the deal your tiles arrive a handful at a time.
    const all = this.handTiles();
    const items = dealt ? all.slice(0, Math.min(all.length, dealt.seats[v.seat ?? 0])) : all;
    if (this.selected && !items.some((x) => x.key === this.selected)) this.selected = null;
    const help = [...this.helpTiles()];
    const lit = new Set<string>();
    for (const x of items) {
      const i = help.indexOf(x.tile);
      if (i >= 0) {
        lit.add(x.key);
        help.splice(i, 1);
      }
    }
    // While you drag a tile, the row stays as it is (redrawing it would drop the tile you're
    // holding); letting go draws it again with anything that came in meanwhile.
    if (!this.drag?.moving) syncKeyed(
      row,
      items.map((x) => ({
        key: x.key,
        className: `mj-t mj-h${x.isNew ? ' mj-new' : ''}${this.selected === x.key ? ' raised' : ''}${lit.has(x.key) ? ' mj-help' : ''}`,
        style: sprite(mjIndex(x.tile)),
        make: () => `<button type="button" data-key="${x.key}" aria-label="${tileName(x.tile)}${x.isNew ? ' (new)' : ''}"></button>`,
      })),
    );
    // Tiles dealt to you drop in as they arrive; a tile drawn later just appears.
    row.classList.toggle('dealing', !!this.deal && v.opening === 'deal');
    patchHtml(this.q('.mj-status'), this.statusText());
    const midStatus = this.el.querySelector<HTMLElement>('.mj-mid-status');
    if (midStatus) patchHtml(midStatus, this.statusText());
    this.renderActions();
  }

  private statusText(): string {
    const v = this.view!;
    if (v.seat === null) return 'Watching. You’ll get a seat when one frees up.';
    if (v.phase === 'opening') return v.opening === 'shuffle' ? 'Shuffling…' : v.opening === 'dice' ? (v.dealer === v.seat ? 'Your deal' : `${nameHtml(this.name(v.dealer))} deals`) : 'Dealing…';
    if (v.phase !== 'playing') return v.phase === 'gameOver' ? 'Game over' : `Hand ${v.hand} is over`;
    // (In Learning Mode the card over the table says it.)
    if (v.options && v.offer && this.learning()) return '';
    if (v.options && v.offer) return `${nameHtml(this.name(v.offer.seat))} ${v.offer.kong ? 'added' : 'threw away'} ${tileHtml(v.offer.tile, 'mj-said')}${v.offer.kong ? ' to a Pung' : ''}`;
    if (v.answered) return 'Waiting for the others…';
    // Only news: whose turn it is shows on the name tags in yellow (user, 2026-11-23).
    if (this.myTurnToDiscard() && v.self?.win) return 'You can go Mahjong!';
    return '';
  }

  /** The buttons under your tiles: Discard, Mahjong and Kongs on your turn; the claims when a tile's on offer; the dice. */
  private renderActions() {
    const v = this.view!;
    const box = this.q('.mj-actions');
    // (A new offer restarts the timer: keyed by what's on offer.)
    const key = v.options && v.offer ? `${v.offer.seat}${v.offer.tile}${v.log.length}` : '';
    let html = '';
    if (v.phase === 'opening' && v.opening === 'dice' && v.dealer === v.seat && !v.dice) {
      html = '<button class="pc-btn pc-btn-main pc-btn-big" data-act="roll" type="button">Roll the dice</button>';
    } else if (v.options && v.offer && this.learning()) {
      // (The card over the table asks.)
    } else if (v.options && v.offer) {
      const o = v.options;
      html = '<span class="mj-claims">';
      if (o.win) html += '<button class="pc-btn pc-btn-main" data-claim="win" type="button">Mahjong</button>';
      if (o.kong) html += `<button class="pc-btn ${o.win ? 'pc-btn-plain' : 'pc-btn-main'}" data-claim="kong" type="button">Kong</button>`;
      if (o.pung) html += `<button class="pc-btn ${o.win || o.kong ? 'pc-btn-plain' : 'pc-btn-main'}" data-claim="pung" type="button">Pung</button>`;
      const lead = !o.win && !o.kong && !o.pung && o.chows.length === 1;
      for (const lo of o.chows) {
        const run = [0, 1, 2].map((k) => tileHtml(mjSortRun(lo)[k], 'mj-mini')).join('');
        html += `<button class="pc-btn ${lead ? 'pc-btn-main' : 'pc-btn-plain'} mj-chow" data-claim="chow" data-chow="${lo}" type="button">Chow${o.chows.length > 1 ? `<span class="mj-run">${run}</span>` : ''}</button>`;
      }
      html += '<button class="pc-btn pc-btn-plain" data-claim="pass" type="button">Pass</button></span>';
      // How long is left: a bar that runs down. Its length is set once, when the tile is first
      // offered: later updates (someone else passing) carry less time left, and giving the
      // running bar that shorter length would make it jump ahead.
      if (box.dataset.offer !== key) this.timerMs = v.claimMs ?? 0;
      html += `<i class="mj-timer" style="--ms:${this.timerMs}ms"></i>`;
    } else if (this.myTurnToDiscard() && this.turnConfirm) {
      // Learning Mode: about to throw away a hand that's finished (the question is in the note
      // over your tiles, so the buttons keep their room).
      html += '<span class="mj-extra"><button class="pc-btn pc-btn-main" data-act="win" type="button">Mahjong</button></span>';
      html += `<button class="pc-btn pc-btn-plain pc-btn-big mj-discard" data-act="discard-anyway" type="button"${this.selected && !this.pending ? '' : ' disabled'}>Throw it away</button>`;
    } else if (this.myTurnToDiscard()) {
      const s = v.self!;
      // Mahjong and Kong side by side, Discard big (user, 2026-11-24: they're seldom used, and
      // your strip stays the same size on your turn). Learning Mode: Mahjong and Kong are always
      // there; one that can't be done says why.
      const learning = this.learning();
      let extra = '';
      if (s.win) extra += '<button class="pc-btn pc-btn-main" data-act="win" type="button">Mahjong</button>';
      else if (learning) extra += '<button class="pc-btn pc-btn-plain" data-turn-learn="win" type="button">Mahjong</button>';
      for (const k of s.kongs) extra += `<button class="pc-btn pc-btn-plain" data-kong="${k}" type="button">Kong ${tileHtml(k, 'mj-mini')}</button>`;
      if (learning && !s.kongs.length) extra += '<button class="pc-btn pc-btn-plain" data-turn-learn="kong" type="button">Kong</button>';
      if (extra) html += `<span class="mj-extra">${extra}</span>`;
      html += `<button class="pc-btn ${s.win ? 'pc-btn-plain' : 'pc-btn-main'} pc-btn-big mj-discard" data-act="discard" type="button"${this.selected && !this.pending ? '' : ' disabled'}>Discard</button>`;
    }
    if (box.dataset.offer !== key) {
      box.dataset.offer = key;
      box.innerHTML = '';
    }
    patchHtml(box, html);
    box.classList.toggle('mj-offering', !!v.options);
  }

  /** Sizes that depend on the room the table has. */
  private layout() {
    const v = this.view;
    const root = this.q('.mj');
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    const roomy = w >= 720 && h >= 560;
    const wide = !roomy && w > h;
    root.dataset.layout = roomy ? 'roomy' : wide ? 'wide' : 'tall';
    const me = v?.seat != null ? v.seats[v.seat] : null;
    // Your tiles: two rows of 7 upright on a phone, otherwise one row (sets at the front).
    const setSlots = me ? me.melds.length * 3 * 0.72 + (me.melds.length ? 0.6 : 0) : 0;
    const slots = this.handTiles().length + setSlots + 0.6;
    // (One row: as wide as the room beside the buttons, which keep a fixed width so the tiles
    // don't jump when the claim buttons come and go.)
    // (Less the 3 px between tiles and between sets: always room for 14, so the size doesn't
    // change as the deal begins or as you draw and throw away.)
    const handW = this.handEl().clientWidth - 3 * Math.max(14, this.handTiles().length + (me?.melds.length ?? 0) * 3) - 8;
    let hw: number;
    if (roomy) hw = Math.min(62, handW / Math.max(slots, 14.6));
    else if (wide) hw = Math.min(52, handW / Math.max(slots, 14.6), h * 0.135);
    else {
      // Two rows of 7 across your strip's own width (less its padding and the 3 px gaps), with
      // room in the second row for the gap before a new tile (a third of a tile).
      const mine = this.q('.mj-mine');
      const cs = getComputedStyle(mine);
      const inner = mine.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      hw = Math.min(60, (inner - 18 - 4) / 7.4, h * 0.08);
    }
    let hwPx = Math.max(24, Math.floor(hw));
    root.style.setProperty('--hw', `${hwPx}px`);
    // Upright, your face-up sets stay on one row whatever you have, four Kongs too: the sets get
    // smaller (your own tiles don't) once they'd be wider than the row. A set's tiles are --set-w
    // wide with about a third of one between sets, and the strip has 10 px of padding.
    const hand = this.handEl();
    const sets = me?.melds.length ?? 0;
    if (!roomy && !wide && sets) {
      const room = hand.clientWidth - 10 - (sets - 1) * 2;
      const setW = Math.min(hwPx * 0.72, room / (sets * 3 + (sets - 1) * 0.3));
      hand.style.setProperty('--set-w', `${Math.floor(setW)}px`);
    } else hand.style.removeProperty('--set-w');
    // Upright, your tiles never run onto a third row (face-up sets at the front, a new tile's
    // gap): rather, they shrink a little until two rows hold them (user, 2026-11-23).
    if (!roomy && !wide) {
      // Rows by where things sit (offsetTop isn't moved by a lifted tile). A set's kraft strip and
      // the tiles beside it end a few px apart (the tiles' blue sliver), so anything within half a
      // tile's height is one row.
      const rows = () => {
        const tops = [...this.handEl().querySelectorAll<HTMLElement>('.mj-strip:not([hidden]), .mj-h')].map((e) => e.offsetTop + e.offsetHeight).sort((x, y) => x - y);
        return tops.filter((b, i) => i === 0 || b - tops[i - 1] > hwPx / 2).length;
      };
      while (hwPx > 24 && rows() > 2) root.style.setProperty('--hw', `${--hwPx}px`);
    }
    // Everyone else's tiles, the discards and the wall scale with the table.
    const short = Math.min(w, h);
    const mid = this.q('.mj-mid');
    // Sideways on a phone the mic and caret tabs sit in the top corners: the side players keep to
    // the lower part of their edge, clear of them.
    // (Otherwise the side players run the whole height of their edge, beside the top player too.)
    const sideLen = wide ? mid.clientHeight - 14 : mid.clientHeight + this.q('.mj-pos-2').offsetHeight + 6 - 8;
    if (wide) root.style.setProperty('--side-len', `${Math.max(60, sideLen)}px`);
    else root.style.removeProperty('--side-len');
    // Everyone else's tiles are one size, the side players' no thinner than the top's (user,
    // 2026-11-23): as big as the player across has room for. Up each side their tiles lie in one
    // column, or two when one won't fit (smaller still only if two won't). Their sets go under
    // their tiles, or beside them on a phone held sideways.
    // (Through the opening, sized for the hands about to be dealt: nothing moves as they arrive.)
    const acrossSeat = ((v?.seat ?? 0) + 2) % 4;
    const across = v ? v.seats[acrossSeat] : null;
    const acrossNeed = across ? this.tilesOf(acrossSeat) + across.melds.length * 3.3 + across.flowers.length + 1 : 15;
    let bw = Math.min(roomy ? 22 : 16, (w * (wide ? 0.42 : 0.62)) / acrossNeed);
    const sideSeat = (p: number) => ((v?.seat ?? 0) + p) % 4;
    const sides = v ? [1, 3].map((p) => ({ p, s: v.seats[sideSeat(p)], n: this.tilesOf(sideSeat(p)) })) : [];
    const setRows = (s: MahjongView['seats'][number]) => (s.melds.length + (s.flowers.length ? 1 : 0)) * 1.7;
    for (const { s, n } of sides) {
      bw = Math.min(bw, sideLen / (Math.ceil(n / 2) * 1.06 + (wide ? 0 : setRows(s)) + 0.5));
      if (wide) bw = Math.min(bw, sideLen / (setRows(s) + 0.5));
    }
    const bwPx = Math.max(7, Math.floor(bw));
    root.style.setProperty('--bw', `${bwPx}px`);
    for (const { p, s, n } of sides) {
      // Their face-up sets lie sideways like their tiles when that fits (user, 2026-11-24): under
      // their tiles leaving them one column or two, or (sideways on a phone) beside them in the
      // height there is. Otherwise the sets lie upright in rows, which take less of the column.
      const setsEl = this.q(`.mj-pos-${p} .mj-sets`);
      const half = Math.ceil(n / 2);
      let rows = 0;
      let turned = false;
      if (setsEl && (s.melds.length || s.flowers.length)) {
        setsEl.classList.add('mj-turned');
        const setsH = setsEl.offsetHeight;
        rows = Math.min(n, Math.floor((sideLen - (wide ? 0 : setsH + 6)) / (bwPx * 1.06)));
        turned = wide ? setsH <= sideLen : rows >= half;
      }
      setsEl?.classList.toggle('mj-turned', turned);
      if (!turned) rows = Math.min(n, Math.floor((sideLen - (wide ? 0 : setRows(s) * bwPx)) / (bwPx * 1.06)));
      this.q(`.mj-pos-${p} .mj-backs`)?.style.setProperty('--rows', String(Math.max(1, rows, half)));
    }
    // (Sideways the middle also holds Scores and the line saying what's happening.)
    if (wide) root.style.setProperty('--dw', `${Math.max(14, Math.min(24, Math.floor((mid.clientHeight - 80) / 3.3)))}px`);
    else if (!roomy) root.style.setProperty('--dw', `${Math.max(18, Math.min(26, Math.floor(short / 15)))}px`);
    // The wall is four sides of 18 stacks, each sticking out past the next (a pinwheel, like a
    // real table: user, 2026-11-23): 21 stacks across. On tablets and computers
    // every discard lies inside it, smaller than the one on offer.
    const ws = Math.floor((Math.min(mid.clientWidth, mid.clientHeight) * 0.97) / 21);
    const wsFit = Math.max(6, Math.min(roomy ? 30 : 16, ws));
    // The shuffle's swirl is 280 px across: as big as the middle allows.
    root.style.setProperty('--wash-s', String(Math.max(0.4, Math.min(1.15, (Math.min(mid.clientWidth, mid.clientHeight) - 40) / 280))));
    root.style.setProperty('--ws', `${wsFit}px`);
    if (roomy) {
      // Inside the wall: a column of 5 up each side (the full height), and between them a row of
      // 5 top and bottom with See all discards (about 90 px tall, 160 wide) in the middle.
      const inner = wsFit * 15 - 24;
      const dw = Math.min(36, (inner - 15) / 7.75, (inner - 100) / 3.3, (inner - 30) / 7.1, (inner - 172) / 2.1);
      root.style.setProperty('--dw', `${Math.max(16, Math.floor(dw))}px`);
    }
    fitSeatText(this.el);
  }

  // ------------------------------------------------------------------ the sheets over the table

  private renderOverlay() {
    const v = this.view!;
    const box = this.q('.mj-overlay');
    const ended = v.phase === 'handEnd' || v.phase === 'gameOver';
    // After a hand the result shows, unless you've gone to look at the table; a sheet opened from
    // the table (all discards, someone's sets) shows over it, and closing it goes back there.
    const show = this.overlay !== null || (ended && !this.peek);
    box.hidden = !show;
    if (!show) return;
    let html = '<div class="ht-panel pc-sheet mj-panel">';
    if (this.overlay === null) html += this.resultHtml();
    else if (this.overlay === 'scores') html += `<h2>Scores</h2>${this.sheetHtml(false)}<div class="actions"><button class="pc-btn pc-btn-main" data-act="close" type="button">Close</button></div>`;
    else if (this.overlay === 'discards') html += this.discardsHtml();
    else if (this.overlay && typeof this.overlay === 'object') html += this.setsHtml(this.overlay.seat);
    html += '</div>';
    patchHtml(box, html);
    fitScoreTable(box);
  }

  private sheetHtml(fresh: boolean) {
    const v = this.view!;
    const rows = seatRows(v.seats, v.history, v.seat);
    return `${scoreSheetHtml(rows, fresh)}<p class="pc-small">${v.rules.points ? `Points: ${v.rounds === 16 ? 'a full game, four rounds' : 'one round'}.` : 'Hands won.'}</p>`;
  }

  private resultHtml(): string {
    const v = this.view!;
    const r = v.result;
    let html = '';
    if (v.phase === 'gameOver') {
      const youWon = v.seat !== null && v.winners.includes(v.seat);
      html += `<h2>${youWon ? 'You win!' : `${joinNames(v.winners.map((i) => nameHtml(this.name(i))))} ${v.winners.length > 1 ? 'win' : 'wins'}!`}</h2>`;
    }
    if (r) {
      if (r.winner === null) html += `${v.phase === 'gameOver' ? '<h3>' : '<h2>'}Nobody won this hand${v.phase === 'gameOver' ? '</h3>' : '</h2>'}<p class="mj-how">The wall ran out.</p>`;
      else {
        const who = r.winner === v.seat ? 'You' : nameHtml(this.name(r.winner));
        const tag = v.phase === 'gameOver' ? 'h3' : 'h2';
        html += `<${tag}>${who} went Mahjong!</${tag}>`;
        const how = r.selfDrawn ? 'On a tile drawn from the wall.' : r.robbed ? `Robbing ${nameHtml(this.name(r.from!))}’s Kong.` : `On ${r.from === v.seat ? 'your' : `${nameHtml(this.name(r.from!))}’s`} discard.`;
        html += `<p class="mj-how">${how}</p>`;
        const s = v.seats[r.winner];
        const tiles = [...r.hands[r.winner]];
        const at = r.tile ? tiles.lastIndexOf(r.tile) : -1;
        html += `<div class="mj-shown">${s.melds.map((m) => setHtml(m)).join('')}<span class="mj-set">${tiles.map((t, i) => tileHtml(t, i === at ? 'mj-winning' : '')).join('')}</span>${s.flowers.map((f) => tileHtml(f, 'mj-flower')).join('')}</div>`;
        if (r.score) {
          html += '<table class="mj-faan"><tbody>';
          // (Over the limit takes points off: a real minus sign.)
          for (const it of r.score.items) html += `<tr><th scope="row">${escapeHtml(it.name)}<small>${escapeHtml(it.why)}</small></th><td>${it.faan < 0 ? `−${-it.faan}` : it.faan}</td></tr>`;
          html += `</tbody><tfoot><tr><th scope="row">${r.score.limit ? 'Limit hand' : 'Total'}</th><td>${r.score.faan} faan</td></tr></tfoot></table>`;
          const won = r.pay[r.winner];
          const paid = r.selfDrawn ? `Everyone else pays ${won / 3}.` : `${r.from === v.seat ? 'You pay' : `${nameHtml(this.name(r.from!))} pays`} ${won}.`;
          html += `<p class="mj-how">${r.winner === v.seat ? 'You win' : `${nameHtml(this.name(r.winner))} wins`} ${won} points. ${paid}</p>`;
        }
      }
    }
    html += this.sheetHtml(true);
    if (v.phase === 'handEnd') {
      const wait = this.waitText();
      if (wait) html += `<p class="mj-wait">${wait}</p>`;
    }
    html += '<div class="actions">';
    if (v.phase === 'gameOver') {
      if (v.seat !== null) html += '<button class="pc-btn pc-btn-main" data-act="again" type="button">New game</button>';
      html += '<button class="pc-btn pc-btn-plain" data-act="peek" type="button">See the table</button>';
      html += '<button class="pc-btn pc-btn-plain" data-act="lobby" type="button">Switch game</button>';
    } else {
      if (v.seat !== null && !v.ready.includes(v.seat)) html += `<button class="pc-btn pc-btn-main" data-act="ready" type="button"${this.readySent ? ' disabled' : ''}>Ready for hand ${v.hand + 1}</button>`;
      html += '<button class="pc-btn pc-btn-plain" data-act="peek" type="button">See the table</button>';
    }
    return html + '</div>';
  }

  /** Every discard this hand, one row each (you first, then in turn order); taken ones are marked. */
  private discardsHtml(): string {
    const v = this.view!;
    let html = '<h2>All discards</h2>';
    const first = v.seat ?? 0;
    for (let k = 0; k < 4; k++) {
      const seat = (first + k) % 4;
      const mine = v.log.filter((d) => d.seat === seat);
      html += `<section class="mj-hist"><h3>${seat === v.seat ? 'You' : nameHtml(this.name(seat))}</h3><div>${mine.length ? mine.map((d) => tileHtml(d.tile, d.taken ? 'mj-taken' : '', d.taken ? ' title="Taken for a set"' : '')).join('') : '<span class="pc-small">Nothing yet</span>'}</div></section>`;
    }
    html += '<p class="pc-small">Faded tiles were taken for someone’s set.</p>';
    return html + '<div class="actions"><button class="pc-btn pc-btn-main" data-act="close" type="button">Close</button></div>';
  }

  /** One player's face-up sets and flowers, big. */
  private setsHtml(seat: number): string {
    const v = this.view!;
    const s = v.seats[seat];
    let html = `<h2>${nameHtml(s.name)}</h2><p class="mj-how">${WIND_NAMES[s.wind]} seat${s.wind === 0 ? ', the dealer' : ''} · ${s.tiles} tile${s.tiles === 1 ? '' : 's'} in hand</p>`;
    html += `<div class="mj-shown">${s.melds.length ? s.melds.map((m) => setHtml(m)).join('') : '<span class="pc-small">No sets face up yet.</span>'}</div>`;
    if (s.flowers.length) html += `<h3>Flowers and seasons</h3><div class="mj-shown">${s.flowers.map((f) => tileHtml(f)).join('')}</div>`;
    return html + '<div class="actions"><button class="pc-btn pc-btn-main" data-act="close" type="button">Close</button></div>';
  }

  private waitingFor(): number[] {
    const v = this.view!;
    return v.seats.flatMap((s, i) => (!s.bot && !s.away && !v.ready.includes(i) ? [i] : []));
  }

  private waitText(): string {
    const v = this.view!;
    const waiting = this.waitingFor();
    const mine = v.seat !== null && waiting.includes(v.seat);
    const others = waiting.filter((i) => i !== v.seat).map((i) => nameHtml(this.name(i)));
    if (!mine) return others.length ? `Waiting for ${joinNames(others)}…` : '';
    if (!others.length) return 'Everyone else is ready.';
    return '';
  }

  private sounds(prev: MahjongView | null, v: MahjongView) {
    const play = (name: string, delay = 0) => this.shell.play(name, delay ? { delay } : undefined);
    // The tiles clatter while they're shuffled (the game's very first hand too).
    if (v.opening === 'shuffle' && prev?.opening !== 'shuffle') play('tileShuffle');
    if (!prev) return;
    const total = (x: MahjongView) => x.log.length;
    if (total(v) > total(prev) && v.hand === prev.hand) play('tileClack');
    const sets = (x: MahjongView) => x.seats.reduce((n, s) => n + s.melds.length, 0);
    if (sets(v) > sets(prev) && v.hand === prev.hand) {
      play('tileClack');
      play('tileClack', 0.09);
      play('tileClack', 0.18);
    }
    if (prev.turn !== v.seat && v.turn === v.seat && v.seat !== null && v.phase === 'playing') play('yourTurn');
    if (!prev.options && v.options) play('yourTurn');
    if (prev.phase !== v.phase && (v.phase === 'handEnd' || v.phase === 'gameOver')) play(v.result?.winner === v.seat && v.seat !== null ? 'win' : 'handEnd');
  }

  // ------------------------------------------------------------------ input

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const v = this.view;
    if (!v) return;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act) return this.act(act);
    const learn = t.closest<HTMLElement>('[data-learn]')?.dataset.learn;
    if (learn) return this.onLearn(learn);
    const turnLearn = t.closest<HTMLElement>('[data-turn-learn]')?.dataset.turnLearn;
    if (turnLearn === 'win' || turnLearn === 'kong') return this.onTurnLearn(turnLearn);
    if (t.closest('.mj-tip')) return this.showTip(null);
    const claim = t.closest<HTMLElement>('[data-claim]');
    if (claim && v.options && !this.pending) {
      const c = claim.dataset.claim as 'win' | 'kong' | 'pung' | 'chow' | 'pass';
      this.sendClaim(c === 'chow' ? { t: 'chow', chow: claim.dataset.chow! } : { t: c });
      return;
    }
    const kong = t.closest<HTMLElement>('[data-kong]')?.dataset.kong;
    if (kong && !this.pending) {
      this.pending = true;
      this.shell.sendGame({ t: 'mj-kong', tile: kong });
      return;
    }
    const sets = t.closest<HTMLElement>('[data-sets]')?.dataset.sets;
    if (sets) {
      this.overlay = { seat: ((v.seat ?? 0) + Number(sets)) % 4 };
      this.renderOverlay();
      this.renderLearn();
      return;
    }
    if (t.closest('.mj-scores-btn')) {
      if (v.phase === 'handEnd' || v.phase === 'gameOver') this.peek = !this.peek;
      else this.overlay = this.overlay === 'scores' ? null : 'scores';
      this.render();
      return;
    }
    if (performance.now() < this.noClickUntil) return;
    const key = t.closest<HTMLElement>('.mj-h')?.dataset.key;
    if (key) this.tapTile(key);
  };

  private act(act: string) {
    const v = this.view!;
    if (act === 'roll') return this.shell.sendGame({ t: 'mj-roll' });
    if (act === 'discard') return this.discardSelected();
    if (act === 'discard-anyway') return this.discardSelected(true);
    if (act === 'win' && !this.pending) {
      this.pending = true;
      return this.shell.sendGame({ t: 'mj-win' });
    }
    if (act === 'discards') {
      this.overlay = 'discards';
      this.renderOverlay();
      return this.renderLearn();
    }
    if (act === 'close') {
      this.overlay = null;
      this.renderOverlay();
      return this.renderLearn();
    }
    if (act === 'peek') {
      this.peek = true;
      return this.render();
    }
    if (act === 'again') return this.shell.sendGame({ t: 'again' });
    if (act === 'lobby') return this.shell.toLobby();
    if (act === 'ready' && !this.readySent && v.phase === 'handEnd') {
      this.readySent = true;
      this.shell.sendGame({ t: 'ready' });
      this.renderOverlay();
    }
  }

  /**
   * Tap a tile to pick it; on your turn, tap it again (or Discard) to throw it away. A second tap
   * within half a second is a double tap out of habit, so it does nothing (user, 2026-11-24: his
   * wife threw a tile away like that).
   */
  private tapTile(key: string) {
    if (this.selected === key && performance.now() - this.pickedAt < DOUBLE_TAP_MS) return;
    if (this.selected === key && this.myTurnToDiscard()) return this.discardSelected();
    this.selected = this.selected === key ? null : key;
    this.pickedAt = performance.now();
    this.renderMine();
  }

  /** Throw away the lifted tile. In Learning Mode, a hand that's finished asks first (sure: true skips that). */
  private discardSelected(sure = false) {
    if (!this.selected || this.pending || !this.myTurnToDiscard()) return;
    const item = this.handTiles().find((x) => x.key === this.selected);
    if (!item) return;
    const v = this.view!;
    if (this.learning() && v.self?.win && !sure) {
      this.turnConfirm = true;
      this.showTip('Are you sure? Your tiles make a finished hand.');
      return this.renderActions();
    }
    // Learning Mode: a Kong you could have made first.
    const me = v.seat !== null ? v.seats[v.seat] : null;
    if (this.learning() && me && v.self?.kongs.length) this.showTip(mjMissedKong(v.self.kongs, me.melds));
    this.pending = true;
    this.selected = null;
    this.turnConfirm = false;
    this.turnHelp = [];
    this.shell.sendGame({ t: 'mj-discard', tile: item.tile });
    this.renderActions();
  }

  // Dragging your tiles into the order you like (the new tile stays last until you've thrown one).

  private onPointerDown = (e: PointerEvent) => {
    // (One finger at a time: a second one doesn't take over the tile the first is holding.)
    if ((e.pointerType === 'mouse' && e.button !== 0) || !e.isPrimary) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.mj-h:not(.mj-new)');
    const key = el?.dataset.key;
    if (!el || !key) return;
    this.drag = { key, el, x: e.clientX, y: e.clientY, id: e.pointerId, moving: false };
  };

  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moving) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      try {
        this.handEl().setPointerCapture(e.pointerId);
      } catch {
        // The pointer has already gone: no drag (the row is only held still while one's on).
        this.drag = null;
        return;
      }
      d.moving = true;
      d.el.classList.add('held');
    }
    d.el.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (!d.moving) return;
    this.noClickUntil = performance.now() + 350;
    d.el.classList.remove('held');
    d.el.style.transform = '';
    // Called off by the phone (a call coming in, a swipe from the edge): the tile goes back.
    if (e.type !== 'pointerup') return this.renderMine();
    // Drop it before the tile nearest where it was let go (or after the last).
    const tiles = [...this.handEl().querySelectorAll<HTMLElement>('.mj-h:not(.mj-new)')].filter((x) => x !== d.el);
    let best = -1;
    let bestDist = Infinity;
    let after = false;
    tiles.forEach((t, i) => {
      const r = t.getBoundingClientRect();
      const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
      if (dist < bestDist) (bestDist = dist), (best = i), (after = e.clientX > r.left + r.width / 2);
    });
    const keys = this.handTiles().filter((x) => !x.isNew);
    const from = keys.findIndex((x) => x.key === d.key);
    if (from < 0 || best < 0) return this.renderMine();
    const targetKey = tiles[best].dataset.key;
    const moved = keys.splice(from, 1)[0];
    let to = keys.findIndex((x) => x.key === targetKey);
    // (The tile it was dropped by has gone meanwhile: leave the order as it was.)
    if (to < 0) return this.renderMine();
    if (after) to++;
    keys.splice(to, 0, moved);
    this.order = keys.map((x) => x.tile);
    this.saveOrder();
    this.shell.stillHere();
    this.renderMine();
  };

  dispose() {
    this.untuck();
    this.observer.disconnect();
    this.stopDeal();
    for (const t of this.timers) clearTimeout(t);
    window.clearTimeout(this.freshTimer);
    window.clearTimeout(this.tipTimer);
    this.el.removeEventListener('click', this.onClick);
    const hand = this.handEl();
    hand.removeEventListener('pointerdown', this.onPointerDown);
    hand.removeEventListener('pointermove', this.onPointerMove);
    hand.removeEventListener('pointerup', this.onPointerUp);
    hand.removeEventListener('pointercancel', this.onPointerUp);
    hand.removeEventListener('lostpointercapture', this.onPointerUp);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}

/** The three tiles of a Chow from its lowest. */
function mjSortRun(lo: MjTile): MjTile[] {
  const s = lo[0];
  const n = Number(lo[1]);
  return [n, n + 1, n + 2].map((k) => `${s}${k}`);
}

/** How long a Pung, Chow or Kong is shown off (the server waits as long: MJ_SHOW_CLAIM_MS). */
const SHOW_CLAIM_MS = 2500;

/** Learning Mode: how long a note stays over your tiles. */
const TIP_MS = 8000;

/** Which tile is on offer (a new one, or the same kind thrown again later, is a different offer). */
function offerKey(v: MahjongView): string {
  return v.offer ? `${v.offer.seat}${v.offer.tile}${v.log.length}${v.offer.kong ? 'k' : ''}` : '';
}

/** A second tap on your lifted tile sooner than this doesn't throw it away (a double tap from habit). */
const DOUBLE_TAP_MS = 500;

/** A set someone has just made: a new one, or a Pung that has just become a Kong. */
function newSet(prev: MahjongView, v: MahjongView): { seat: number; index: number } | null {
  for (let seat = 0; seat < 4; seat++) {
    const a = prev.seats[seat].melds;
    const b = v.seats[seat].melds;
    if (b.length > a.length) return { seat, index: b.length - 1 };
    const grown = b.findIndex((m, i) => m.kind === 'kong' && a[i] && a[i].kind === 'pung');
    if (grown >= 0) return { seat, index: grown };
  }
  return null;
}

/** The tile taken off the table for a new set: the one that was on offer (Chows need it to know which). */
function prevOffer(v: MahjongView, made: { seat: number; index: number }): MjTile | null {
  const m = v.seats[made.seat].melds[made.index];
  if (m.from === null) return null;
  const taken = v.log.filter((d) => d.taken && d.seat === m.from).at(-1);
  return taken ? taken.tile : null;
}
