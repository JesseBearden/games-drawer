import { CARD_SOUNDS } from './audio';
import { suitOf, type Card, type GameServerMessage, type SpadesView } from '@tank/shared';
import { patchHtml } from './dom';
import { fitSeatText, scoreSheetHtml, seatNameHtml, showHand, showTrick } from './heartsView';
import { suitSvg, SUIT_NAME, type Suit } from './paperArt';
import { escapeHtml, nameHtml } from './html';
import { focusForPad, type PadPress } from './gamepad';
import type { ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Spades at a DOM table, laid out like Hearts (and sharing its styles): you sit at the bottom
 * and your partner across the top. Bidding happens in the middle of the table.
 */
export class SpadesTable implements View {
  readonly landscape = false;
  readonly helpHtml =
    '<p>You and the player across are a team. Each of you bids how many tricks you’ll take (Nil means none). Follow suit if you can; spades beat everything but can’t be led until one has been played.</p><p>Make your team’s bid for 10 points a trick. Extra tricks are bags: 10 bags cost 100. First team to 500 wins.</p><p>On a phone, tap a card once to lift it and again to play it.</p>';
  private el = $('spades-view');
  private view: SpadesView | null = null;
  private lifted: Card | null = null;
  private pending = false;
  private scoresOpen = false;
  private speaking = new Set<string>();
  /** The card a controller has highlighted. */
  private cursor: Card | null = null;
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
          <div class="sp-score" aria-live="polite"></div>
          <div class="ht-trick">
            <div class="ht-slot ht-slot-0"></div><div class="ht-slot ht-slot-1"></div><div class="ht-slot ht-slot-2"></div><div class="ht-slot ht-slot-3"></div>
          </div>
          <div class="sp-bids" hidden></div>
          <div class="ht-status" aria-live="polite">Dealing…</div>
        </div>
        <div class="ht-mine"><div class="ht-seat ht-pos-0"></div><button class="ht-scores-btn pc-btn pc-btn-plain" type="button">Scores</button></div>
        <div class="ht-hand"></div>
        <div class="ht-overlay" hidden></div>
      </div>`;
    this.el.addEventListener('click', this.onClick);
    this.handObserver.observe(this.el.querySelector('.ht-hand')!);
    shell.sfx.preloadSounds(CARD_SOUNDS);
  }

  onGameMessage(m: GameServerMessage) {
    if (m.t !== 'spades') return;
    const prev = this.view;
    this.view = m.view;
    this.pending = false;
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
   * card; up moves to the buttons, down comes back. View shows the scores.
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
    // Bidding: the controller moves between the bid buttons (starting on 3) and A bids.
    const bids = this.el.querySelector('.sp-bids') as HTMLElement;
    if (!bids.hidden && !bids.contains(document.activeElement)) {
      const start = bids.querySelector<HTMLElement>('[data-bid="3"]') ?? bids.querySelector<HTMLElement>('button');
      if (start) focusForPad(start);
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

  /** Screen position (0 bottom, 1 left, 2 top, 3 right) of a seat. */
  private pos(seat: number) {
    return (seat - (this.view?.seat ?? 0) + 4) % 4;
  }

  private name(seat: number) {
    return this.view!.seats[seat].name;
  }

  /** "Us" is the team of the person looking (seat 0's team when watching). */
  private myTeam() {
    return (this.view?.seat ?? 0) % 2;
  }

  private render() {
    const v = this.view;
    if (!v) return;
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;
    q<HTMLElement>('.ht').dataset.phase = v.phase;

    let tagsChanged = false;
    for (let seat = 0; seat < 4; seat++) {
      const s = v.seats[seat];
      const el = q<HTMLElement>(`.ht-pos-${this.pos(seat)}`);
      const bid = s.bid === null ? (v.phase === 'bidding' ? '<span class="sp-bid pending">Bidding…</span>' : '') : `<span class="sp-bid${s.bid === 0 ? ' nil' : ''}">${s.bid === 0 ? 'Nil' : `Bid ${s.bid}`}</span>`;
      const won = v.phase === 'playing' || v.phase === 'handEnd' ? ` · ${s.tricks} won` : '';
      const changed = patchHtml(el, `${seatNameHtml(s.name, { bot: s.bot, away: s.away })}
        <div class="ht-score">${bid}${won}</div>`);
      tagsChanged ||= changed;
      el.classList.toggle('turn', v.turn === seat);
      el.classList.toggle('sp-us', s.team === this.myTeam());
      if (s.alias) el.dataset.alias = s.alias;
      else delete el.dataset.alias;
      el.classList.toggle('speaking', !!s.alias && this.speaking.has(s.alias));
    }
    if (tagsChanged) fitSeatText(this.el);

    // Team scores, with this hand's bid and tricks once bidding is done.
    const us = v.teams[this.myTeam()];
    const them = v.teams[1 - this.myTeam()];
    const line = (label: string, t: (typeof v.teams)[number]) =>
      `<span><b>${label} ${t.score}</b>${v.phase === 'playing' ? ` <small>${t.tricks} of ${t.bid} tricks</small>` : ''}${t.bags ? ` <small>${t.bags} bag${t.bags === 1 ? '' : 's'}</small>` : ''}</span>`;
    patchHtml(q<HTMLElement>('.sp-score'), `${line('Us', us)}${line('Them', them)}`);

    showTrick(this.el, v.trick, v.trickWinner, (seat) => this.pos(seat));
    q<HTMLElement>('.ht-trick').dataset.taker = v.trickWinner !== null ? String(this.pos(v.trickWinner)) : '';

    // Bidding: my turn shows the picker; the hint says what partner bid.
    const bids = q<HTMLElement>('.sp-bids');
    const myBidTurn = v.phase === 'bidding' && v.seat !== null && v.turn === v.seat;
    bids.hidden = !myBidTurn;
    if (myBidTurn) {
      const partnerBid = v.seats[(v.seat! + 2) % 4].bid;
      let html = '';
      for (let n = 0; n <= 13; n++) html += `<button class="pc-btn ${n === 0 ? 'pc-btn-plain' : 'pc-btn-main'}" type="button" data-bid="${n}"${this.pending ? ' disabled' : ''}>${n === 0 ? 'Nil' : n}</button>`;
      patchHtml(bids, html);
      bids.dataset.partner = partnerBid === null ? '' : partnerBid === 0 ? 'Partner bid nil' : `Partner bid ${partnerBid}`;
    }

    let text = '';
    if (v.seat === null) text = 'Watching. You’ll get a seat when one frees up.';
    else if (v.phase === 'bidding') {
      if (myBidTurn) {
        const pb = v.seats[(v.seat + 2) % 4].bid;
        text = `How many tricks will you take?${pb === null ? '' : ` Your partner bid ${pb === 0 ? 'nil' : pb}.`}`;
      } else if (v.turn !== null) text = `${nameHtml(this.name(v.turn))}'s turn to bid`;
    } else if (v.phase === 'playing') {
      if (v.trickWinner !== null) text = v.trickWinner === v.seat ? 'You take the trick' : `${nameHtml(this.name(v.trickWinner))} takes the trick`;
      else if (v.turn === v.seat) text = this.shell.device.touch ? (this.lifted ? 'Tap it again to play' : 'Your turn: tap a card') : 'Your turn';
      else if (v.turn !== null) text = `${nameHtml(this.name(v.turn))}'s turn`;
      if (v.spadesBroken) text += ` <span class="ht-broken">${suitSvg('S')} broken</span>`;
    } else if (v.phase === 'handEnd') text = 'Next hand coming up…';
    patchHtml(q<HTMLElement>('.ht-status'), text);

    this.renderHand();
    this.renderOverlay();
  }

  private renderHand() {
    const v = this.view!;
    const hand = this.el.querySelector('.ht-hand') as HTMLElement;
    const myTurn = v.phase === 'playing' && v.turn === v.seat && v.trickWinner === null;
    showHand(hand, v.cards, (c) => {
      const cls: string[] = [];
      if (this.lifted === c) cls.push('raised');
      if (myTurn) cls.push(v.legal.includes(c) ? 'legal' : 'illegal');
      if (this.cursor === c) cls.push('pad-cursor');
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
    const left0 = Math.max(0, (width - (cw + step * (cards.length - 1))) / 2);
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
    const mine = this.myTeam();
    const teamName = (t: number) => (t === mine ? 'Us' : 'Them');
    const players = (t: number) => [t, t + 2].map((s) => nameHtml(this.name(s))).join(' & ');
    let html = '<div class="ht-panel pc-sheet">';
    if (v.phase === 'gameOver') {
      const weWon = v.winners.includes(mine) && v.seat !== null;
      html += `<h2>${weWon ? 'You win!' : v.winners.length > 1 ? 'A tie!' : `${players(v.winners[0])} win!`}</h2>`;
    } else if (v.phase === 'handEnd') {
      html += `<h2>Hand ${v.hand} done</h2>`;
    } else {
      html += '<h2>Scores</h2>';
    }
    if (v.result && v.phase !== 'bidding' && v.phase !== 'playing') {
      html += '<ul class="sp-result">';
      for (const t of [mine, 1 - mine]) {
        const r = v.result[t];
        const parts: string[] = [];
        if (r.bid > 0) parts.push(r.set ? `bid ${r.bid}, took ${r.tricks}: set` : `bid ${r.bid}, took ${r.tricks}`);
        for (const n of r.nils) parts.push(`${nameHtml(this.name(n.seat))} ${n.made ? 'made' : 'missed'} nil`);
        if (r.bagPenalty) parts.push('10 bags: −100');
        html += `<li><b>${teamName(t)}</b> <small>(${players(t)})</small>: ${parts.join(', ')} → <b class="${r.points < 0 ? 'neg' : ''}">${r.points > 0 ? '+' : ''}${r.points}</b></li>`;
      }
      html += '</ul>';
    }
    html += scoreSheetHtml(
      [mine, 1 - mine].map((t) => ({ label: teamName(t), history: v.history.map((h) => h[t]), total: v.teams[t].score })),
      v.phase === 'handEnd' || v.phase === 'gameOver',
    );
    html += `<p class="pc-small">First team to ${v.target} wins. Bags: us ${v.teams[mine].bags}, them ${v.teams[1 - mine].bags} (10 cost 100).</p>`;
    html += '<div class="actions">';
    if (v.phase === 'gameOver') {
      if (v.seat !== null) html += '<button class="pc-btn pc-btn-main" data-act="again" type="button">New game</button>';
      if (this.shell.isPrivate) html += '<button class="pc-btn pc-btn-plain" data-act="lobby" type="button">Switch game</button>';
    } else if (this.scoresOpen) {
      html += '<button class="pc-btn pc-btn-main" data-act="close-scores" type="button">Close</button>';
    }
    html += '</div></div>';
    patchHtml(box, html);
  }

  private sounds(prev: SpadesView | null, v: SpadesView) {
    const play = (name: string) => this.shell.play(name);
    if (!prev || prev.hand !== v.hand) {
      if (v.cards.length) play('cardDeal');
      return;
    }
    if (v.trick.length > prev.trick.length) play('cardPlay');
    if (!prev.spadesBroken && v.spadesBroken) play('heartsBroken');
    if (prev.trickWinner === null && v.trickWinner !== null) play('trickTake');
    if (prev.turn !== v.seat && v.turn === v.seat && v.seat !== null && v.trickWinner === null) play('yourTurn');
    if (prev.phase !== v.phase && (v.phase === 'handEnd' || v.phase === 'gameOver')) play(v.phase === 'gameOver' && v.seat !== null && v.winners.includes(this.myTeam()) ? 'win' : 'handEnd');
  }

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'again') return this.shell.sendGame({ t: 'again' });
    if (act === 'lobby') return this.shell.toLobby();
    if (act === 'close-scores') {
      this.scoresOpen = false;
      this.renderOverlay();
      return;
    }
    const bid = t.closest<HTMLElement>('[data-bid]')?.dataset.bid;
    if (bid !== undefined) {
      if (this.pending) return;
      this.pending = true;
      this.shell.sendGame({ t: 'bid', bid: Number(bid) });
      this.render();
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
    if (v.phase !== 'playing' || v.turn !== v.seat || v.trickWinner !== null) return;
    if (!v.legal.includes(c)) {
      this.shell.toast(this.whyIllegal(v));
      return;
    }
    if (this.shell.device.touch && !direct && this.lifted !== c) {
      this.lifted = c;
      this.render();
      return;
    }
    this.lifted = null;
    this.pending = true;
    this.shell.sendGame({ t: 'play', card: c });
  }

  private whyIllegal(v: SpadesView): string {
    if (v.trick.length) return `You have to follow suit: play one of your ${SUIT_NAME[suitOf(v.trick[0].card) as Suit]}.`;
    return 'Spades can’t be led until one has been played.';
  }

  dispose() {
    this.handObserver.disconnect();
    this.el.removeEventListener('click', this.onClick);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}
