import { CARD_SOUNDS } from './audio';
import { isJoker, isWild, ttSuit, type GameServerMessage, type TTCard, type ThreeThirteenView } from '@tank/shared';
import { fitScoreTable, fitSeatText, scoreSheetHtml, seatNameHtml } from './heartsView';
import { cardFaceSvg, feltBackHtml, type Rank, type Suit } from './paperArt';
import { escapeHtml } from './state';
import type { ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** How far a press has to move before it's a drag rather than a tap. */
const DRAG_PX = 8;

/** "3s", "10s", "Jacks"… */
export function wildName(rank: number): string {
  return rank === 11 ? 'Jacks' : rank === 12 ? 'Queens' : rank === 13 ? 'Kings' : `${rank}s`;
}

/**
 * A Three Thirteen card: the face from paperArt (a card is "QS0": rank, suit, deck), or one of
 * the user's felt jokers. This round's wilds wear a small sunflower star.
 */
export function ttCardHtml(c: TTCard, round: number, extra = '') {
  const face = isJoker(c)
    ? `<svg viewBox="0 0 250 350" role="img" aria-label="${c[1] === 'R' ? 'Red' : 'Black'} joker"><image href="/art/cards/joker-${c[1] === 'R' ? 'red' : 'black'}.webp" width="250" height="350"/></svg>`
    : cardFaceSvg((c[0] === 'T' ? '10' : c[0]) as Rank, ttSuit(c) as Suit);
  const wild = !isJoker(c) && isWild(c, round) ? '<i class="tt-wild" aria-label="wild"></i>' : '';
  return `<span class="card s-${ttSuit(c)}${isJoker(c) ? ' tt-joker' : ''} ${extra}" data-card="${c}">${face}${wild}</span>`;
}

/**
 * Three Thirteen at a DOM table, laid out like Hearts (and sharing its styles): the pile and the
 * discards in the middle, your hand along the bottom. Drag cards to arrange them; tap one to lift
 * it, and tap it again (or the discards) to throw it away.
 */
export class ThreeThirteenTable implements View {
  readonly landscape = false;
  readonly helpHtml =
    '<p>Round 1 deals 3 cards, round 2 deals 4, up to 13. Jokers are always wild, and so is the card matching the number dealt (3s in round 1, Kings in round 11). Wild cards wear a small star.</p>' +
    '<p>On your turn, tap the pile or the discards to take a card. Then tap a card to lift it, and tap it again to throw it away (not the card you just took from the discards).</p>' +
    '<p>Make sets (three or more of a kind) and runs (three or more in a row in one suit, Ace low). Cards already in a meld have a green edge. When everything but one card fits, <b>Go out</b> lights up; everyone else then gets one last turn.</p>' +
    '<p>Drag your cards to arrange them however you like. Leftover cards count against you: Aces 1, number cards their number, J/Q/K 10, jokers 20. Lowest total after 11 rounds wins.</p>';
  private el = $('threethirteen-view');
  private view: ThreeThirteenView | null = null;
  private lifted: TTCard | null = null;
  private pending = false;
  private readySent = false;
  private scoresOpen = false;
  private speaking = new Set<string>();
  /** A press on a card in your hand: a tap, or (once it moves) a drag to rearrange. */
  private press: { id: number; card: TTCard; x: number; y: number; dragging: boolean; target: number } | null = null;
  private handObserver = new ResizeObserver(() => {
    this.layoutHand();
    fitSeatText(this.el);
  });

  constructor(private shell: ShellApi) {
    this.el.hidden = false;
    this.el.innerHTML = `
      <div class="ht tt">
        <div class="ht-seat ht-pos-2"></div>
        <div class="ht-seat ht-pos-1"></div>
        <div class="ht-seat ht-pos-3"></div>
        <div class="ht-center">
          <div class="tt-round"></div>
          <div class="tt-piles">
            <button class="tt-pile tt-stock" type="button" aria-label="Take the top card from the pile"><span class="card tt-back" data-back=""></span><span class="tt-count"></span></button>
            <button class="tt-pile tt-discard" type="button" aria-label="The discards"></button>
          </div>
          <div class="ht-status" aria-live="polite">Dealing…</div>
          <button class="pc-btn pc-btn-main tt-goout" type="button" hidden>Go out</button>
        </div>
        <div class="ht-mine"><div class="ht-seat ht-pos-0"></div><span class="tt-loose" aria-live="polite"></span><button class="ht-scores-btn pc-btn pc-btn-plain" type="button">Scores</button></div>
        <div class="ht-hand tt-hand"></div>
        <div class="ht-overlay" hidden></div>
      </div>`;
    this.el.addEventListener('click', this.onClick);
    const hand = this.el.querySelector('.tt-hand') as HTMLElement;
    hand.addEventListener('pointerdown', this.onDown);
    hand.addEventListener('pointermove', this.onMove);
    hand.addEventListener('pointerup', this.onUp);
    hand.addEventListener('pointercancel', this.onCancel);
    this.handObserver.observe(hand);
    shell.sfx.preloadSounds(CARD_SOUNDS);
  }

  onGameMessage(m: GameServerMessage) {
    if (m.t !== 'threethirteen') return;
    const prev = this.view;
    this.view = m.view;
    this.pending = false;
    if (m.view.phase !== 'roundEnd') this.readySent = false;
    if (this.lifted && (!m.view.cards.includes(this.lifted) || m.view.step !== 'discard' || m.view.turn !== m.view.seat)) this.lifted = null;
    this.sounds(prev, m.view);
    // Mid-drag, keep the hand still: the drop sends its own order.
    if (this.press?.dragging) this.renderTable();
    else this.render();
  }

  onSpeaking(aliases: Set<string>) {
    this.speaking = aliases;
    for (const el of this.el.querySelectorAll<HTMLElement>('.ht-seat[data-alias]')) el.classList.toggle('speaking', aliases.has(el.dataset.alias!));
  }

  resize() {
    this.layoutHand();
  }

  /** Screen position (0 bottom, 1 left, 2 top, 3 right) of a seat. */
  private pos(seat: number) {
    return (seat - (this.view?.seat ?? 0) + 4) % 4;
  }

  private name(seat: number) {
    return this.view!.seats[seat].name;
  }

  private myTurn() {
    const v = this.view!;
    return v.phase === 'playing' && v.seat !== null && v.turn === v.seat;
  }

  private render() {
    this.renderTable();
    this.renderHand();
    this.renderOverlay();
  }

  /** Everything but your hand: name tags, the piles, the status line. */
  private renderTable() {
    const v = this.view;
    if (!v) return;
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;
    q<HTMLElement>('.ht').dataset.phase = v.phase;

    for (let seat = 0; seat < 4; seat++) {
      const s = v.seats[seat];
      const el = q<HTMLElement>(`.ht-pos-${this.pos(seat)}`);
      const detail = s.out ? '<b class="tt-went-out">Went out</b>' : `${s.cards} card${s.cards === 1 ? '' : 's'}`;
      el.innerHTML = `${seatNameHtml(s.name, { bot: s.bot, away: s.away })}<div class="ht-score">${s.score} pts · ${detail}</div>`;
      el.classList.toggle('turn', v.turn === seat);
      // A seat not in play (the table chose fewer players) keeps its place but shows nothing.
      el.style.visibility = s.playing ? '' : 'hidden';
      if (s.alias) el.dataset.alias = s.alias;
      else delete el.dataset.alias;
      el.classList.toggle('speaking', !!s.alias && this.speaking.has(s.alias));
    }
    fitSeatText(this.el);

    q<HTMLElement>('.tt-round').innerHTML = `Round ${v.round} of ${v.rounds} · <b>${wildName(v.wild)} are wild</b>`;
    const mine = this.myTurn();
    const stock = q<HTMLButtonElement>('.tt-stock');
    stock.classList.toggle('can-take', mine && v.step === 'draw');
    q<HTMLElement>('.tt-count').textContent = String(v.stock);
    // This game's card back (the same for everyone at the table), drawn once per game.
    const back = q<HTMLElement>('.tt-back');
    if (back.dataset.back !== String(v.back)) {
      back.dataset.back = String(v.back);
      back.innerHTML = feltBackHtml(v.back);
    }
    const discard = q<HTMLButtonElement>('.tt-discard');
    discard.innerHTML = v.discardTop ? ttCardHtml(v.discardTop, v.round, 'tt-top') : '<span class="tt-empty"></span>';
    discard.classList.toggle('can-take', mine && v.step === 'draw' && !!v.discardTop);
    discard.classList.toggle('can-drop', mine && v.step === 'discard' && !!this.lifted);
    discard.setAttribute('aria-label', mine && v.step === 'discard' ? 'Throw the lifted card away' : 'Take the top discard');

    const goOut = q<HTMLButtonElement>('.tt-goout');
    goOut.hidden = !(mine && v.step === 'discard' && v.goOut);
    goOut.disabled = this.pending;

    const loose = q<HTMLElement>('.tt-loose');
    loose.textContent = v.plan && v.phase === 'playing' && v.cards.length ? (v.plan.points ? `${v.plan.points} loose` : 'All in melds') : '';
    loose.classList.toggle('done', !!v.plan && v.plan.points === 0 && v.cards.length > 0);

    let text = '';
    const out = v.outSeat;
    const lastTurn = out !== null ? ' (last turn)' : '';
    if (v.seat === null) text = 'Watching. You’ll get a seat when one frees up.';
    else if (v.phase === 'playing') {
      if (out !== null && out !== v.seat && v.turn !== v.seat) text = `<span class="pc-nw">${escapeHtml(this.name(out))}</span> went out! `;
      if (mine) {
        text = out !== null ? `<span class="pc-nw">${escapeHtml(this.name(out))}</span> went out. Your last turn: ` : 'Your turn: ';
        if (v.step === 'draw') text += 'take a card from the pile or the discards.';
        else if (v.goOut) text += 'you can go out!';
        else if (this.lifted) text += 'tap it again to throw it away.';
        else text += 'tap a card to throw away.';
      } else if (v.turn !== null) text += `<span class="pc-nw">${escapeHtml(this.name(v.turn))}</span>’s turn${lastTurn}`;
    } else if (v.phase === 'roundEnd') text = `Round ${v.round} done`;
    q<HTMLElement>('.ht-status').innerHTML = text;
  }

  private renderHand() {
    const v = this.view;
    if (!v) return;
    const hand = this.el.querySelector('.tt-hand') as HTMLElement;
    const melded = new Set(v.plan?.melds.flat() ?? []);
    const classes = (c: TTCard) => {
      const cls: string[] = [];
      if (this.lifted === c) cls.push('raised');
      if (melded.has(c)) cls.push('tt-meld');
      if (v.tookFromDiscard === c) cls.push('tt-took');
      if (v.goOut === c && !this.lifted) cls.push('tt-goout-card');
      return cls.join(' ');
    };
    const cards = v.phase === 'playing' ? v.cards : [];
    const els = [...hand.children] as HTMLElement[];
    if (els.length === cards.length && els.every((el, i) => el.dataset.card === cards[i])) {
      els.forEach((el, i) => {
        const cls = `card s-${ttSuit(cards[i])}${isJoker(cards[i]) ? ' tt-joker' : ''} ${classes(cards[i])}`;
        if (el.className !== cls) el.className = cls;
      });
    } else {
      hand.innerHTML = cards.map((c) => ttCardHtml(c, v.round, classes(c))).join('');
    }
    hand.classList.toggle('my-turn', this.myTurn());
    this.layoutHand();
  }

  /** Where each card sits: spread to fit the width, overlapping as needed. */
  private spacing(count: number) {
    const hand = this.el.querySelector('.tt-hand') as HTMLElement;
    const first = hand.querySelector<HTMLElement>('.card');
    const width = hand.clientWidth;
    const cw = first?.offsetWidth || 60;
    const step = count > 1 ? Math.min(cw * 0.72, (width - cw) / (count - 1)) : 0;
    const left0 = Math.max(0, (width - (cw + step * (count - 1))) / 2);
    return { cw, step, left0 };
  }

  private layoutHand() {
    const hand = this.el.querySelector('.tt-hand') as HTMLElement | null;
    if (!hand) return;
    const cards = [...hand.querySelectorAll<HTMLElement>('.card')];
    if (!cards.length) return;
    const { step, left0 } = this.spacing(cards.length);
    const p = this.press?.dragging ? this.press : null;
    // While dragging, the others close up around the spot the dragged card would land in.
    let slot = 0;
    cards.forEach((el) => {
      if (p && el.dataset.card === p.card) {
        el.style.zIndex = '100';
        return;
      }
      if (p && slot === p.target) slot++;
      el.style.left = `${left0 + slot * step}px`;
      el.style.zIndex = String(slot + 1);
      slot++;
    });
  }

  // ------------------------------------------------------------------ dragging and tapping

  private onDown = (e: PointerEvent) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.tt-hand .card');
    if (!el || !this.view || this.view.seat === null) return;
    const cards = this.view.cards;
    this.press = { id: e.pointerId, card: el.dataset.card!, x: e.clientX, y: e.clientY, dragging: false, target: cards.indexOf(el.dataset.card!) };
    el.setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.dragging) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      p.dragging = true;
      this.el.querySelector('.tt-hand')!.classList.add('tt-dragging');
    }
    const hand = this.el.querySelector('.tt-hand') as HTMLElement;
    const el = hand.querySelector<HTMLElement>(`.card[data-card="${p.card}"]`);
    if (!el) return;
    const n = this.view!.cards.length;
    const { cw, step, left0 } = this.spacing(n);
    const x = e.clientX - hand.getBoundingClientRect().left - cw / 2;
    // Follows the finger with no easing (the others still glide aside).
    el.classList.add('tt-held');
    el.style.left = `${x}px`;
    el.style.transform = `translateY(${Math.min(0, dy)}px)`;
    p.target = Math.max(0, Math.min(n - 1, step > 0 ? Math.round((x - left0) / step) : 0));
    this.layoutHand();
  };

  private onUp = (e: PointerEvent) => {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    this.press = null;
    const hand = this.el.querySelector('.tt-hand') as HTMLElement;
    hand.classList.remove('tt-dragging');
    const el = hand.querySelector<HTMLElement>(`.card[data-card="${p.card}"]`);
    if (el) el.style.transform = '';
    if (!p.dragging) {
      this.tapCard(p.card);
      return;
    }
    const v = this.view!;
    const order = v.cards.filter((c) => c !== p.card);
    order.splice(p.target, 0, p.card);
    if (order.join() !== v.cards.join()) {
      v.cards = order;
      this.shell.sendGame({ t: 'tt-arrange', cards: order });
      // Rebuild in the new order (the moved card is now where it was dropped).
      this.renderHand();
    } else this.layoutHand();
  };

  private onCancel = (e: PointerEvent) => {
    if (!this.press || e.pointerId !== this.press.id) return;
    this.press = null;
    this.el.querySelector('.tt-hand')!.classList.remove('tt-dragging');
    this.renderHand();
  };

  /** Tap a card: lift it to throw away; tap it again to throw it. */
  private tapCard(c: TTCard) {
    const v = this.view;
    if (!v || v.seat === null || this.pending || !this.myTurn()) return;
    if (v.step !== 'discard') {
      this.shell.toast('First take a card from the pile or the discards.');
      return;
    }
    if (c === v.tookFromDiscard) {
      this.shell.toast('You just took that one from the discards: throw away a different card.');
      return;
    }
    if (this.lifted !== c) {
      this.lifted = c;
      this.renderTable();
      this.renderHand();
      return;
    }
    this.throwAway(c);
  }

  private throwAway(c: TTCard) {
    this.lifted = null;
    this.pending = true;
    this.shell.sendGame({ t: 'tt-discard', card: c });
  }

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const v = this.view;
    if (!v) return;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'again') return this.shell.sendGame({ t: 'again' });
    if (act === 'lobby') return this.shell.toLobby();
    if (act === 'ready') {
      if (this.readySent) return;
      this.readySent = true;
      this.shell.sendGame({ t: 'ready' });
      this.renderOverlay();
      return;
    }
    if (act === 'close-scores' || t.closest('.ht-scores-btn')) {
      this.scoresOpen = act === 'close-scores' ? false : !this.scoresOpen;
      this.renderOverlay();
      return;
    }
    if (t.closest('.tt-goout')) {
      if (v.goOut && !this.pending) this.throwAway(v.goOut);
      return;
    }
    if (!this.myTurn() || this.pending) return;
    if (t.closest('.tt-stock') && v.step === 'draw') {
      this.pending = true;
      this.shell.sendGame({ t: 'tt-draw', from: 'stock' });
    } else if (t.closest('.tt-discard')) {
      if (v.step === 'draw' && v.discardTop) {
        this.pending = true;
        this.shell.sendGame({ t: 'tt-draw', from: 'discard' });
      } else if (v.step === 'discard' && this.lifted) this.throwAway(this.lifted);
    }
  };

  // ------------------------------------------------------------------ between rounds

  private renderOverlay() {
    const v = this.view;
    if (!v) return;
    const box = this.el.querySelector('.ht-overlay') as HTMLElement;
    const show = v.phase !== 'playing' || this.scoresOpen;
    box.hidden = !show;
    if (!show) return;
    let html = '<div class="ht-panel pc-sheet">';
    if (v.phase === 'gameOver') {
      const youWon = v.seat !== null && v.winners.includes(v.seat);
      html += `<h2>${youWon ? 'You win!' : `${v.winners.map((i) => escapeHtml(this.name(i))).join(' & ')} ${v.winners.length > 1 ? 'win' : 'wins'}!`}</h2>`;
    } else if (v.phase === 'roundEnd') {
      html += `<h2>Round ${v.round} done</h2>`;
    } else {
      html += '<h2>Scores</h2>';
    }
    if (v.result && v.phase !== 'playing') {
      // Everyone's hand, melds first, then what's loose and what it cost.
      html += '<ul class="tt-reveal">';
      const order = this.inPlay();
      for (const s of order) {
        const r = v.result[s];
        const groups = r.melds.map((m) => `<span class="tt-group">${m.map((c) => ttCardHtml(c, v.round)).join('')}</span>`).join('');
        const loose = r.loose.length ? `<span class="tt-group tt-left">${r.loose.map((c) => ttCardHtml(c, v.round)).join('')}</span>` : '';
        const what = r.out ? 'went out' : r.points ? `+${r.points}` : 'all in melds';
        html += `<li><div class="tt-who"><b class="pc-nm">${escapeHtml(s === v.seat ? 'You' : this.name(s))}</b><span>${what}</span></div><div class="tt-cards">${groups}${loose}</div></li>`;
      }
      html += '</ul>';
    }
    const rows = this.inPlay().map((s) => ({ label: escapeHtml(v.seats[s].name), history: v.history.map((h) => h[s]), total: v.seats[s].score }));
    html += scoreSheetHtml(rows, v.phase !== 'playing', 'Round');
    html += `<p class="pc-small">Lowest total after ${v.rounds} rounds wins.</p>`;
    if (v.phase === 'roundEnd') {
      const wait = this.waitText();
      if (wait) html += `<p class="dm-wait">${wait}</p>`;
    }
    html += '<div class="actions">';
    if (v.phase === 'gameOver') {
      if (v.seat !== null) html += '<button class="pc-btn pc-btn-main" data-act="again" type="button">New game</button>';
      if (this.shell.isPrivate) html += '<button class="pc-btn pc-btn-plain" data-act="lobby" type="button">Switch game</button>';
    } else if (v.phase === 'roundEnd') {
      if (v.seat !== null && !v.ready.includes(v.seat)) {
        html += `<button class="pc-btn pc-btn-main" data-act="ready" type="button"${this.readySent ? ' disabled' : ''}>Ready for round ${v.round + 1}</button>`;
      }
    } else if (this.scoresOpen) {
      html += '<button class="pc-btn pc-btn-main" data-act="close-scores" type="button">Close</button>';
    }
    html += '</div></div>';
    box.innerHTML = html;
    fitScoreTable(box);
  }

  /** The seats in play, you first, then in turn order. */
  private inPlay(): number[] {
    const v = this.view!;
    return [0, 1, 2, 3].map((k) => ((v.seat ?? 0) + k) % 4).filter((s) => v.seats[s].playing);
  }

  /** People at the table we're waiting on before the next round (not computers, not anyone away). */
  private waitText(): string {
    const v = this.view!;
    const waiting = v.seats.flatMap((s, i) => (!s.bot && !s.away && !v.ready.includes(i) ? [i] : []));
    const mine = v.seat !== null && waiting.includes(v.seat);
    const others = waiting.filter((i) => i !== v.seat).map((i) => escapeHtml(this.name(i)));
    if (!mine) return others.length ? `Waiting for ${joinNames(others)}…` : '';
    if (!others.length) return 'Everyone else is ready.';
    return '';
  }

  private sounds(prev: ThreeThirteenView | null, v: ThreeThirteenView) {
    const play = (name: string) => this.shell.play(name);
    if (!prev || prev.round !== v.round) {
      if (v.cards.length) play('cardDeal');
      return;
    }
    const d = v.lastDiscard;
    if (d && (d.card !== prev.lastDiscard?.card || d.seat !== prev.lastDiscard?.seat)) play('cardPlay');
    if (prev.outSeat === null && v.outSeat !== null) play('trickTake');
    if (prev.turn !== v.seat && v.turn === v.seat && v.seat !== null) play('yourTurn');
    if (prev.phase !== v.phase && (v.phase === 'roundEnd' || v.phase === 'gameOver')) play(v.phase === 'gameOver' && v.seat !== null && v.winners.includes(v.seat) ? 'win' : 'handEnd');
  }

  dispose() {
    this.handObserver.disconnect();
    this.el.removeEventListener('click', this.onClick);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
