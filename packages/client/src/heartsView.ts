import { CARD_SOUNDS } from './audio';
import { suitOf, type Card, type GameServerMessage, type HeartsView as TableView, type PassDir } from '@tank/shared';
import { colorCss, escapeHtml } from './state';
import type { PadPress } from './gamepad';
import type { ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const SUIT_SYMBOL: Record<string, string> = { C: '♣', D: '♦', H: '♥', S: '♠' };
const RANK_LABEL = (c: Card) => (c[0] === 'T' ? '10' : c[0]);
const PASS_WORD: Record<PassDir, string> = { left: 'left', right: 'right', across: 'across', none: '' };

export function cardHtml(c: Card, extra = '') {
  const s = suitOf(c);
  return `<span class="card s-${s} ${extra}" data-card="${c}" aria-label="${RANK_LABEL(c)} of ${{ C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' }[s]}"><span class="c-corner">${RANK_LABEL(c)}<br>${SUIT_SYMBOL[s]}</span><span class="c-big">${SUIT_SYMBOL[s]}</span></span>`;
}

/**
 * Hearts on a DOM table. You always sit at the bottom; the others sit left, across and right
 * in seat order, so "pass left" goes to the player on your left.
 */
export class HeartsTable implements View {
  readonly landscape = false;
  readonly helpHtml =
    '<p><b>Hearts:</b> pass 3 cards, then follow suit if you can. Hearts are 1 point each, the queen of spades 13. Take them all to shoot the moon. Lowest score when someone reaches 100 wins.</p><p>On a phone, tap a card once to lift it and again to play it.</p>';
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
  private handObserver = new ResizeObserver(() => this.layoutHand());

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
          <button class="btn btn-primary ht-action" type="button" hidden></button>
        </div>
        <div class="ht-mine"><div class="ht-seat ht-pos-0"></div><button class="ht-scores-btn" type="button">Scores</button></div>
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

    for (let seat = 0; seat < 4; seat++) {
      const s = v.seats[seat];
      const el = q<HTMLElement>(`.ht-pos-${this.pos(seat)}`);
      let tag = '';
      if (s.bot) tag = '<span class="ht-tag" title="Bot" aria-label="bot">🤖</span>';
      if (s.away) tag = '<span class="ht-tag" title="Away: a bot is playing their cards" aria-label="away, a bot is playing">💤</span>';
      const status = v.phase === 'passing' && s.passed ? '<span class="ht-badge"><span class="ht-long">passed </span>✓</span>' : '';
      const taken = s.taken ? ` <span class="ht-taken">+${s.taken}<span class="ht-long"> this hand</span></span>` : '';
      const backs = seat === v.seat ? '' : `<span class="ht-backs" aria-label="${s.cards} cards">${'<i></i>'.repeat(Math.min(s.cards, 13))}</span>`;
      el.innerHTML = `<div class="ht-name"><span class="dot" style="background:${colorCss(s.color)}"></span><span class="ht-nm">${escapeHtml(s.name)}</span></div>
        <div class="ht-score">${s.score} pts${taken} ${tag}${status}</div>${backs}`;
      el.classList.toggle('turn', v.turn === seat);
      if (s.alias) el.dataset.alias = s.alias;
      else delete el.dataset.alias;
      el.classList.toggle('speaking', !!s.alias && this.speaking.has(s.alias));
    }

    // Trick: each card sits toward the player who played it.
    for (let p = 0; p < 4; p++) q<HTMLElement>(`.ht-slot-${p}`).innerHTML = '';
    for (const t of v.trick) {
      const win = v.trickWinner === t.seat ? 'winner' : '';
      q<HTMLElement>(`.ht-slot-${this.pos(t.seat)}`).innerHTML = cardHtml(t.card, `played ${win}`);
    }
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
        text = `Pick 3 cards to pass ${PASS_WORD[v.passDir]} to ${escapeHtml(to)}`;
        action.hidden = false;
        action.disabled = this.selected.size !== 3 || this.pending;
        action.textContent = `Pass ${this.selected.size}/3`;
        action.dataset.act = 'pass';
      }
    } else if (v.phase === 'playing') {
      if (v.trickWinner !== null) text = v.trickWinner === v.seat ? 'You take the trick' : `${escapeHtml(this.name(v.trickWinner))} takes the trick`;
      else if (v.turn === v.seat) text = this.shell.device.touch ? (this.lifted ? 'Tap it again to play' : 'Your turn: tap a card') : 'Your turn';
      else if (v.turn !== null) text = `Waiting for ${escapeHtml(this.name(v.turn))}…`;
      if (v.hand > 0 && v.passDir === 'none' && v.trick.length === 0 && v.seats.every((s) => s.cards === 13)) text += ' · No passing this hand';
    } else if (v.phase === 'handEnd') {
      text = 'Next hand coming up…';
    }
    if (v.heartsBroken && v.phase === 'playing') text += ' <span class="ht-broken">♥ broken</span>';
    status.innerHTML = text;

    this.renderHand();
    this.renderOverlay();
  }

  private renderHand() {
    const v = this.view!;
    const hand = this.el.querySelector('.ht-hand') as HTMLElement;
    const myTurn = v.phase === 'playing' && v.turn === v.seat && v.trickWinner === null;
    let html = '';
    for (const c of v.cards) {
      const cls: string[] = [];
      if (v.phase === 'passing' && !v.passing && this.selected.has(c)) cls.push('raised');
      if (v.passing?.includes(c)) cls.push('passing');
      if (this.lifted === c) cls.push('raised');
      if (myTurn) cls.push(v.legal.includes(c) ? 'legal' : 'illegal');
      if (this.cursor === c) cls.push('pad-cursor');
      // Cards passed to you stay marked until you play your first card.
      if (v.received.includes(c) && v.seats[v.seat ?? 0].cards === 13) cls.push('new');
      html += cardHtml(c, cls.join(' '));
    }
    hand.innerHTML = html;
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
    let html = '<div class="ht-panel">';
    if (v.phase === 'gameOver') {
      const names = v.winners.map((i) => escapeHtml(this.name(i)));
      const youWon = v.seat !== null && v.winners.includes(v.seat);
      html += `<h2>${youWon ? 'You win!' : `${names.join(' & ')} ${v.winners.length > 1 ? 'win' : 'wins'}!`}</h2>`;
    } else if (v.phase === 'handEnd' && v.result) {
      html += `<h2>Hand ${v.hand} done</h2>`;
      if (v.result.moon !== null) html += `<p class="ht-moon">🌙 ${escapeHtml(this.name(v.result.moon))} shot the moon!</p>`;
    } else {
      html += '<h2>Scores</h2>';
    }
    html += '<table class="ht-table"><thead><tr><th></th>';
    for (let s = 0; s < 4; s++) html += `<th><span class="dot" style="background:${colorCss(v.seats[s].color)}"></span>${escapeHtml(v.seats[s].name)}</th>`;
    html += '</tr></thead><tbody>';
    v.history.forEach((row, i) => {
      html += `<tr><td>Hand ${i + 1}</td>${row.map((n) => `<td>${n}</td>`).join('')}</tr>`;
    });
    if (v.result && v.phase !== 'playing' && v.phase !== 'passing') {
      html += `<tr class="ht-last"><td>This hand</td>${v.result.points.map((n) => `<td>+${n}</td>`).join('')}</tr>`;
    }
    html += `<tr class="ht-total"><td>Total</td>${v.seats.map((s) => `<td>${s.score}</td>`).join('')}</tr>`;
    html += '</tbody></table>';
    html += `<p class="hint">First to ${v.target} ends the game. Lowest score wins.</p>`;
    html += '<div class="actions">';
    if (v.phase === 'gameOver') {
      if (v.seat !== null) html += '<button class="btn btn-primary" data-act="again" type="button">New game</button>';
      if (this.shell.isPrivate) html += '<button class="btn btn-secondary" data-act="lobby" type="button">Back to lobby</button>';
    } else if (this.scoresOpen) {
      html += '<button class="btn btn-primary" data-act="close-scores" type="button">Close</button>';
    }
    html += '</div></div>';
    box.innerHTML = html;
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
      if (v.cards.some((x) => suitOf(x) === led)) return `You have to follow suit (${SUIT_SYMBOL[led]}).`;
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
