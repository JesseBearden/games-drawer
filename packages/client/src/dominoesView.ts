import { DOMINO_SOUNDS, type SoundName } from './audio';
import { DOMINOES_RULES, type DominoesView, type GameServerMessage, type Move, type TileId } from '@tank/shared';
import { bounds, ghostSpot, layoutSpots, limitsFor, tileSvg, type TileSpot } from './dominoLayout';
import { seatFelts } from './felts';
import { focusForPad, type PadPress } from './gamepad';
import { patchHtml, syncKeyed, type KeyedItem } from './dom';
import { escapeHtml, nameHtml } from './html';
import { fitScoreTable, fitSeatText, scoreSheetHtml, seatNameHtml } from './heartsView';
import type { SafariGesture, ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Biggest a board unit (half a domino) gets, in pixels, before the layout fills the table. */
const MAX_UNIT = 40;
/** Zooming in goes until half a domino is this big (and always at least ZOOM_MIN_MAX times). */
const ZOOM_UNIT = 64;
const ZOOM_MIN_MAX = 1.6;
/** Each tap of Zoom in or Zoom out (or a controller shoulder button). */
const ZOOM_STEP = 1.5;
/** A finger or mouse has to move this far (px) before it drags the board instead of tapping. */
const DRAG_SLOP = 8;

/**
 * Dominoes (All Fives) on the shared card-table layout: opponents around the edge, the board
 * in the middle (it bends at the edges and shrinks to fit), your tiles along the bottom. Tap a
 * tile to see where it can go, then tap the spot on the board (tapping the tile again puts it back).
 */
export class DominoesTable implements View {
  readonly landscape = false;
  readonly helpHtml =
    `<p>All Fives: play a tile that matches an open end. After you play, if the open ends add up to a multiple of 5, you score that many. Nothing fits? You pass (or draw from the boneyard, when there is one).</p><p>Go out first to score everyone’s leftover pips, rounded to the nearest 5. First to ${DOMINOES_RULES.target} wins.</p><p>Board hard to read? Pinch it to zoom (on a computer, use the mouse wheel), then drag to look around.</p><p><b>Controller:</b> left/right picks a tile, A plays it (left/right then chooses where), B cancels. The shoulder buttons zoom.</p>`;
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
  private observer = new ResizeObserver(() => {
    this.renderBoard();
    this.fitSeats();
  });
  /** Board zoom: a scale and offset (px) on top of the fitted layout. 1 shows the whole board. */
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  /** The fitted board: its box and how big half a domino is, before zooming. */
  private boxW = 0;
  private boxH = 0;
  private popTimer: number | undefined;
  private fitUnit = MAX_UNIT;
  private hasTiles = false;
  /** Fingers (or the mouse) on the board, and the pinch or drag they started. */
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: { x: number; y: number; dist: number; zoom: number; panX: number; panY: number } | null = null;
  private dragging = false;
  /** Right after a drag or pinch, the click it ends with isn't a tap. */
  private noClickUntil = 0;

  constructor(private shell: ShellApi) {
    this.el.hidden = false;
    document.querySelector('#gd-stock image')?.setAttribute('href', '/art/card-stock.webp');
    this.el.innerHTML = `
      <div class="ht">
        <div class="ht-seat ht-pos-2"></div>
        <div class="ht-seat ht-pos-1"></div>
        <div class="ht-seat ht-pos-3"></div>
        <div class="ht-center">
          <div class="dm-board"><div class="dm-window"><div class="dm-layout"></div></div><div class="dm-pop" hidden></div></div>
          <div class="ht-status" aria-live="polite">Shuffling…</div>
          <button class="pc-btn pc-btn-main ht-action dm-draw" type="button" hidden></button>
        </div>
        <div class="ht-mine"><div class="ht-seat ht-pos-0"></div><button class="ht-scores-btn pc-btn pc-btn-plain" type="button">Scores</button></div>
        <div class="dm-side"><div class="ht-hand dm-hand"></div><div class="dm-info"></div></div>
        <div class="ht-overlay" hidden></div>
      </div>`;
    this.el.addEventListener('click', this.onClick);
    const board = this.board();
    board.addEventListener('pointerdown', this.onPointerDown);
    board.addEventListener('pointermove', this.onPointerMove);
    board.addEventListener('pointerup', this.onPointerUp);
    board.addEventListener('pointercancel', this.onPointerUp);
    board.addEventListener('wheel', this.onWheel, { passive: false });
    // Safari's own pinch (an iPad's trackpad or mouse; fingers too, which the pointer events
    // above already handle): zoom the board with it, never the whole page.
    board.addEventListener('gesturestart', this.onGestureStart);
    board.addEventListener('gesturechange', this.onGestureChange);
    board.addEventListener('gestureend', this.onGestureEnd);
    this.observer.observe(board);
    this.observer.observe(this.middle());
    shell.sfx.preloadSounds([...DOMINO_SOUNDS, 'yourTurn', 'handEnd']);
  }

  private board() {
    return this.el.querySelector('.dm-board') as HTMLElement;
  }

  /** The middle of the table: the board, and whatever shows under it. */
  private middle() {
    return this.el.querySelector('.ht-center') as HTMLElement;
  }

  onGameMessage(m: GameServerMessage) {
    if (m.t !== 'dominoes') return;
    const prev = this.view;
    this.view = m.view;
    this.pending = false;
    this.readySent = false;
    // A hand just ended (or the next began): show the scores first.
    if (!prev || prev.phase !== m.view.phase) this.boardPeek = false;
    // A new hand starts with the whole (empty) board in view.
    if (!prev || prev.hand !== m.view.hand) this.zoom = 1;
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

    let tagsChanged = false;
    const felts = seatFelts(v.seats);
    for (let seat = 0; seat < 4; seat++) {
      const s = v.seats[seat];
      const el = q<HTMLElement>(`.ht-pos-${this.pos(seat)}`);
      const changed = patchHtml(el, `${seatNameHtml(s.name, { bot: s.bot, away: s.away })}
        <div class="ht-score"><i>${s.score} pts</i> <i class="dm-tiles">· ${s.tiles} tile${s.tiles === 1 ? '' : 's'}</i></div>`);
      tagsChanged ||= changed;
      // Their own felt, the one their name has on Your table.
      el.dataset.felt = felts[seat];
      // With two or three playing, the empty seats' tags keep their place but don't show.
      el.style.visibility = s.playing ? '' : 'hidden';
      el.classList.toggle('turn', v.turn === seat);
      if (s.alias) el.dataset.alias = s.alias;
      else delete el.dataset.alias;
      el.classList.toggle('speaking', !!s.alias && this.speaking.has(s.alias));
    }
    if (tagsChanged) this.fitSeats();

    const myTurn = v.phase === 'playing' && v.turn === v.seat && v.seat !== null;
    let text = '';
    if (v.seat === null) text = 'Watching. You’ll get a seat when one frees up.';
    else if (v.phase === 'playing') {
      if (myTurn && v.mustDraw) text = 'Nothing fits: draw a tile';
      else if (myTurn && !v.moves.length) text = 'Nothing fits: you pass';
    } else if (v.phase === 'handEnd') {
      const waiting = this.waitingFor();
      text = `Hand ${v.hand} is over.`;
      if (v.seat !== null && waiting.length === 1 && waiting[0] === v.seat) text += ' Everyone else is ready.';
    } else if (v.phase === 'gameOver') text = 'Game over.';
    patchHtml(q<HTMLElement>('.ht-status'), text);
    // With every tile dealt there's no boneyard to mention. Two pieces: on a phone held sideways
    // they stack, in the narrow space beside your tiles.
    patchHtml(q<HTMLElement>('.dm-info'), v.phase === 'playing' ? `<span>Ends add up to ${v.count}</span>${v.boneyard ? `<span>Boneyard: ${v.boneyard}</span>` : ''}` : '');

    const draw = q<HTMLButtonElement>('.dm-draw');
    draw.hidden = !(myTurn && v.mustDraw);
    draw.disabled = this.pending;
    draw.textContent = `Draw a tile (${v.boneyard} left)`;
    // One button next to your name: Scores, or (looking at the board after a hand) Back to scores.
    const back = this.boardPeek && v.phase !== 'playing';
    const scoresBtn = q<HTMLButtonElement>('.ht-scores-btn');
    scoresBtn.textContent = back ? 'Back to scores' : 'Scores';
    scoresBtn.classList.toggle('pc-btn-main', back);
    scoresBtn.classList.toggle('pc-btn-plain', !back);

    this.renderHand(myTurn);
    this.renderBoard();
    this.renderOverlay();
  }

  private renderHand(myTurn: boolean) {
    const v = this.view!;
    const hand = this.el.querySelector('.dm-hand') as HTMLElement;
    hand.classList.toggle('my-turn', myTurn);
    let row = hand.querySelector<HTMLElement>('.dm-hand-tiles');
    if (!row) {
      row = document.createElement('div');
      row.className = 'dm-hand-tiles';
      hand.append(row);
    }
    syncKeyed(
      row,
      v.tiles.map((t) => {
        const playable = v.moves.some((m) => m.tile === t);
        const cls = ['dm-tile', 'dm-mine', myTurn ? (playable ? 'legal' : 'illegal') : '', this.selected === t ? 'raised' : '', this.cursor === t ? 'pad-cursor' : ''].filter(Boolean).join(' ');
        return {
          key: t,
          className: cls,
          make: () => `<button type="button" data-tile="${t}" aria-label="${t[0]} and ${t[2]}">${tileSvg(Number(t[0]), Number(t[2]), false)}</button>`,
        };
      }),
    );
  }

  /** Lay the board out to fit the space it has, with glowing spots for the selected tile. */
  private renderBoard() {
    const v = this.view;
    const board = this.el.querySelector('.dm-board') as HTMLElement | null;
    if (!v || !board) return;
    const box = board.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // Where the lines bend comes from the whole middle of the table, which keeps its shape when
    // "Nothing fits" and Draw take room under the board: the tiles only shrink, they don't refold.
    const middle = this.middle().getBoundingClientRect();
    const limits = limitsFor(middle.width, middle.height);
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
    this.boxW = box.width;
    this.boxH = box.height;
    this.fitUnit = unit;
    this.hasTiles = spots.length > 0;
    const ox = (box.width - (b.maxX - b.minX) * unit) / 2 - b.minX * unit;
    const oy = (box.height - (b.maxY - b.minY) * unit) / 2 - b.minY * unit;
    const placeStyle = (s: TileSpot) => {
      const w = (s.horizontal ? 2 : 1) * unit;
      const h = (s.horizontal ? 1 : 2) * unit;
      return `left:${ox + s.x * unit - w / 2}px;top:${oy + s.y * unit - h / 2}px;width:${w}px;height:${h}px`;
    };
    const last = v.lastPlay?.tile;
    // Drawn from the top of the table down, so each tile's shadow (which falls downward) tucks
    // under the tile below it, as if they lay flat side by side. In play order, a line growing
    // up drew each new tile over the last one, shadow and all (user, 2026-11-20).
    const byRow = [...spots].sort((a, b) => a.y - b.y || a.x - b.x);
    const items: KeyedItem[] = byRow.map((s) => ({
      // (Keyed by how it lies too: the board re-folds when its space changes.)
      key: `${s.tile} ${s.first} ${s.second} ${s.horizontal}`,
      className: `dm-tile dm-placed${s.tile === last ? ' dm-last' : ''}`,
      style: placeStyle(s),
      make: () => `<div>${tileSvg(s.first, s.second, s.horizontal)}</div>`,
    }));
    ghosts.forEach((g, i) =>
      items.push({
        key: `spot ${g.move.arm} ${g.spot.first} ${g.spot.second} ${g.spot.horizontal}`,
        className: `dm-ghost${g.spot.horizontal ? ' h' : ''}${i === this.ghostIndex ? ' pad-cursor' : ''}`,
        style: placeStyle(g.spot),
        make: () => `<button type="button" data-arm="${g.move.arm}" aria-label="Play here">${tileSvg(g.spot.first, g.spot.second, g.spot.horizontal)}</button>`,
      }),
    );
    if (!items.length) items.push({ key: 'empty', className: 'dm-empty', make: () => '<p>The first tile goes here.</p>' });
    syncKeyed(board.querySelector('.dm-layout')!, items);
    this.applyZoom();
    this.revealSpots(board);
  }

  /** The tile the board last moved to show the spots for (once per pick, so it never fights a drag). */
  private revealedFor: TileId | null = null;

  /**
   * Zoomed in, every place your picked tile can go may be off screen, with nothing pointing to it.
   * When that happens the board glides to show the first one (the zoom stays).
   */
  private revealSpots(board: HTMLElement) {
    if (!this.selected) {
      this.revealedFor = null;
      return;
    }
    if (this.zoom <= 1 || this.revealedFor === this.selected) return;
    const ghosts = [...board.querySelectorAll<HTMLElement>('.dm-ghost')];
    if (!ghosts.length) return;
    this.revealedFor = this.selected;
    const centre = (g: HTMLElement) => [g.offsetLeft + g.offsetWidth / 2, g.offsetTop + g.offsetHeight / 2];
    const seen = ghosts.some((g) => {
      const [cx, cy] = centre(g);
      const x = this.panX + this.zoom * cx;
      const y = this.panY + this.zoom * cy;
      return x > 0 && x < this.boxW && y > 0 && y < this.boxH;
    });
    if (seen) return;
    const [cx, cy] = centre(ghosts[0]);
    this.panX = this.boxW / 2 - this.zoom * cx;
    this.panY = this.boxH / 2 - this.zoom * cy;
    this.applyZoom();
  }

  /** Names and scores on one line each (see fitSeatText). */
  private fitSeats() {
    fitSeatText(this.el);
  }

  // ------------------------------------------------------------------ zoom

  private maxZoom() {
    return Math.max(ZOOM_MIN_MAX, ZOOM_UNIT / this.fitUnit);
  }

  /** Zoom to z, keeping the board point under (px, py) (board pixels) where it is. */
  private zoomAt(px: number, py: number, z: number) {
    z = Math.min(this.maxZoom(), Math.max(1, z));
    this.panX = px - ((px - this.panX) / this.zoom) * z;
    this.panY = py - ((py - this.panY) / this.zoom) * z;
    this.zoom = z;
    this.applyZoom();
  }

  private zoomStep(dir: 'in' | 'out') {
    this.zoomAt(this.boxW / 2, this.boxH / 2, dir === 'in' ? this.zoom * ZOOM_STEP : this.zoom / ZOOM_STEP);
  }

  /** Puts the zoom on the board, kept inside it: no panning off into nothing. */
  private applyZoom() {
    const board = this.board();
    if (!board) return;
    if (!this.hasTiles) this.zoom = 1;
    this.zoom = Math.min(this.maxZoom(), this.zoom);
    if (this.zoom < 1.02) {
      this.zoom = 1;
      this.panX = this.panY = 0;
    }
    this.panX = Math.min(0, Math.max(this.boxW * (1 - this.zoom), this.panX));
    this.panY = Math.min(0, Math.max(this.boxH * (1 - this.zoom), this.panY));
    const zoomed = this.zoom > 1;
    const layout = board.querySelector('.dm-layout') as HTMLElement;
    layout.style.transform = zoomed ? `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})` : '';
    layout.style.setProperty('--dm-zoom', String(this.zoom));
    board.classList.toggle('zoomed', zoomed);
    // Zoomed tiles carry on sideways past the board, out to the screen's edges, and fade there.
    if (zoomed) {
      const b = board.getBoundingClientRect();
      const v = this.el.getBoundingClientRect();
      board.style.setProperty('--fade-l', `${Math.max(0, b.left - v.left)}px`);
      board.style.setProperty('--fade-r', `${Math.max(0, v.right - b.right)}px`);
    }
    this.zoomTable(board);
  }

  /**
   * The table's cloth zooms and pans with the tiles, as if looking closer at a real table (the
   * felt look draws it from these: --felt-zoom, --felt-x, --felt-y on #game). A point of the
   * cloth that sat at x (from the game's left) now shows where the tiles' own point there went:
   * origin + pan + zoom * (x - origin), so the texture's offset is origin * (1 - zoom) + pan.
   */
  private zoomTable(board: HTMLElement) {
    const game = this.el.closest<HTMLElement>('#game');
    if (!game) return;
    if (this.zoom === 1) {
      game.style.removeProperty('--felt-zoom');
      game.style.removeProperty('--felt-x');
      game.style.removeProperty('--felt-y');
      return;
    }
    // The tiles' layer covers the board exactly (cards.css: .dm-window), so its origin is the board's.
    const g = game.getBoundingClientRect();
    const b = board.getBoundingClientRect();
    const ox = b.left - g.left;
    const oy = b.top - g.top;
    game.style.setProperty('--felt-zoom', String(this.zoom));
    game.style.setProperty('--felt-x', `${ox * (1 - this.zoom) + this.panX}px`);
    game.style.setProperty('--felt-y', `${oy * (1 - this.zoom) + this.panY}px`);
  }

  /** A trackpad pinch: the zoom it started from (null while fingers are doing it instead). */
  private padPinch: { zoom: number } | null = null;
  private hoverAt: { x: number; y: number } | null = null;

  private onGestureStart = (e: Event) => {
    e.preventDefault();
    this.padPinch = this.pointers.size === 0 && this.hasTiles ? { zoom: this.zoom } : null;
  };

  private onGestureChange = (e: Event) => {
    e.preventDefault();
    if (!this.padPinch || this.pointers.size > 0) return;
    const g = e as SafariGesture;
    const r = this.board().getBoundingClientRect();
    const x = g.clientX ?? this.hoverAt?.x ?? r.left + r.width / 2;
    const y = g.clientY ?? this.hoverAt?.y ?? r.top + r.height / 2;
    this.zoomAt(x - r.left, y - r.top, this.padPinch.zoom * g.scale);
  };

  private onGestureEnd = (e: Event) => {
    e.preventDefault();
    this.padPinch = null;
  };

  /** Where the pointers are, in board pixels: their middle, and how far apart the first two are. */
  private pointerSpread() {
    const r = this.board().getBoundingClientRect();
    const pts = [...this.pointers.values()];
    const x = pts.reduce((n, p) => n + p.x, 0) / pts.length - r.left;
    const y = pts.reduce((n, p) => n + p.y, 0) / pts.length - r.top;
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { x, y, dist };
  }

  private startGesture() {
    const { x, y, dist } = this.pointerSpread();
    this.gesture = { x, y, dist, zoom: this.zoom, panX: this.panX, panY: this.panY };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A first finger means nothing else is touching: forget any finger whose lift never arrived
    // (an iPhone can lose one when it's turned), or this touch would pinch instead of move.
    if (e.isPrimary) this.pointers.clear();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.startGesture();
  };

  private onPointerMove = (e: PointerEvent) => {
    this.hoverAt = { x: e.clientX, y: e.clientY };
    const g = this.gesture;
    if (!g || !this.pointers.has(e.pointerId)) return;
    // A mouse with no button down has been let go of (off the board, where we didn't hear it).
    if (e.pointerType === 'mouse' && e.buttons === 0) return this.onPointerUp(e);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = this.pointerSpread();
    if (this.pointers.size >= 2 && g.dist > 0) {
      // Pinch: zoom by how far the fingers spread, keeping the spot between them under them.
      this.startDrag(e);
      const z = Math.min(this.maxZoom(), Math.max(1, (g.zoom * now.dist) / g.dist));
      this.panX = now.x - ((g.x - g.panX) / g.zoom) * z;
      this.panY = now.y - ((g.y - g.panY) / g.zoom) * z;
      this.zoom = z;
      this.applyZoom();
      return;
    }
    // One finger (or the mouse) moves a zoomed-in board around.
    if (this.zoom <= 1) return;
    if (!this.dragging && Math.hypot(now.x - g.x, now.y - g.y) < DRAG_SLOP) return;
    this.startDrag(e);
    this.panX = g.panX + now.x - g.x;
    this.panY = g.panY + now.y - g.y;
    this.applyZoom();
  };

  private startDrag(e: PointerEvent) {
    if (this.dragging) return;
    this.dragging = true;
    this.board().classList.add('moving');
    try {
      this.board().setPointerCapture(e.pointerId);
    } catch {
      // The pointer may already be gone.
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.dragging) this.noClickUntil = performance.now() + 400;
    if (this.pointers.size) {
      // A finger lifted mid-pinch: the other one carries on dragging from here.
      this.startGesture();
      return;
    }
    this.gesture = null;
    this.dragging = false;
    this.board().classList.remove('moving');
  };

  /** Mouse wheel or trackpad pinch: zoom around the pointer. */
  private onWheel = (e: WheelEvent) => {
    if (!this.hasTiles) return;
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    const r = this.board().getBoundingClientRect();
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, this.zoom * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)));
  };

  private renderOverlay() {
    const v = this.view!;
    const box = this.el.querySelector('.ht-overlay') as HTMLElement;
    const show = v.phase === 'playing' ? this.scoresOpen : !this.boardPeek;
    box.hidden = !show;
    if (!show) return;
    let html = '<div class="ht-panel pc-sheet">';
    const res = v.result;
    if (v.phase === 'gameOver') {
      const youWon = v.seat !== null && v.winners.includes(v.seat);
      html += `<h2>${youWon ? 'You win!' : `${v.winners.map((i) => nameHtml(this.name(i))).join(' & ')} ${v.winners.length > 1 ? 'win' : 'wins'}!`}</h2>`;
    } else if (v.phase === 'handEnd') {
      html += `<h2>Hand ${v.hand} done</h2>`;
    } else {
      html += '<h2>Scores</h2>';
    }
    if (res && v.phase !== 'playing') {
      const who = res.winner === null ? null : nameHtml(this.name(res.winner));
      html += `<p class="dm-result">${
        res.blocked
          ? who
            ? `Nobody could play. ${who} had the lowest hand and scores <b>${res.points}</b>.`
            : 'Nobody could play, and the lowest hands tied: no points.'
          : `${who} went out and scores <b>${res.points}</b> for the tiles left.`
      }</p>`;
    }
    const rows = this.inPlay().map((s) => ({ label: escapeHtml(v.seats[s].name), history: v.history.map((h) => h[s]), total: v.seats[s].score }));
    html += scoreSheetHtml(rows, v.phase === 'handEnd' || v.phase === 'gameOver');
    html += `<p class="pc-small">First to ${v.target} wins.</p>`;
    if (v.phase === 'handEnd') {
      const wait = this.waitText();
      if (wait) html += `<p class="dm-wait">${wait}</p>`;
    }
    html += '<div class="actions">';
    if (v.phase === 'gameOver') {
      if (v.seat !== null) html += '<button class="pc-btn pc-btn-main" data-act="again" type="button">New game</button>';
      html += '<button class="pc-btn pc-btn-plain" data-act="board" type="button">See the board</button>';
      html += '<button class="pc-btn pc-btn-plain" data-act="lobby" type="button">Switch game</button>';
    } else if (v.phase === 'handEnd') {
      if (v.seat !== null && !v.ready.includes(v.seat)) {
        html += `<button class="pc-btn pc-btn-main" data-act="ready" type="button"${this.readySent ? ' disabled' : ''}>Ready for hand ${v.hand + 1}</button>`;
      }
      html += '<button class="pc-btn pc-btn-plain" data-act="board" type="button">See the board</button>';
    } else if (this.scoresOpen) {
      html += '<button class="pc-btn pc-btn-main" data-act="close-scores" type="button">Close</button>';
    }
    html += '</div></div>';
    patchHtml(box, html);
    fitScoreTable(box);
  }

  /** The seats playing this game, from yours round the table (two, three or four). */
  private inPlay(): number[] {
    const v = this.view!;
    return [0, 1, 2, 3].map((k) => ((v.seat ?? 0) + k) % 4).filter((s) => v.seats[s].playing);
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
    const others = waiting.filter((i) => i !== v.seat).map((i) => nameHtml(this.name(i)));
    if (!mine) return others.length ? `Waiting for ${joinNames(others)}…` : '';
    if (!others.length) return 'Everyone else is ready.';
    const ready = v.ready.filter((i) => i !== v.seat).map((i) => nameHtml(this.name(i)));
    return ready.length ? `${joinNames(ready)} ${ready.length > 1 ? 'are' : 'is'} ready.` : '';
  }

  private sounds(prev: DominoesView | null, v: DominoesView) {
    const play = (name: SoundName) => this.shell.play(name);
    if (!prev || prev.hand !== v.hand) {
      play('dominoShuffle');
      return;
    }
    const ended = prev.phase !== v.phase && (v.phase === 'handEnd' || v.phase === 'gameOver');
    // Anyone drawing from the boneyard, you or the others.
    if (v.boneyard < prev.boneyard) play('dominoDraw');
    const lp = v.lastPlay;
    if (lp && (lp.tile !== prev.lastPlay?.tile || lp.seat !== prev.lastPlay?.seat)) {
      // Going out: the last tile is slapped down.
      play(ended && v.result && !v.result.blocked ? 'dominoSlam' : 'dominoPlay');
      if (lp.points > 0) {
        play('dominoScore');
        this.popPoints(lp.points, lp.seat);
      }
    } else if (prev.phase === 'playing' && v.phase === 'playing' && prev.turn !== null && v.turn !== prev.turn) {
      // The turn moved on with nothing laid: they knocked on the table to pass.
      play('dominoKnock');
    }
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
    // A second score soon after the first gets its whole time too.
    clearTimeout(this.popTimer);
    this.popTimer = window.setTimeout(() => (pop.hidden = true), 1600);
  }

  // ------------------------------------------------------------------ input

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    // The end of a drag or pinch on the board isn't a tap on a tile.
    if (performance.now() < this.noClickUntil && t.closest('.dm-board')) return;
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
    // You play by tapping the spot on the board; tapping the picked tile again puts it back.
    if (this.selected === tile) {
      this.selected = null;
      this.ghostIndex = -1;
      this.render();
      return;
    }
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
    if (b === 'lb' || b === 'rb') {
      this.zoomStep(b === 'rb' ? 'in' : 'out');
      return true;
    }
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
    if (this.selected && moves.length) {
      // Choosing where the selected tile goes (A plays it there).
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
        if (this.selected && this.myMoves(this.selected).length) {
          this.ghostIndex = 0;
          this.renderBoard();
        }
      } else this.moveCursor(0);
      return true;
    }
    if (b === 'up') {
      const btn = this.el.querySelector<HTMLElement>('.dm-draw:not([hidden]), .ht-scores-btn');
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
    clearTimeout(this.popTimer);
    const game = this.el.closest<HTMLElement>('#game');
    for (const p of ['--felt-zoom', '--felt-x', '--felt-y']) game?.style.removeProperty(p);
    this.el.removeEventListener('click', this.onClick);
    const board = this.board();
    board.removeEventListener('pointerdown', this.onPointerDown);
    board.removeEventListener('pointermove', this.onPointerMove);
    board.removeEventListener('pointerup', this.onPointerUp);
    board.removeEventListener('pointercancel', this.onPointerUp);
    board.removeEventListener('wheel', this.onWheel);
    board.removeEventListener('gesturestart', this.onGestureStart);
    board.removeEventListener('gesturechange', this.onGestureChange);
    board.removeEventListener('gestureend', this.onGestureEnd);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
