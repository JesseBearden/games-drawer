import { CARD_SOUNDS } from './audio';
import { suitOf, type Card, type GameServerMessage, type HeartsView as TableView, type PassDir } from '@tank/shared';
import { patchHtml, syncKeyed } from './dom';
import { escapeHtml, nameHtml } from './html';
import { cardFaceSvg, suitSvg, SUIT_NAME, type Rank, type Suit } from './paperArt';
import type { PadPress } from './gamepad';
import type { ShellApi, View } from './views';
import { scoreSheetHtml } from './scoreSheet';
import { seatFelts } from './felts';
export { scoreSheetHtml };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const RANK_LABEL = (c: Card) => (c[0] === 'T' ? '10' : c[0]);
const PASS_WORD: Record<PassDir, string> = { left: 'left', right: 'right', across: 'across', none: '' };

/** A playing card: card stock with the face printed on it (paperArt). */
export function cardHtml(c: Card, extra = '') {
  return `<span class="${cardClass(c, extra)}" data-card="${c}">${cardFaceSvg(RANK_LABEL(c) as Rank, suitOf(c) as Suit)}</span>`;
}

const cardClass = (c: Card, extra: string) => `card s-${suitOf(c)} ${extra}`;

/**
 * Put a hand on screen. Each card keeps its element (so a pick, a lift, a card played from the
 * middle only changes what it has to): rebuilding every card face (and its portrait image) each
 * time made every tap and controller press slow.
 */
export function showHand(hand: HTMLElement, cards: Card[], classes: (c: Card) => string) {
  syncKeyed(hand, cards.map((c) => ({ key: c, className: cardClass(c, classes(c)), make: () => cardHtml(c) })));
}

/** The cards in the middle, each toward whoever played it. */
export function showTrick(root: HTMLElement, trick: readonly { seat: number; card: Card }[], winner: number | null, pos: (seat: number) => number) {
  for (let p = 0; p < 4; p++) {
    const here = trick.filter((t) => pos(t.seat) === p);
    syncKeyed(
      root.querySelector(`.ht-slot-${p}`)!,
      here.map((t) => ({ key: t.card, className: cardClass(t.card, `played ${winner === t.seat ? 'winner' : ''}`), make: () => cardHtml(t.card) })),
    );
  }
}

/** A seat's name tag: its talking rings, the name, and words for computer players and people who are away. */
/** Rows for a score sheet with one row per seat: you first, then in turn order. */
export function seatRows(seats: { name: string; score: number }[], history: number[][], mySeat: number | null) {
  const first = mySeat ?? 0;
  return [0, 1, 2, 3].map((k) => {
    const s = (first + k) % 4;
    return { label: escapeHtml(seats[s].name), history: history.map((h) => h[s]), total: seats[s].score };
  });
}

/** Score sheets: the names (one line each) shrink to fit if they must, sharing one size, then "…". */
export function fitScoreTable(root: HTMLElement) {
  fitTogether([...root.querySelectorAll<HTMLElement>('.ht-sheet .ht-who .pc-nm')], 12);
}

/** Note, the smallest text there is (DESIGN.md), in px as this browser works it out. */
export function notePx() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--type-note)';
  document.body.append(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return px;
}

/**
 * The name tags around a card table: names and scores on one line. Long ones shrink to fit, to
 * Note at the least (then end in "…"). The other players' tags share one size, the smallest that
 * fits, so side by side they match; your own tag sizes itself. `scale`: how much the table is
 * enlarged on screen (Mahjong scales its table to fit). `least`: smallest sizes other than Note,
 * for a table not on DESIGN.md's lists yet (Mahjong).
 */
