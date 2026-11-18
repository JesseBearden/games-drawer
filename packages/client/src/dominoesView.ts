import { CARD_SOUNDS } from './audio';
import { DOMINOES_RULES, type DominoesView, type GameServerMessage, type Move, type TileId } from '@tank/shared';
import { bounds, ghostSpot, layoutSpots, limitsFor, tileSvg, type TileSpot } from './dominoLayout';
import { focusForPad, type PadPress } from './gamepad';
import { colorCss, escapeHtml } from './state';
import type { ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Biggest a board unit (half a domino) gets, in pixels, before the layout fills the table. */
const MAX_UNIT = 40;

/**
 * Dominoes (All Fives) on the shared card-table layout: opponents around the edge, the board
 * in the middle (it bends at the edges and shrinks to fit), your tiles along the bottom. Tap a
 * tile to see where it can go, then tap a glowing spot (or the tile again if there's only one).
 */
export class DominoesTable implements View {
  readonly landscape = false;
  readonly helpHtml =
    `<p><b>Dominoes (All Fives):</b> play a tile that matches an open end. After you play, if the open ends add up to a multiple of 5, you score that many. Nothing fits? You pass (or draw from the boneyard, when there is one).</p><p>Go out first to score everyone’s leftover pips, rounded to the nearest 5. First to ${DOMINOES_RULES.target} wins.</p><p><b>Controller:</b> left/right picks a tile, A plays it (left/right then chooses where), B cancels.</p>`;
  private el = $('dominoes-view');
  private view: DominoesView | null = null;
  private selected: TileId | null = null;
  /** Controller: choosing among several places for the selected tile. */
  private ghostIndex = -1;
  private pending = false;
  private scoresOpen = false;
  /** Between hands (and after the game): looking at the board instead of the scores. */
  private boardPeek = false;
  /** Sent "ready" and waiting to hear back. */
  private readySent = false;
  private speaking = new Set<string>();
  private cursor: TileId | null = null;
  private observer = new ResizeObserver(() => this.renderBoard());

  constructor(private shell: ShellApi) {
    this.el.hidden = false;
    this.el.innerHTML = `
      <div class="ht">
        <div class="ht-seat ht-pos-2"></div>
        <div class="ht-seat ht-pos-1"></div>
        <div class="ht-seat ht-pos-3"></div>
        <div class="ht-center">
          <div class="dm-board"><div class="dm-layout"></div><div class="dm-pop" hidden></div></div>
          <div class="ht-status" aria-live="polite">Shuffling…</div>
          <div class="dm-info"></div>
          <button class="btn btn-primary ht-action dm-draw" type="button" hidden></button>
          <button class="btn btn-primary ht-action dm-back" type="button" data-act="scores" hidden>Back to scores</button>
        </div>
        <div class="ht-mine"><div class="ht-seat ht-pos-0"></div><button class="ht-scores-btn" type="button">Scores</button></div>
        <div class="ht-hand dm-hand"></div>
        <div class="ht-overlay" hidden></div>
      </div>`;
    this.el.addEventListener('click', this.onClick);
    this.observer.observe(this.el.querySelector('.dm-board')!);
    shell.sfx.preloadSounds(CARD_SOUNDS);
  }

  onGameMessage(m: GameServerMessage) {
    if (m.t !== 'dominoes') return;
    const prev = this.view;
    this.view = m.view;
    this.pending = false;
    this.readySent = false;
    // A hand just ended (or the next began): show the scores first.
    if (!prev || prev.phase !== m.view.phase) this.boardPeek = false;
    if (this.selected && !m.view.tiles.includes(this.selected)) this.selected = null;
    if (m.view.turn !== m.view.seat) this.ghostIndex = -1;
    this.sounds(prev, m.view);
    this.render();
  }

  onSpeaking(aliases: Set<string>) {
    this.speaking = aliases;
    for (const el of this.el.querySelectorAll<HTMLElement>('.ht-seat[data-alias]')) el.classList.toggle('speaking', aliases.has(el.dataset.alias!));
  }

  resize() {
    this.renderBoard();
  }

  private pos(seat: number) {
    return (seat - (this.view?.seat ?? 0) + 4) % 4;
  }

  private name(seat: number) {
    return this.view!.seats[seat].name;
  }

  private myMoves(tile: TileId | null): Move[] {
    const v = this.view;
    if (!v || !tile) return [];
    return v.moves.filter((m) => m.tile === tile);
  }

  // ------------------------------------------------------------------ rendering

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
      if (s.away) tag = '<span class="ht-tag" title="Away: a bot is playing their tiles" aria-label="away, a bot is playing">💤</span>';
      el.innerHTML = `<div class="ht-name"><span class="dot" style="background:${colorCss(s.color)}"></span><span class="ht-nm">${escapeHtml(s.name)}</span></div>
        <div class="ht-score">${s.score} pts · ${s.tiles} tile${s.tiles === 1 ? '' : 's'} ${tag}</div>`;
      el.classList.toggle('turn', v.turn === seat);
      if (s.alias) el.dataset.alias = s.alias;
      else delete el.dataset.alias;
      el.classList.toggle('speaking', !!s.alias && this.speaking.has(s.alias));
    }

    const myTurn = v.phase === 'playing' && v.turn === v.seat && v.seat !== null;
    let text = '';
    if (v.seat === null) text = 'Watching. You’ll get a seat when one frees up.';
    else if (v.phase === 'playing') {
      if (myTurn && v.mustDraw) text = 'Nothing fits: draw a tile';
      else if (myTurn && !v.moves.length) text = 'Nothing fits: you pass';
      else if (myTurn) text = this.selected ? (this.myMoves(this.selected).length > 1 ? 'Tap where it goes' : 'Tap it again to play') : 'Your turn: pick a tile';
      else if (v.turn !== null) text = `Waiting for ${escapeHtml(this.name(v.turn))}…`;
    } else if (v.phase === 'handEnd') {
      const waiting = this.waitingFor();
      text = `Hand ${v.hand} is over.`;
      if (v.seat !== null && waiting.length === 1 && waiting[0] === v.seat) text += ' Everyone else is ready.';
    } else if (v.phase === 'gameOver') text = 'Game over.';
    q<HTMLElement>('.ht-status').innerHTML = text;
    // With every tile dealt there's no boneyard to mention.
    q<HTMLElement>('.dm-info').textContent = v.phase === 'playing' ? `Ends add up to ${v.count}${v.boneyard ? ` · Boneyard: ${v.boneyard}` : ''}` : '';

    const draw = q<HTMLButtonElement>('.dm-draw');
    draw.hidden = !(myTurn && v.mustDraw);
    draw.disabled = this.pending;
    draw.textContent = `Draw a tile (${v.boneyard} left)`;
    q<HTMLButtonElement>('.dm-back').hidden = !(this.boardPeek && v.phase !== 'playing');

    this.renderHand(myTurn);
    this.renderBoard();
    this.renderOverlay();
  }

  private renderHand(myTurn: boolean) {
    const v = this.view!;
    const hand = this.el.querySelector('.dm-hand') as HTMLElement;
    hand.classList.toggle('my-turn', myTurn);
    hand.innerHTML = `<div class="dm-hand-tiles">${v.tiles
      .map((t) => {
        const playable = v.moves.some((m) => m.tile === t);
        const cls = ['dm-tile', 'dm-mine', myTurn ? (playable ? 'legal' : 'illegal') : '', this.selected === t ? 'raised' : '', this.cursor === t ? 'pad-cursor' : ''].filter(Boolean).join(' ');
        return `<button type="button" class="${cls}" data-tile="${t}" aria-label="${t[0]} and ${t[2]}">${tileSvg(Number(t[0]), Number(t[2]), false)}</button>`;
      })
      .join('')}</div>`;
  }

  /** Lay the board out to fit the space it has, with glowing spots for the selected tile. */
  private renderBoard() {
    const v = this.view;
    const board = this.el.querySelector('.dm-board') as HTMLElement | null;
    if (!v || !board) return;
    const box = board.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const limits = limitsFor(box.width, box.height);
    const spots = layoutSpots(v.layout, limits);
    const ghosts: { spot: TileSpot; move: Move }[] = [];
    for (const move of this.myMoves(this.selected)) {
      const spot = ghostSpot(v.layout, move, v.seat ?? 0, limits);
      if (spot) ghosts.push({ spot, move });
    }
    const b = bounds([...spots, ...ghosts.map((g) => g.spot)]);
    const unitsW = b.maxX - b.minX + 1;
    const unitsH = b.maxY - b.minY + 1;
    const unit = Math.min(MAX_UNIT, box.width / unitsW, box.height / unitsH);
    const ox = (box.width - (b.maxX - b.minX) * unit) / 2 - b.minX * unit;
    const oy = (box.height - (b.maxY - b.minY) * unit) / 2 - b.minY * unit;
    const placeStyle = (s: TileSpot) => {
      const w = (s.horizontal ? 2 : 1) * unit;
      const h = (s.horizontal ? 1 : 2) * unit;
      return `left:${ox + s.x * unit - w / 2}px;top:${oy + s.y * unit - h / 2}px;width:${w}px;height:${h}px`;
    };
    const last = v.lastPlay?.tile;
    let html = spots.map((s) => `<div class="dm-tile dm-placed${s.tile === last ? ' dm-last' : ''}" style="${placeStyle(s)}">${tileSvg(s.first, s.second, s.horizontal)}</div>`).join('');
    html += ghosts
      .map(
        (g, i) =>
          `<button type="button" class="dm-ghost${i === this.ghostIndex ? ' pad-cursor' : ''}" style="${placeStyle(g.spot)}" data-arm="${g.move.arm}" aria-label="Play here">${tileSvg(g.spot.first, g.spot.second, g.spot.horizontal)}</button>`,
      )
      .join('');
    if (!spots.length && !ghosts.length) html = '<p class="dm-empty">The first tile goes here.</p>';
    (board.querySelector('.dm-layout') as HTMLElement).innerHTML = html;
  }

  private renderOverlay() {
    const v = this.view!;
    const box = this.el.querySelector('.ht-overlay') as HTMLElement;
    const show = v.phase === 'playing' ? this.scoresOpen : !this.boardPeek;
    box.hidden = !show;
    if (!show) return;
    let html = '<div class="ht-panel">';
    const res = v.result;
    if (v.phase === 'gameOver') {
      const youWon = v.seat !== null && v.winners.includes(v.seat);
      html += `<h2>${youWon ? 'You win!' : `${v.winners.map((i) => escapeHtml(this.name(i))).join(' & ')} ${v.winners.length > 1 ? 'win' : 'wins'}!`}</h2>`;
    } else if (v.phase === 'handEnd') {
      html += `<h2>Hand ${v.hand} done</h2>`;
    } else {
      html += '<h2>Scores</h2>';
    }
    if (res && v.phase !== 'playing') {
      const who = res.winner === null ? null : escapeHtml(this.name(res.winner));
      html += `<p class="dm-result">${
        res.blocked
          ? who
            ? `Nobody could play. ${who} had the lowest hand and scores <b>${res.points}</b>.`
            : 'Nobody could play, and the lowest hands tied: no points.'
          : `${who} went out and scores <b>${res.points}</b> for the tiles left.`
      }</p>`;
    }
    html += '<table class="ht-table"><thead><tr><th></th>';
    for (let s = 0; s < 4; s++) html += `<th><span class="dot" style="background:${colorCss(v.seats[s].color)}"></span>${escapeHtml(v.seats[s].name)}</th>`;
    html += '</tr></thead><tbody>';
    v.history.forEach((row, i) => {
      html += `<tr><td>Hand ${i + 1}</td>${row.map((n) => `<td>${n}</td>`).join('')}</tr>`;
    });
    html += `<tr class="ht-total"><td>Total</td>${v.seats.map((s) => `<td>${s.score}</td>`).join('')}</tr></tbody></table>`;
    html += `<p class="hint">First to ${v.target} wins.</p>`;
    if (v.phase === 'handEnd') {
      const wait = this.waitText();
      if (wait) html += `<p class="dm-wait">${wait}</p>`;
    }
    html += '<div class="actions">';
    if (v.phase === 'gameOver') {
      if (v.seat !== null) html += '<button class="btn btn-primary" data-act="again" type="button">New game</button>';
      html += '<button class="btn btn-secondary" data-act="board" type="button">See the board</button>';
      if (this.shell.isPrivate) html += '<button class="btn btn-secondary" data-act="lobby" type="button">Back to lobby</button>';
    } else if (v.phase === 'handEnd') {
      if (v.seat !== null && !v.ready.includes(v.seat)) {
        html += `<button class="btn btn-primary" data-act="ready" type="button"${this.readySent ? ' disabled' : ''}>Ready for hand ${v.hand + 1}</button>`;
      }
      html += '<button class="btn btn-secondary" data-act="board" type="button">See the board</button>';
    } else if (this.scoresOpen) {
      html += '<button class="btn btn-primary" data-act="close-scores" type="button">Close</button>';
    }
    html += '</div></div>';
    box.innerHTML = html;
  }

  /** Players at the table we're waiting on before the next hand (not bots, not anyone away). */
  private waitingFor(): number[] {
    const v = this.view!;
    return v.seats.flatMap((s, i) => (!s.bot && !s.away && !v.ready.includes(i) ? [i] : []));
  }

  /** Who's ready and who isn't, under the scores between hands. */
  private waitText(): string {
    const v = this.view!;
    const waiting = this.waitingFor();
    const mine = v.seat !== null && waiting.includes(v.seat);
    const others = waiting.filter((i) => i !== v.seat).map((i) => escapeHtml(this.name(i)));
    if (!mine) return others.length ? `Waiting for ${joinNames(others)}…` : '';
    if (!others.length) return 'Everyone else is ready.';
    const ready = v.ready.filter((i) => i !== v.seat).map((i) => escapeHtml(this.name(i)));
    return ready.length ? `${joinNames(ready)} ${ready.length > 1 ? 'are' : 'is'} ready.` : '';
  }

  private sounds(prev: DominoesView | null, v: DominoesView) {
    const play = (name: string) => this.shell.play(name);
    if (!prev || prev.hand !== v.hand) {
      play('cardDeal');
      return;
    }
    const lp = v.lastPlay;
    if (lp && (lp.tile !== prev.lastPlay?.tile || lp.seat !== prev.lastPlay?.seat)) {
      play('cardPlay');
      if (lp.points > 0) {
        play('trickTake');
        this.popPoints(lp.points, lp.seat);
      }
    }
    if (v.tiles.length > prev.tiles.length && v.hand === prev.hand) play('cardPass');
    if (prev.turn !== v.seat && v.turn === v.seat && v.seat !== null) play('yourTurn');
    if (prev.phase !== v.phase && (v.phase === 'handEnd' || v.phase === 'gameOver')) play(v.phase === 'gameOver' && v.seat !== null && v.winners.includes(v.seat) ? 'win' : 'handEnd');
  }

  /** A "+10" that floats up over the board when someone scores. */
  private popPoints(points: number, seat: number) {
    const pop = this.el.querySelector('.dm-pop') as HTMLElement;
    pop.textContent = `${seat === this.view?.seat ? 'You' : this.name(seat)} +${points}`;
    pop.hidden = false;
    pop.classList.remove('go');
    void pop.offsetWidth;
    pop.classList.add('go');
    window.setTimeout(() => (pop.hidden = true), 1600);
  }

  // ------------------------------------------------------------------ input

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
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
    if (act === 'board' || act === 'scores') {
      this.boardPeek = act === 'board';
      this.render();
      return;
    }
    if (act === 'close-scores') {
      this.scoresOpen = false;
      this.renderOverlay();
      return;
    }
    if (t.closest('.ht-scores-btn')) return this.toggleScores();
    if (t.closest('.dm-draw')) return this.draw();
    const ghost = t.closest<HTMLElement>('.dm-ghost');
    if (ghost && this.selected) return this.play(this.selected, ghost.dataset.arm!);
    const tile = t.closest<HTMLElement>('.dm-mine')?.dataset.tile;
    if (tile) this.tapTile(tile);
  };

  /** The Scores button: during a hand it opens the scores; between hands it flips between them and the board. */
  private toggleScores() {
    const v = this.view;
    if (!v) return;
    if (v.phase === 'playing') this.scoresOpen = !this.scoresOpen;
    else this.boardPeek = !this.boardPeek;
    this.render();
  }

  private tapTile(tile: TileId) {
    const v = this.view;
    if (!v || v.seat === null || this.pending) return;
    if (v.phase !== 'playing' || v.turn !== v.seat) {
      this.selected = this.selected === tile ? null : tile;
      this.render();
      return;
    }
    const moves = this.myMoves(tile);
    if (!moves.length) {
      this.shell.toast(v.mustDraw ? 'That doesn’t match an open end. Draw a tile.' : 'That doesn’t match an open end.');
      return;
    }
    // Second tap on a tile with just one place to go plays it.
    if (this.selected === tile && moves.length === 1) return this.play(tile, moves[0].arm);
    this.selected = tile;
    this.ghostIndex = -1;
    this.render();
  }

  private play(tile: TileId, arm: string) {
    this.pending = true;
    this.selected = null;
    this.ghostIndex = -1;
    this.shell.sendGame({ t: 'place', tile, arm });
  }

  private draw() {
    if (this.pending || !this.view?.mustDraw) return;
    this.pending = true;
    this.shell.sendGame({ t: 'draw' });
  }

  // ------------------------------------------------------------------ controller

  /** Left/right picks a tile, A selects it (then left/right picks where and A plays), Y draws, B cancels. */
  onPad(p: PadPress, down: boolean): boolean {
    if (!down || !this.view) return false;
    const v = this.view;
    const b = p.button;
    if (b === 'view') {
      this.toggleScores();
      return true;
    }
    if (this.padScope()) return false;
    if (b === 'y') {
      this.draw();
      return true;
    }
    const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    if (focused && !focused.closest('.dm-hand')) {
      if (b === 'down' && this.el.contains(focused)) {
        focused.blur();
        this.moveCursor(0);
        return true;
      }
      return false;
    }
    focused?.blur();
    const moves = this.myMoves(this.selected);
    if (this.selected && moves.length > 1) {
      // Choosing where the selected tile goes.
      if (b === 'left' || b === 'right' || b === 'up' || b === 'down') {
        const step = b === 'left' || b === 'up' ? -1 : 1;
        this.ghostIndex = this.ghostIndex < 0 ? 0 : (this.ghostIndex + step + moves.length) % moves.length;
        this.renderBoard();
        return true;
      }
      if (b === 'a' && this.ghostIndex >= 0) {
        this.play(this.selected, moves[this.ghostIndex].arm);
        return true;
      }
      if (b === 'b') {
        this.selected = null;
        this.ghostIndex = -1;
        this.render();
        return true;
      }
    }
    if (b === 'left' || b === 'right') {
      this.moveCursor(b === 'left' ? -1 : 1);
      return true;
    }
    if (b === 'a') {
      if (this.cursor && v.tiles.includes(this.cursor)) {
        this.tapTile(this.cursor);
        if (this.selected && this.myMoves(this.selected).length > 1) {
          this.ghostIndex = 0;
          this.renderBoard();
        }
      } else this.moveCursor(0);
      return true;
    }
    if (b === 'up') {
      const btn = this.el.querySelector<HTMLElement>('.dm-draw:not([hidden]), .dm-back:not([hidden]), .ht-scores-btn');
      if (btn) focusForPad(btn);
      return true;
    }
    return false;
  }

  private moveCursor(step: number) {
    const v = this.view;
    if (!v || !v.tiles.length) return;
    let i = this.cursor ? v.tiles.indexOf(this.cursor) : -1;
    if (i < 0) i = Math.max(0, v.tiles.findIndex((t) => v.moves.some((m) => m.tile === t)));
    else i = (i + step + v.tiles.length) % v.tiles.length;
    this.cursor = v.tiles[i];
    document.body.classList.add('pad-mode');
    this.renderHand(v.phase === 'playing' && v.turn === v.seat);
  }

  padOrigin() {
    const el = this.cursor ? this.el.querySelector(`.dm-mine[data-tile="${this.cursor}"]`) : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top };
  }

  padScope() {
    const o = this.el.querySelector('.ht-overlay') as HTMLElement | null;
    return o && !o.hidden ? o : null;
  }

  dispose() {
    this.observer.disconnect();
    this.el.removeEventListener('click', this.onClick);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