export function fitSeatText(root: HTMLElement, scale = 1, least?: { name: number; score: number }) {
  const note = least ? 0 : notePx();
  const floor = least ?? { name: note, score: note };
  for (const [sel, minPx] of [['.ht-nm', floor.name], ['.ht-score', floor.score]] as const) {
    const mine = root.querySelector<HTMLElement>(`.ht-pos-0 ${sel}`);
    if (mine) fitOneLine(mine, minPx, scale);
    fitTogether([1, 2, 3].flatMap((p) => [...root.querySelectorAll<HTMLElement>(`.ht-pos-${p} ${sel}`)]), minPx, scale);
  }
}

/** Fits each line, then gives them all the smallest size any of them needed. */
function fitTogether(els: HTMLElement[], minPx: number, scale = 1) {
  for (const el of els) fitOneLine(el, minPx, scale);
  const least = Math.min(...els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  if (Number.isFinite(least)) for (const el of els) el.style.fontSize = `${least}px`;
}

/**
 * Keeps a line of text (a name on a name tag) on one line: if it's too wide for its box, the font
 * shrinks to fit, but never below minPx (Note, notePx(), on a name tag); past that, CSS cuts it
 * off with "…". One measurement is enough, since text width grows with font size. `scale`: how
 * much it's enlarged on screen (measurements are on screen; padding and font sizes aren't).
 */
export function fitOneLine(el: HTMLElement, minPx: number, scale = 1) {
  el.style.fontSize = '';
  const cs = getComputedStyle(el);
  // A name tag turned on its side (Dominoes on an upright phone) runs its line downward.
  const sideways = cs.writingMode.startsWith('vertical');
  const box = el.getBoundingClientRect();
  const room = sideways
    ? box.height / scale - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    : box.width / scale - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (!(room > 0)) return;
  // The text's own length, to the fraction of a pixel: a line a third of a pixel too long still
  // ends in "…", and scrollWidth rounds that away ("Sparky 3000" on a phone held sideways).
  // scrollWidth still counts for what the text alone doesn't, like a "· " put before it.
  const range = document.createRange();
  range.selectNodeContents(el);
  const text = range.getBoundingClientRect();
  const over = sideways ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  const need = Math.max((sideways ? text.height : text.width) / scale, over > 0 ? room + over : 0);
  if (need <= room) return;
  const base = parseFloat(cs.fontSize);
  el.style.fontSize = `${Math.max(minPx, Math.floor(((base * room) / need) * 10) / 10)}px`;
}

/** A small computer screen beside a computer player's name (name tags only, not score sheets). */
const COMPUTER_MARK =
  '<span class="ht-cpu" role="img" aria-label="Computer player" title="Computer player"><svg viewBox="0 0 16 14" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10v2.5M4.8 12.6h6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span>';

/** A small "zzz" beside the name of someone who dropped out (a computer plays for them). */
const AWAY_MARK =
  '<span class="ht-cpu ht-away" role="img" aria-label="Away" title="Away"><svg viewBox="0 0 18 14" aria-hidden="true"><path d="M1 8.5h3.6l-3.6 4h3.6M6.5 4.8h4.4l-4.4 4.6h4.4M12.6 1h4.4l-4.4 4.8h4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

export function seatNameHtml(name: string, opts: { bot?: boolean; away?: boolean; after?: string }) {
  // Marks, not words, so every name tag keeps the same two lines (user, 2026-11-20): someone
  // who dropped out gets a small "zzz", a computer player a small computer screen.
  const mark = opts.away ? AWAY_MARK : opts.bot ? COMPUTER_MARK : '';
  // (`after`: a game's own mark beside the name, like Mahjong's seat wind.)
  return `<div class="ht-name"><span class="pc-talk"></span><span class="ht-nm">${escapeHtml(name)}</span>${opts.after ?? ''}${mark}</div>`;
}

/**
 * Hearts on a DOM table. You always sit at the bottom; the others sit left, across and right
 * in seat order, so "pass left" goes to the player on your left.
 */
export class HeartsTable implements View {
  readonly landscape = false;
  readonly helpHtml =
    '<p>Pass 3 cards, then follow suit if you can. Hearts are 1 point each, the queen of spades 13. Take them all to shoot the moon. Lowest score when someone reaches 100 wins.</p><p>On a phone, tap a card once to lift it and again to play it.</p>';
  private el = $('hearts-view');
  private view: TableView | null = null;
  private selected = new Set<Card>();
  /** Touch: the card lifted by the first tap. */
  private lifted: Card | null = null;
  /** A play or pass is on its way; ignore taps until the server answers. */
  private pending = false;
  private scoresOpen = false;
  private speaking = new Set<string>();
  /** The card a controller has highlighted. */
  private cursor: Card | null = null;
  /** Re-spreads the hand whenever its box changes size (rotating a phone, resizing a window). */
  private handObserver = new ResizeObserver(() => {
    this.layoutHand();
    fitSeatText(this.el);
  });

  constructor(private shell: ShellApi) {
    this.el.hidden = false;
    this.el.innerHTML = `
      <div class="ht">
        <div class="ht-seat ht-pos-2"></div>
        <div class="ht-seat ht-pos-1"></div>
        <div class="ht-seat ht-pos-3"></div>
        <div class="ht-center">
          <div class="ht-trick">
            <div class="ht-slot ht-slot-0"></div><div class="ht-slot ht-slot-1"></div><div class="ht-slot ht-slot-2"></div><div class="ht-slot ht-slot-3"></div>
          </div>
          <div class="ht-status" aria-live="polite">Dealing…</div>
          <button class="pc-btn pc-btn-main ht-action" type="button" hidden></button>
        </div>
        <div class="ht-mine"><div class="ht-seat ht-pos-0"></div><button class="ht-scores-btn pc-btn pc-btn-plain" type="button">Scores</button></div>
        <div class="ht-hand"></div>
        <div class="ht-overlay" hidden></div>
      </div>`;
    this.el.addEventListener('click', this.onClick);
    this.handObserver.observe(this.el.querySelector('.ht-hand')!);
    // Card sounds aren't loaded with the tank ones; fetch them now so the first deal has them.
    shell.sfx.preloadSounds(CARD_SOUNDS);
  }

  onGameMessage(m: GameServerMessage) {
    if (m.t !== 'hearts') return;
    const prev = this.view;
    this.view = m.view;
    this.pending = false;
    if (prev && prev.hand !== m.view.hand) {
      this.selected.clear();
      this.lifted = null;
    }
    if (m.view.phase !== 'passing') this.selected.clear();
    if (this.lifted && !m.view.legal.includes(this.lifted)) this.lifted = null;
    this.sounds(prev, m.view);
    this.render();
  }

  onSpeaking(aliases: Set<string>) {
    this.speaking = aliases;
    for (const el of this.el.querySelectorAll<HTMLElement>('.ht-seat[data-alias]')) el.classList.toggle('speaking', aliases.has(el.dataset.alias!));
  }

  resize() {
    this.layoutHand();
  }

  // ------------------------------------------------------------------ controller

  /**
   * Controller: left/right moves a highlight through your hand and A plays (or picks) that
   * card; up moves to the buttons, down comes back. Y passes your three cards. View shows the scores.
   */
  onPad(p: PadPress, down: boolean): boolean {
    if (!down || !this.view) return false;
    const b = p.button;
    if (b === 'view') {
      this.scoresOpen = !this.scoresOpen;
      this.renderOverlay();
      return true;
    }
    if (this.padScope()) return false;
    if (b === 'y') {
      // Y passes once three cards are picked.
      const act = this.el.querySelector<HTMLButtonElement>('.ht-action');
      if (act && !act.hidden && !act.disabled) act.click();
      return true;
    }
    const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    if (focused) {
      if (b === 'down' && this.el.contains(focused)) {
        focused.blur();
        this.moveCursor(0);
        return true;
      }
      return false;
    }
    if (b === 'left' || b === 'right') {
      this.moveCursor(b === 'left' ? -1 : 1);
      return true;
    }
    if (b === 'a') {
      if (this.cursor && this.view.cards.includes(this.cursor)) this.tapCard(this.cursor, true);
      else this.moveCursor(0);
      return true;
    }
    return false;
  }

  private moveCursor(step: number) {
    const v = this.view;
    if (!v || !v.cards.length) return;
    let i = this.cursor ? v.cards.indexOf(this.cursor) : -1;
    if (i < 0) i = Math.max(0, v.cards.findIndex((c) => v.legal.includes(c)));
    else i = (i + step + v.cards.length) % v.cards.length;
    this.cursor = v.cards[i];
    document.body.classList.add('pad-mode');
    this.renderHand();
  }

  padOrigin() {
    const el = this.cursor ? this.el.querySelector(`.ht-hand .card[data-card="${this.cursor}"]`) : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top };
  }

  padScope() {
    const o = this.el.querySelector('.ht-overlay') as HTMLElement | null;
    return o && !o.hidden ? o : null;
  }

  // ------------------------------------------------------------------ rendering

  /** Screen position (0 bottom, 1 left, 2 top, 3 right) of a seat. */
  private pos(seat: number) {
    const me = this.view?.seat ?? 0;
    return (seat - me + 4) % 4;
  }

  private name(seat: number) {
    return this.view!.seats[seat].name;
  }

  private render() {
    const v = this.view;
    if (!v) return;
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;
    q<HTMLElement>('.ht').dataset.phase = v.phase;

    let tagsChanged = false;
    // Each player's own felt, the one their name has on Your table.
    const felts = seatFelts(v.seats);
    for (let seat = 0; seat < 4; seat++) {
      const s = v.seats[seat];
      const el = q<HTMLElement>(`.ht-pos-${this.pos(seat)}`);
      const status = v.phase === 'passing' && s.passed ? ' <span class="ht-badge">Passed</span>' : '';
      const taken = s.taken ? ` <span class="ht-taken">+${s.taken}<span class="ht-long"> this hand</span></span>` : '';
      // No count of the others' cards: everyone holds about the same number in a trick game, so the
      // tag keeps just the name and score (the user, 2026-11-20).
      const changed = patchHtml(el, `${seatNameHtml(s.name, { bot: s.bot, away: s.away })}
        <div class="ht-score">${s.score} pts${taken}${status}</div>`);
      tagsChanged ||= changed;
      el.dataset.felt = felts[seat];
      el.classList.toggle('turn', v.turn === seat);
      if (s.alias) el.dataset.alias = s.alias;
      else delete el.dataset.alias;
      el.classList.toggle('speaking', !!s.alias && this.speaking.has(s.alias));
    }
    if (tagsChanged) fitSeatText(this.el);

    // Trick: each card sits toward the player who played it.
    showTrick(this.el, v.trick, v.trickWinner, (seat) => this.pos(seat));
    q<HTMLElement>('.ht-trick').dataset.taker = v.trickWinner !== null ? String(this.pos(v.trickWinner)) : '';

    // Status line and the one action button.
    const status = q<HTMLElement>('.ht-status');
    const action = q<HTMLButtonElement>('.ht-action');
    action.hidden = true;
    let text = '';
    if (v.seat === null) {
      text = 'Watching. You’ll get a seat when one frees up.';
    } else if (v.phase === 'passing') {
      const to = this.name((v.seat + { left: 1, right: 3, across: 2, none: 0 }[v.passDir]) % 4);
      if (v.passing) text = 'Waiting for everyone to pass…';
      else {
        text = `Pick 3 cards to pass ${PASS_WORD[v.passDir]} to ${nameHtml(to)}`;
        action.hidden = false;
        action.disabled = this.selected.size !== 3 || this.pending;
        action.textContent = `Pass ${this.selected.size}/3`;
        action.dataset.act = 'pass';
      }
    } else if (v.phase === 'playing') {
      if (v.trickWinner !== null) text = v.trickWinner === v.seat ? 'You take the trick' : `${nameHtml(this.name(v.trickWinner))} takes the trick`;
      else if (v.turn === v.seat) text = this.shell.device.touch ? (this.lifted ? 'Tap it again to play' : 'Your turn: tap a card') : 'Your turn';
      else if (v.turn !== null) text = `${nameHtml(this.name(v.turn))}'s turn`;
      if (v.hand > 0 && v.passDir === 'none' && v.trick.length === 0 && v.seats.every((s) => s.cards === 13)) text += ' · No passing this hand';
    } else if (v.phase === 'handEnd') {
      text = 'Next hand coming up…';
    }
    if (v.heartsBroken && v.phase === 'playing') text += ` <span class="ht-broken">${suitSvg('H')} broken</span>`;
    patchHtml(status, text);

    this.renderHand();
    this.renderOverlay();
  }

  private renderHand() {
    const v = this.view!;
    const hand = this.el.querySelector('.ht-hand') as HTMLElement;
    const myTurn = v.phase === 'playing' && v.turn === v.seat && v.trickWinner === null;
    showHand(hand, v.cards, (c) => {
      const cls: string[] = [];
      if (v.phase === 'passing' && !v.passing && this.selected.has(c)) cls.push('raised');
      if (v.passing?.includes(c)) cls.push('passing');
      if (this.lifted === c) cls.push('raised');
      if (myTurn) cls.push(v.legal.includes(c) ? 'legal' : 'illegal');
      if (this.cursor === c) cls.push('pad-cursor');
      // Cards passed to you stay marked until you play your first card.
      if (v.received.includes(c) && v.seats[v.seat ?? 0].cards === 13) cls.push('new');
      return cls.join(' ');
    });
    hand.classList.toggle('my-turn', myTurn);
    this.layoutHand();
  }

  /** Spread the hand to fit the width, overlapping as needed. */
  private layoutHand() {
    const hand = this.el.querySelector('.ht-hand') as HTMLElement | null;
    if (!hand) return;
    const cards = [...hand.querySelectorAll<HTMLElement>('.card')];
    if (!cards.length) return;
    const width = hand.clientWidth;
    const cw = cards[0].offsetWidth || 60;
    const step = cards.length > 1 ? Math.min(cw * 0.72, (width - cw) / (cards.length - 1)) : 0;
    const total = cw + step * (cards.length - 1);
    const left0 = Math.max(0, (width - total) / 2);
    cards.forEach((el, i) => {
      el.style.left = `${left0 + i * step}px`;
      el.style.zIndex = String(i + 1);
    });
  }

  private renderOverlay() {
    const v = this.view!;
    const box = this.el.querySelector('.ht-overlay') as HTMLElement;
    const show = v.phase === 'handEnd' || v.phase === 'gameOver' || this.scoresOpen;
    box.hidden = !show;
    if (!show) return;
    let html = '<div class="ht-panel pc-sheet">';
    if (v.phase === 'gameOver') {
      const names = v.winners.map((i) => nameHtml(this.name(i)));
      const youWon = v.seat !== null && v.winners.includes(v.seat);
      html += `<h2>${youWon ? 'You win!' : `${names.join(' & ')} ${v.winners.length > 1 ? 'win' : 'wins'}!`}</h2>`;
    } else if (v.phase === 'handEnd' && v.result) {
      html += `<h2>Hand ${v.hand} done</h2>`;
      if (v.result.moon !== null) html += `<p class="ht-moon">${nameHtml(this.name(v.result.moon))} shot the moon!</p>`;
    } else {
      html += '<h2>Scores</h2>';
    }
    html += scoreSheetHtml(seatRows(v.seats, v.history, v.seat), v.phase === 'handEnd' || v.phase === 'gameOver');
    html += `<p class="pc-small">First to ${v.target} ends the game. Lowest score wins.</p>`;
    html += '<div class="actions">';
    if (v.phase === 'gameOver') {
      if (v.seat !== null) html += '<button class="pc-btn pc-btn-main" data-act="again" type="button">New game</button>';
      html += '<button class="pc-btn pc-btn-plain" data-act="lobby" type="button">Switch game</button>';
    } else if (this.scoresOpen) {
      html += '<button class="pc-btn pc-btn-main" data-act="close-scores" type="button">Close</button>';
    }
    html += '</div></div>';
    patchHtml(box, html);
    fitScoreTable(box);
  }

  // ------------------------------------------------------------------ sounds

  private sounds(prev: TableView | null, v: TableView) {
    const play = (name: string) => this.shell.play(name);
    if (!prev || prev.hand !== v.hand) {
      if (v.cards.length) play('cardDeal');
      return;
    }
    if (prev.phase === 'passing' && v.phase === 'playing' && v.received.length) play('cardPass');
    if (v.trick.length > prev.trick.length) {
      const card = v.trick.at(-1)!.card;
      play(card === 'QS' ? 'queenSpades' : 'cardPlay');
    }
    if (!prev.heartsBroken && v.heartsBroken) play('heartsBroken');
    if (prev.trickWinner === null && v.trickWinner !== null) play('trickTake');
    if (prev.turn !== v.seat && v.turn === v.seat && v.seat !== null && v.trickWinner === null) play('yourTurn');
    if (prev.phase !== v.phase && (v.phase === 'handEnd' || v.phase === 'gameOver')) play(v.phase === 'gameOver' && v.seat !== null && v.winners.includes(v.seat) ? 'win' : 'handEnd');
  }

  // ------------------------------------------------------------------ input

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'again') {
      this.shell.sendGame({ t: 'again' });
      return;
    }
    if (act === 'lobby') {
      this.shell.toLobby();
      return;
    }
    if (act === 'close-scores') {
      this.scoresOpen = false;
      this.renderOverlay();
      return;
    }
    if (act === 'pass') {
      if (this.selected.size === 3 && !this.pending) {
        this.pending = true;
        this.shell.sendGame({ t: 'pass', cards: [...this.selected] });
        this.render();
      }
      return;
    }
    if (t.closest('.ht-scores-btn')) {
      this.scoresOpen = !this.scoresOpen;
      this.renderOverlay();
      return;
    }
    const cardEl = t.closest<HTMLElement>('.ht-hand .card');
    if (cardEl) this.tapCard(cardEl.dataset.card!);
  };

  private tapCard(c: Card, direct = false) {
    const v = this.view;
    if (!v || v.seat === null || this.pending) return;
    if (v.phase === 'passing' && !v.passing) {
      if (this.selected.has(c)) this.selected.delete(c);
      else if (this.selected.size < 3) this.selected.add(c);
      else this.shell.toast('You pass exactly 3 cards. Tap one to put it back first.');
      this.render();
      return;
    }
    if (v.phase !== 'playing' || v.turn !== v.seat || v.trickWinner !== null) return;
    if (!v.legal.includes(c)) {
      this.shell.toast(this.whyIllegal(v, c));
      return;
    }
    // Phones: first tap lifts the card, second plays it (no misplays from a stray tap).
    if (this.shell.device.touch && !direct && this.lifted !== c) {
      this.lifted = c;
      this.render();
      return;
    }
    this.lifted = null;
    this.pending = true;
    this.shell.sendGame({ t: 'play', card: c });
  }

  private whyIllegal(v: TableView, c: Card): string {
    if (v.trick.length) {
      const led = suitOf(v.trick[0].card);
      if (v.cards.some((x) => suitOf(x) === led)) return `You have to follow suit: play one of your ${SUIT_NAME[led as Suit]}.`;
      return 'No points on the first trick.';
    }
    if (v.cards.includes('2C') && c !== '2C') return 'The 2 of clubs leads the first trick.';
    if (suitOf(c) === 'H') return 'Hearts aren’t broken yet.';
    return 'You can’t play that card now.';
  }

  dispose() {
    this.handObserver.disconnect();
    this.el.removeEventListener('click', this.onClick);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}
