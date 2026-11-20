import { CARD_SOUNDS } from './audio';
import {
  cutPuzzle,
  gridFor,
  PIECE_COUNTS,
  puzzleProgress,
  puzzleUntouched,
  PUZZLE_IMAGES,
  addLocalPuzzleImages,
  allPuzzleImages,
  parseLocalPuzzles,
  puzzleImage,
  TAB_REACH,
  tabCurve,
  tableBounds,
  type GameServerMessage,
  type PuzzlePhase,
  type PuzzleState,
  type PuzzleSummary,
  type TabShape,
} from '@tank/shared';
import { loupeZoom } from './loupe';
import { colorCss, escapeHtml } from './state';
import type { SafariGesture, ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SAVES_KEY = 'gd.puzzles';
/** Screen space the progress, toolbar and buttons cover: the table fits between them. */
const HUD = { top: 54, bottom: 64, side: 6 };
/**
 * Holding a piece near the screen's edge scrolls the table that way (so you can carry a piece
 * across while zoomed in): within EDGE_ZONE pixels of the edge (or the toolbars), up to
 * EDGE_SPEED pixels a second, slow at first and faster right at the edge.
 */
const EDGE_ZONE = 56;
const EDGE_SPEED = 460;
/**
 * A finger hides the piece it drags, so touch drags get help once the finger moves:
 * - 'loupe': a magnifier above the finger shows the piece and its neighbours. The piece stays
 *   under the finger, so you pick it up again right where you put it down.
 * - 'lift': the piece rides just above the finger instead. (Tried first: seeing it was nice,
 *   but after a drop it isn't under your finger any more. Kept in case it becomes a setting.)
 */
const TOUCH_AID = 'loupe' as 'loupe' | 'lift';
/** The magnifier's gap above the finger. (When it shows, and how much it enlarges: loupe.ts.) */
const LOUPE_GAP = 46;
/** Remembered per browser: '0' once you turn the magnifier off; and that you've been told what it is. */
const MAGNIFIER_KEY = 'gd.magnifier';
const MAGNIFIER_HINT_KEY = 'gd.magnifierHint';
/** The lift: the piece's bottom ends up LIFT_GAP pixels above the fingertip, gliding over LIFT_MS. */
const LIFT_MS = 140;
const LIFT_GAP = 36;
const LIFT_MAX = 170;

type Pt = [number, number];
type Seg = [Pt, Pt, Pt];

/** One tabbed (or straight) edge from A to B in board coordinates, as cubic Béziers. */
function edge(tab: TabShape | null, a: Pt, b: Pt, scale: number): Seg[] {
  if (!tab) return [[a, b, b]];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  // Out from the edge: to the left of walking from A to B (up, for a left-to-right edge).
  const nx = dy / len;
  const ny = -dx / len;
  const at = ([u, v]: Pt): Pt => [a[0] + u * dx + v * scale * nx, a[1] + u * dy + v * scale * ny];
  return tabCurve(tab).map((seg) => seg.map((p) => at(p as Pt)) as Seg);
}

/** The same curve walked the other way (the neighbouring piece's side of a shared edge). */
function reverse(segs: Seg[], start: Pt): Seg[] {
  const points = [start, ...segs.map((s) => s[2])];
  return segs.map((s, i) => [s[1], s[0], points[i]] as Seg).reverse();
}

interface PieceArt {
  canvas: HTMLCanvasElement;
  /** The outline, in board units relative to the bitmap's corner. */
  path: Path2D;
  /** The bitmap's size in board units (big pieces are stored at lower resolution). */
  w: number;
  h: number;
}

interface Saved {
  id: string;
  at: number;
}

function loadSaved(): Saved[] {
  try {
    const v = JSON.parse(localStorage.getItem(SAVES_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((s) => typeof s?.id === 'string') : [];
  } catch {
    return [];
  }
}

function remember(id: string) {
  try {
    const list = [{ id, at: Date.now() }, ...loadSaved().filter((s) => s.id !== id)].slice(0, 30);
    localStorage.setItem(SAVES_KEY, JSON.stringify(list));
  } catch {
    /* private mode: nothing to continue later */
  }
}

function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: forgotten next time */
  }
}

function forget(ids: string[]) {
  if (!ids.length) return;
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(loadSaved().filter((s) => !ids.includes(s.id))));
  } catch {
    /* nothing stored */
  }
}

/**
 * The jigsaw table. Pieces are cut from the picture once (each with its own tab shapes) and
 * drawn on a canvas you can pan and zoom. Dragging moves the piece straight away; the server
 * confirms on drop (and snaps it to neighbours that fit).
 */
export class JigsawTable implements View {
  readonly landscape = false;
  readonly helpHtml =
    '<p>Drag pieces around the table; when two fit together they snap and move as one. A group dropped where it belongs locks into the frame.</p><p>Scroll or pinch to zoom, drag the empty table to look around. <b>Edges</b> hides the middle pieces (just for you), <b>Tidy</b> spreads loose pieces back around the edges.</p><p>On a touch screen, a magnifier above your finger shows the piece you’re dragging. The magnifier button turns it off.</p><p>The puzzle saves as you go: pick it again any time under “Continue a puzzle”.</p>';
  private el = $('jigsaw-view');
  private phase: PuzzlePhase = 'setup';
  private state: PuzzleState | null = null;
  private held = new Map<number, string>();
  private saves: PuzzleSummary[] = [];
  private pickImage = PUZZLE_IMAGES[0].id;
  private pickCount: number = 100;

  // The table.
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private hitCtx = document.createElement('canvas').getContext('2d')!;
  private img: HTMLImageElement | null = null;
  private art: PieceArt[] = [];
  private artFor = '';
  private pad = 0;
  private groups = new Map<number, number[]>();
  /** Draw order of groups, bottom to top. */
  private order: number[] = [];
  private cam = { x: 0, y: 0, s: 1 };
  private dirty = true;
  private raf = 0;
  private edgesOnly = false;
  private cursors = new Map<string, { x: number; y: number; at: number }>();

  // Pointer state.
  private pointers = new Map<number, { x: number; y: number }>();
  private dragging: {
    g: number;
    piece: number;
    /** Where on the piece it was picked up (board units from its corner). */
    offX: number;
    offY: number;
    pointer: number;
    /** A finger (not a mouse or pen), and where it went down. */
    touch: boolean;
    downX: number;
    downY: number;
    /** When it started moving (a drag, not a tap), or null. */
    movedAt: number | null;
    /** How far (screen pixels) the piece lifts above the finger, with TOUCH_AID 'lift'. */
    lift: number;
  } | null = null;
  private loupe!: HTMLCanvasElement;
  private loupeCtx!: CanvasRenderingContext2D;
  /** A touch screen: the magnifier (and its button) are for fingers. */
  private touchScreen = matchMedia('(any-pointer: coarse)').matches;
  private magnifier = stored(MAGNIFIER_KEY) !== '0';
  private liftRaf = 0;
  /** A grab the server hasn't answered yet, and where the pieces were (to put back if refused). */
  private pendingGrab: { g: number; from: Map<number, Pt> } | null = null;
  private panning: { x: number; y: number; camX: number; camY: number } | null = null;
  private pinch: { dist: number; s: number; mid: Pt; cam: { x: number; y: number } } | null = null;
  /** A trackpad pinch (Safari's gesture events): the zoom it started from. */
  private gesture: { s: number } | null = null;
  /** Where the mouse or trackpad pointer last was over the board (a pinch zooms around it). */
  private hoverAt: { x: number; y: number } | null = null;
  private lastDragSent = 0;
  private lastCursorSent = 0;
  /** Where the dragging finger (or mouse) is, for scrolling while it holds still at an edge. */
  private dragPointer: { clientX: number; clientY: number } | null = null;
  private edgeRaf = 0;
  private edgeAt = 0;
  private observer: ResizeObserver;

  constructor(private shell: ShellApi) {
    this.el.hidden = false;
    this.el.innerHTML = `
      <div class="pz-setup" hidden></div>
      <div class="pz-play" hidden>
        <canvas class="pz-canvas"></canvas>
        <div class="pz-status"><b class="pz-pct">0%</b> <span class="pz-count"></span></div>
        <div class="pz-tools">
          <button class="pz-btn" type="button" data-pz="picture" aria-pressed="false">Picture</button>
          <button class="pz-btn" type="button" data-pz="edges" aria-pressed="false">Edges</button>
          <button class="pz-btn pz-touch" type="button" data-pz="loupe" aria-pressed="${this.magnifier}">Magnifier</button>
          <button class="pz-btn" type="button" data-pz="tidy">Tidy</button>
          <button class="pz-btn" type="button" data-pz="fit" aria-label="Fit the table on screen">Fit</button>
          <button class="pz-btn pz-zoom" type="button" data-pz="zoom-in" aria-label="Zoom in">＋</button>
          <button class="pz-btn pz-zoom" type="button" data-pz="zoom-out" aria-label="Zoom out">－</button>
        </div>
        <img class="pz-preview" alt="The finished picture" hidden />
        <div class="pz-loading" hidden>Cutting pieces…</div>
        <div class="pz-done" hidden></div>
        <canvas class="pz-loupe" aria-hidden="true"></canvas>
      </div>`;
    this.canvas = this.el.querySelector('.pz-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.loupe = this.el.querySelector('.pz-loupe') as HTMLCanvasElement;
    this.loupeCtx = this.loupe.getContext('2d')!;
    this.el.addEventListener('click', this.onClick);
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('gesturestart', this.onGestureStart);
    this.canvas.addEventListener('gesturechange', this.onGestureChange);
    this.canvas.addEventListener('gestureend', this.onGestureEnd);
    this.observer = new ResizeObserver(() => this.resizeCanvas());
    this.observer.observe(this.canvas);
    shell.sfx.preloadSounds(CARD_SOUNDS);
    // Pictures that live only on this computer (the git-ignored local-puzzles folder, served by
    // the dev server). A real build drops this whole block, so the hosted site never asks.
    if (import.meta.env.DEV) {
      void fetch('/puzzles/local/puzzles.json', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : []))
        .then((raw) => {
          const list = parseLocalPuzzles(raw);
          if (!list.length) return;
          addLocalPuzzleImages(list);
          if (this.phase === 'setup' && !this.el.hidden) this.renderSetup();
        })
        .catch(() => {});
    }
  }

  // ------------------------------------------------------------------ messages

  onGameMessage(m: GameServerMessage) {
    switch (m.t) {
      case 'pz-state': {
        const fresh = m.state?.id !== this.state?.id;
        this.phase = m.phase;
        this.state = m.state;
        this.held = new Map(m.held.map((h) => [h.g, h.by]));
        this.dragging = null;
        this.pendingGrab = null;
        this.stopEdgeScroll();
        if (m.state) remember(m.state.id);
        if (fresh) this.cursors.clear();
        this.rebuildGroups(true);
        this.show();
        if (m.phase === 'done' && !fresh) this.shell.play('win');
        return;
      }
      case 'pz-moved': {
        const s = this.state;
        if (!s) return;
        for (const [i, x, y, g] of m.pieces) Object.assign(s.pieces[i], { x, y, g });
        s.locked = m.locked;
        this.rebuildGroups(false);
        // What just moved sits on top (unless it went into the frame, which stays underneath).
        for (const g of new Set(m.pieces.map(([, , , g]) => g))) if (!s.locked.includes(g)) this.toTop(g);
        if (m.snapped) this.shell.play('cardPlay', { volume: 0.7 });
        this.updateStatus();
        this.invalidate();
        return;
      }
      case 'pz-held': {
        if (m.by) this.held.set(m.g, m.by);
        else if (m.by === null) this.held.delete(m.g);
        const pending = this.pendingGrab;
        if (pending?.g === m.g && m.by !== null) {
          this.pendingGrab = null;
          // Someone else has it (or it's locked in): put ours back where it was.
          if (m.by !== this.shell.alias) {
            for (const [i, [x, y]] of pending.from) Object.assign(this.state!.pieces[i], { x, y });
            if (this.dragging?.g === m.g) {
              this.dragging = null;
              this.stopEdgeScroll();
            }
            const who = this.shell.members().find((p) => p.id === m.by);
            this.shell.toast(who ? `${who.name} has that piece.` : 'That part is already in place.');
          }
        }
        this.invalidate();
        return;
      }
      case 'pz-drag': {
        const s = this.state;
        if (!s || this.dragging?.g === m.g) return;
        const p = s.pieces[m.piece];
        if (!p) return;
        this.moveGroup(p.g, m.x - p.x, m.y - p.y);
        this.toTop(p.g);
        // Their pointer rides along in the middle of the piece.
        this.cursors.set(m.by, { x: m.x + s.width / s.cols / 2, y: m.y + s.height / s.rows / 2, at: performance.now() });
        this.invalidate();
        return;
      }
      case 'pz-cursor':
        this.cursors.set(m.by, { x: m.x, y: m.y, at: performance.now() });
        this.invalidate();
        return;
      case 'pz-saves': {
        // Puzzles that no longer exist (nothing placed, or untouched for months) leave the list.
        forget(m.gone);
        const gone = new Set(m.gone);
        this.saves = m.saves.length ? m.saves : this.saves.filter((s) => !gone.has(s.id));
        if (this.phase === 'setup') this.renderSetup();
        return;
      }
    }
  }

  onMembers() {
    this.invalidate();
  }

  resize() {
    this.resizeCanvas();
  }

  // ------------------------------------------------------------------ screens

  private show() {
    const setup = this.el.querySelector('.pz-setup') as HTMLElement;
    const play = this.el.querySelector('.pz-play') as HTMLElement;
    setup.hidden = this.phase !== 'setup';
    play.hidden = this.phase === 'setup';
    this.el.dataset.phase = this.phase;
    if (this.phase === 'setup') {
      this.renderSetup();
      const ids = loadSaved().map((s) => s.id);
      if (ids.length) this.shell.sendGame({ t: 'pz-saves', ids });
      return;
    }
    void this.prepareArt();
    this.updateStatus();
    this.renderDone();
  }

  private renderSetup() {
    const img = allPuzzleImages().find((i) => i.id === this.pickImage) ?? PUZZLE_IMAGES[0];
    let html = '<div class="pz-setup-card"><h2>Jigsaw puzzle</h2>';
    // People coming back want their puzzle first.
    if (this.saves.length) {
      html += '<h3>Continue a puzzle</h3><ul class="pz-saves">';
      for (const s of [...this.saves].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const when = new Date(s.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
        html += `<li><img src="${escapeHtml(puzzleImage(s.image)?.thumb ?? s.imageFile)}" alt="" loading="lazy" /><span><b>${escapeHtml(puzzleImage(s.image)?.title ?? s.title)}</b><small>${s.pieces} pieces · ${s.done ? 'finished' : `${Math.round(s.progress * 100)}% done`} · ${when}</small></span><button type="button" class="pc-btn pc-btn-plain" data-resume="${s.id}">${s.done ? 'Look again' : 'Continue'}</button><button type="button" class="pz-forget" data-forget="${s.id}" aria-label="Remove ${escapeHtml(s.title)} from your list" title="Remove from your list">Remove</button></li>`;
      }
      html += '</ul><h3>Or start a new one</h3>';
    }
    html += '<h4>How many pieces?</h4><div class="pz-counts">';
    for (const n of PIECE_COUNTS) {
      const g = gridFor(img.width, img.height, n);
      html += `<button type="button" class="pz-btn${n === this.pickCount ? ' picked' : ''}" data-count="${n}" title="${g.cols * g.rows} pieces">${n}</button>`;
    }
    html += '</div><h4>Choose a puzzle</h4><div class="pz-images">';
    for (const i of allPuzzleImages()) {
      html += `<button type="button" class="pz-image${i.id === img.id ? ' picked' : ''}" data-image="${i.id}"><img src="${i.thumb}" alt="" loading="lazy" /><span>${escapeHtml(i.title)}</span></button>`;
    }
    // The grid has to fit the picture, so the real count is close to the one picked.
    const grid = gridFor(img.width, img.height, this.pickCount);
    html += '</div><div class="pz-start-bar">';
    html += `<p class="pc-small pz-grid"><b>${escapeHtml(img.title)}</b>: ${grid.cols * grid.rows} pieces, ${grid.cols} across and ${grid.rows} down.</p>`;
    html += '<button type="button" class="pc-btn pc-btn-main pc-btn-big pz-start" data-pz="start">Start puzzle</button>';
    html += `<p class="pc-small">Anyone at the table can pick. ${escapeHtml(img.credit)}.</p></div></div>`;
    (this.el.querySelector('.pz-setup') as HTMLElement).innerHTML = html;
  }

  /**
   * Take a puzzle off your "Continue" list. Only yours: friends who worked on it keep it (and
   * the save is deleted for good after 90 days untouched).
   */
  private forgetSave(id: string) {
    const s = this.saves.find((x) => x.id === id);
    if (s && !s.done && s.progress > 0) {
      const pct = Math.round(s.progress * 100);
      if (!confirm(`Take “${s.title}” (${s.pieces} pieces, ${pct}% done) off your list? Friends who worked on it can still continue it.`)) return;
    }
    forget([id]);
    this.saves = this.saves.filter((x) => x.id !== id);
    this.renderSetup();
  }

  private updateStatus() {
    const s = this.state;
    if (!s) return;
    (this.el.querySelector('.pz-pct') as HTMLElement).textContent = `${Math.round(puzzleProgress(s.pieces, s.locked) * 100)}%`;
    (this.el.querySelector('.pz-count') as HTMLElement).textContent = `${s.pieces.length} pieces · ${s.title}`;
  }

  private renderDone() {
    const box = this.el.querySelector('.pz-done') as HTMLElement;
    const s = this.state;
    box.hidden = this.phase !== 'done' || !s;
    if (box.hidden || !s) return;
    const minutes = Math.max(1, Math.round(((s.doneAt ?? s.updatedAt) - s.createdAt) / 60_000));
    box.innerHTML = `<b>Finished!</b> ${s.pieces.length} pieces in ${minutes} minute${minutes === 1 ? '' : 's'}. <button type="button" class="pc-btn pc-btn-main" data-pz="setup">New puzzle</button>`;
  }

  // ------------------------------------------------------------------ cutting the pieces

  /** Load the picture and cut every piece into its own little image (in batches, to stay smooth). */
  private async prepareArt() {
    const s = this.state;
    if (!s) return;
    const key = `${s.id}:${s.seed}`;
    if (this.artFor === key) {
      this.fit();
      return;
    }
    this.artFor = key;
    this.art = [];
    const loading = this.el.querySelector('.pz-loading') as HTMLElement;
    loading.hidden = false;
    const img = new Image();
    img.src = s.imageFile;
    try {
      await img.decode();
    } catch {
      loading.textContent = 'Couldn’t load the picture.';
      return;
    }
    if (this.artFor !== key) return;
    this.img = img;
    (this.el.querySelector('.pz-preview') as HTMLImageElement).src = s.imageFile;
    const cut = cutPuzzle(s.cols, s.rows, s.seed);
    const pw = s.width / s.cols;
    const ph = s.height / s.rows;
    const short = Math.min(pw, ph);
    this.pad = Math.ceil(TAB_REACH * short) + 2;
    const sx = img.naturalWidth / s.width;
    const sy = img.naturalHeight / s.height;
    for (let i = 0; i < s.pieces.length; i++) {
      if (this.artFor !== key) return;
      this.art.push(this.cutPiece(i, cut, pw, ph, short, sx, sy));
      if (i % 120 === 119) {
        loading.textContent = `Cutting pieces… ${Math.round((i / s.pieces.length) * 100)}%`;
        await new Promise((r) => setTimeout(r));
      }
    }
    loading.hidden = true;
    loading.textContent = 'Cutting pieces…';
    this.fit();
  }

  private cutPiece(i: number, cut: ReturnType<typeof cutPuzzle>, pw: number, ph: number, short: number, sx: number, sy: number): PieceArt {
    const s = this.state!;
    const r = Math.floor(i / s.cols);
    const c = i % s.cols;
    const x0 = c * pw;
    const y0 = r * ph;
    const tl: Pt = [x0, y0];
    const tr: Pt = [x0 + pw, y0];
    const br: Pt = [x0 + pw, y0 + ph];
    const bl: Pt = [x0, y0 + ph];
    const segs: Seg[] = [
      ...edge(r > 0 ? cut.horizontal[(r - 1) * s.cols + c] : null, tl, tr, short),
      ...edge(c < s.cols - 1 ? cut.vertical[r * (s.cols - 1) + c] : null, tr, br, short),
      ...(r < s.rows - 1 ? reverse(edge(cut.horizontal[r * s.cols + c], bl, br, short), bl) : edge(null, br, bl, short)),
      ...(c > 0 ? reverse(edge(cut.vertical[r * (s.cols - 1) + (c - 1)], tl, bl, short), tl) : edge(null, bl, tl, short)),
    ];
    const ox = x0 - this.pad;
    const oy = y0 - this.pad;
    const path = new Path2D();
    path.moveTo(tl[0] - ox, tl[1] - oy);
    for (const [c1, c2, e] of segs) path.bezierCurveTo(c1[0] - ox, c1[1] - oy, c2[0] - ox, c2[1] - oy, e[0] - ox, e[1] - oy);
    path.closePath();
    // Big pieces (a 6-piece puzzle) don't need every pixel of the photo: cap the bitmap size.
    const k = Math.min(1, 400 / short);
    const w = pw + this.pad * 2;
    const h = ph + this.pad * 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * k);
    canvas.height = Math.ceil(h * k);
    const g = canvas.getContext('2d')!;
    g.scale(k, k);
    g.save();
    g.clip(path);
    g.drawImage(this.img!, ox * sx, oy * sy, w * sx, h * sy, 0, 0, w, h);
    g.restore();
    // A thin dark edge and a light one just inside, so pieces read as pieces.
    g.lineWidth = Math.max(1, short * 0.025);
    g.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    g.stroke(path);
    g.save();
    g.clip(path);
    g.translate(short * 0.012, short * 0.012);
    g.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    g.lineWidth = Math.max(1, short * 0.018);
    g.stroke(path);
    g.restore();
    return { canvas, path, w, h };
  }

  // ------------------------------------------------------------------ groups

  private rebuildGroups(resetOrder: boolean) {
    const s = this.state;
    this.groups.clear();
    if (!s) return;
    s.pieces.forEach((p, i) => {
      const list = this.groups.get(p.g);
      if (list) list.push(i);
      else this.groups.set(p.g, [i]);
    });
    if (resetOrder) this.order = [...this.groups.keys()];
    else {
      const known = new Set(this.order);
      this.order = this.order.filter((g) => this.groups.has(g));
      for (const g of this.groups.keys()) if (!known.has(g)) this.order.push(g);
    }
    // Pieces locked into the frame sit underneath everything.
    const locked = new Set(s.locked);
    this.order.sort((a, b) => Number(locked.has(b)) - Number(locked.has(a)));
    this.invalidate();
  }

  private toTop(g: number) {
    this.order = [...this.order.filter((x) => x !== g), g];
  }

  private moveGroup(g: number, dx: number, dy: number) {
    for (const i of this.groups.get(g) ?? []) {
      const p = this.state!.pieces[i];
      p.x += dx;
      p.y += dy;
    }
  }

  private isEdge(i: number) {
    const s = this.state!;
    const r = Math.floor(i / s.cols);
    const c = i % s.cols;
    return r === 0 || c === 0 || r === s.rows - 1 || c === s.cols - 1;
  }

  /** With "Edges" on, loose middle pieces are hidden (for you only). */
  private hidden(g: number) {
    if (!this.edgesOnly) return false;
    const list = this.groups.get(g)!;
    return list.length === 1 && !this.state!.locked.includes(g) && !this.isEdge(list[0]);
  }

  // ------------------------------------------------------------------ camera

  private resizeCanvas() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // A new screen size (rotating a phone): stay zoomed sensibly and on the table.
    if (this.state && this.art.length) {
      const { min, max } = this.zoomRange();
      this.cam.s = Math.min(max, Math.max(min, this.cam.s));
      this.clampCam();
    }
    this.invalidate();
  }

  /**
   * The room the status tag (top) and the tools strip (bottom) take over the table, measured
   * (the strip wraps onto two rows on phones), plus a little air. HUD is the least it allows.
   */
  private hud() {
    const c = this.canvas.getBoundingClientRect();
    const status = this.el.querySelector('.pz-status')?.getBoundingClientRect();
    const tools = this.el.querySelector('.pz-tools')?.getBoundingClientRect();
    const top = status?.height ? Math.max(HUD.top, status.bottom - c.top + 10) : HUD.top;
    const bottom = tools?.height ? Math.max(HUD.bottom, c.bottom - tools.top + 10) : HUD.bottom;
    return { top, bottom, side: HUD.side };
  }

  /** The zoom that shows the whole table between the status tag and the tools. */
  private fitScale() {
    const s = this.state!;
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    const hud = this.hud();
    const w = Math.max(1, this.canvas.clientWidth - hud.side * 2);
    const h = Math.max(1, this.canvas.clientHeight - hud.top - hud.bottom);
    return Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY));
  }

  /**
   * How far you can zoom: out to a little past the whole table, in until a piece is about
   * 220 pixels across (or 3x the whole-table view, for puzzles with big pieces).
   */
  private zoomRange() {
    const s = this.state!;
    const fit = this.fitScale();
    const short = Math.min(s.width / s.cols, s.height / s.rows);
    return { min: fit * 0.85, max: Math.max(fit * 3, 220 / short) };
  }

  /**
   * Keep the table on screen: you can look around it, but not off into empty space. When it's
   * smaller than the screen, it stays in the middle.
   */
  private clampCam() {
    const s = this.state;
    if (!s) return;
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    const k = this.cam.s;
    const axis = (pos: number, lo: number, hi: number, before: number, after: number, view: number) => {
      const min = lo - before / k;
      const max = hi + after / k - view / k;
      return min <= max ? Math.min(max, Math.max(min, pos)) : (min + max) / 2;
    };
    const hud = this.hud();
    this.cam.x = axis(this.cam.x, b.minX, b.maxX, hud.side, hud.side, this.canvas.clientWidth);
    this.cam.y = axis(this.cam.y, b.minY, b.maxY, hud.top, hud.bottom, this.canvas.clientHeight);
  }

  private fit() {
    if (!this.state) return;
    this.cam.s = this.fitScale();
    this.clampCam();
    this.invalidate();
  }

  // ------------------------------------------------------------------ the magnifier

  private magnifierOn() {
    return TOUCH_AID === 'loupe' && this.touchScreen && this.magnifier;
  }

  /** The magnifier's radius on this screen. */
  private loupeRadius() {
    return Math.round(Math.min(100, Math.max(68, Math.min(this.canvas.clientWidth, this.canvas.clientHeight) * 0.21)));
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    if (!this.state) return;
    const { min, max } = this.zoomRange();
    const next = Math.min(max, Math.max(min, this.cam.s * factor));
    const bx = this.cam.x + sx / this.cam.s;
    const by = this.cam.y + sy / this.cam.s;
    this.cam.s = next;
    this.cam.x = bx - sx / next;
    this.cam.y = by - sy / next;
    this.clampCam();
    this.invalidate();
  }

  private toBoard(e: { clientX: number; clientY: number }): Pt {
    const r = this.canvas.getBoundingClientRect();
    return [this.cam.x + (e.clientX - r.left) / this.cam.s, this.cam.y + (e.clientY - r.top) / this.cam.s];
  }

  // ------------------------------------------------------------------ drawing

  private invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw() {
    const s = this.state;
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawLoupe(dpr);
    if (!s || this.phase === 'setup') return;
    const k = this.cam.s * dpr;
    ctx.setTransform(k, 0, 0, k, -this.cam.x * k, -this.cam.y * k);
    // Where the view is (browser tests use it to find pieces on screen).
    this.canvas.dataset.cam = `${this.cam.x},${this.cam.y},${this.cam.s}`;
    const view = {
      x0: this.cam.x,
      y0: this.cam.y,
      x1: this.cam.x + this.canvas.clientWidth / this.cam.s,
      y1: this.cam.y + this.canvas.clientHeight / this.cam.s,
    };
    if (!this.drawTable(ctx, this.cam.s, dpr, view)) return;
    // Everyone else's pointer, with their name.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = performance.now();
    let fading = false;
    for (const [alias, c] of this.cursors) {
      const age = now - c.at;
      if (age > 6000 || alias === this.shell.alias) continue;
      const member = this.shell.members().find((m) => m.id === alias);
      if (!member) continue;
      const x = (c.x - this.cam.x) * this.cam.s;
      const y = (c.y - this.cam.y) * this.cam.s;
      ctx.globalAlpha = age > 4000 ? 1 - (age - 4000) / 2000 : 1;
      if (age > 4000) fading = true;
      ctx.fillStyle = colorCss(member.color);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      // Their name in ink with a paper-coloured edge, readable on the mat and on pieces.
      ctx.font = '800 13px "Atkinson Hyperlegible Next", system-ui, sans-serif';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255, 252, 245, 0.95)';
      ctx.strokeText(member.name, x + 11, y + 4);
      ctx.fillStyle = '#112875';
      ctx.fillText(member.name, x + 11, y + 4);
      ctx.globalAlpha = 1;
    }
    if (fading) this.invalidate();
  }

  /**
   * The table, the frame where the finished puzzle goes, and the pieces, at `zoom` screen pixels
   * per board unit (the caller sets the transform). Pieces outside `view` (board units) are
   * skipped. False if the pieces aren't cut yet.
   */
  private drawTable(ctx: CanvasRenderingContext2D, zoom: number, dpr: number, view: { x0: number; y0: number; x1: number; y1: number }) {
    const s = this.state!;
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    // On the blue mat (the page shows through): the area pieces can go a shade darker, and the
    // frame where the finished picture goes a sheet of cream paper with a dashed ink edge.
    ctx.fillStyle = 'rgba(17, 40, 117, 0.06)';
    ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    ctx.fillStyle = 'rgba(255, 252, 245, 0.8)';
    ctx.fillRect(0, 0, s.width, s.height);
    ctx.setLineDash([8 / zoom, 6 / zoom]);
    ctx.strokeStyle = 'rgba(17, 40, 117, 0.4)';
    ctx.lineWidth = 2 / zoom;
    ctx.strokeRect(0, 0, s.width, s.height);
    ctx.setLineDash([]);
    if (this.art.length !== s.pieces.length) return false;
    // A little extra room for the held piece's shadow.
    const margin = 30 / zoom;
    const seen = (i: number) => {
      const p = s.pieces[i];
      const a = this.art[i];
      const x = p.x - this.pad;
      const y = p.y - this.pad;
      return x < view.x1 + margin && y < view.y1 + margin && x + a.w > view.x0 - margin && y + a.h > view.y0 - margin;
    };
    const colorOf = (alias: string) => colorCss(this.shell.members().find((m) => m.id === alias)?.color ?? 0);
    for (const g of this.order) {
      if (this.hidden(g)) continue;
      const list = this.groups.get(g)?.filter(seen);
      if (!list?.length) continue;
      // The piece in your hand casts a soft shadow, so it looks picked up. (Shadows first, then
      // the pieces, so a group's shadows don't fall across its own seams.)
      if (this.dragging?.g === g && list.length <= 40) {
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = 14 * dpr;
        ctx.shadowOffsetY = 6 * dpr;
        for (const i of list) {
          const p = s.pieces[i];
          const a = this.art[i];
          ctx.drawImage(a.canvas, p.x - this.pad, p.y - this.pad, a.w, a.h);
        }
        ctx.restore();
      }
      for (const i of list) {
        const p = s.pieces[i];
        const a = this.art[i];
        ctx.drawImage(a.canvas, p.x - this.pad, p.y - this.pad, a.w, a.h);
      }
      // Someone else holding it: outline it in their colour.
      const by = this.held.get(g);
      if (by && by !== this.shell.alias) {
        ctx.strokeStyle = colorOf(by);
        ctx.lineWidth = 3 / zoom;
        for (const i of list) {
          const p = s.pieces[i];
          ctx.save();
          ctx.translate(p.x - this.pad, p.y - this.pad);
          ctx.stroke(this.art[i].path);
          ctx.restore();
        }
      }
    }
    return true;
  }

  /**
   * Where the magnifier goes while a finger drags a single piece, and what it shows: centred on
   * the piece, zoomed so it and the edges of its neighbours fit (see loupeZoom). It always sits
   * straight above the finger, like a phone's text magnifier, and near the top of the screen it
   * simply slides off the top (nothing scrolls or jumps). Null when there's no magnifier.
   */
  private loupeView() {
    const d = this.dragging;
    const s = this.state;
    const at = this.dragPointer;
    if (!this.magnifierOn() || !d?.touch || d.movedAt === null || !s || !at) return null;
    if (this.phase === 'setup' || this.art.length !== s.pieces.length) return null;
    // Single pieces only: a group of pieces is too big for a finger to hide, so the magnifier
    // would just be in the way.
    if ((this.groups.get(d.g)?.length ?? 1) > 1) return null;
    const r = this.loupeRadius();
    const pw = s.width / s.cols;
    const ph = s.height / s.rows;
    const zoom = loupeZoom(pw, ph, TAB_REACH * Math.min(pw, ph), this.cam.s, r);
    if (zoom === null) return null;
    const box = this.canvas.getBoundingClientRect();
    const fx = at.clientX - box.left;
    const fy = at.clientY - box.top;
    const cx = Math.min(this.canvas.clientWidth - r - 6, Math.max(r + 6, fx));
    const cy = fy - LOUPE_GAP - r;
    const p = s.pieces[d.piece];
    return { cx, cy, r, bx: p.x + pw / 2, by: p.y + ph / 2, zoom };
  }

  private drawLoupe(dpr: number) {
    const el = this.loupe;
    const v = this.loupeView();
    if (!v) {
      el.classList.remove('on');
      return;
    }
    // The first time, say what it is (it's a surprise otherwise).
    if (!el.classList.contains('on') && !stored(MAGNIFIER_HINT_KEY)) {
      store(MAGNIFIER_HINT_KEY, '1');
      this.shell.toast('That’s the magnifier: it shows the piece under your finger. The Magnifier button turns it off.');
    }
    const size = v.r * 2;
    const px = Math.round(size * dpr);
    if (el.width !== px) {
      el.width = px;
      el.height = px;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
    }
    el.style.left = `${v.cx - v.r}px`;
    el.style.top = `${v.cy - v.r}px`;
    // What it shows (browser tests check it): the board point in the middle, and the zoom.
    el.dataset.at = `${v.bx},${v.by},${v.zoom}`;
    el.classList.add('on');
    const g = this.loupeCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#e5eff6'; // the mat
    g.fillRect(0, 0, px, px);
    const k = v.zoom * dpr;
    g.setTransform(k, 0, 0, k, (v.r - v.bx * v.zoom) * dpr, (v.r - v.by * v.zoom) * dpr);
    const half = v.r / v.zoom;
    this.drawTable(g, v.zoom, dpr, { x0: v.bx - half, y0: v.by - half, x1: v.bx + half, y1: v.by + half });
  }

  // ------------------------------------------------------------------ input

  /** The topmost piece under a board point (the precise shape, not just its box). */
  private pieceAt(x: number, y: number): number | null {
    const s = this.state!;
    if (this.art.length !== s.pieces.length) return null;
    for (let k = this.order.length - 1; k >= 0; k--) {
      const g = this.order[k];
      if (this.hidden(g)) continue;
      for (const i of this.groups.get(g) ?? []) {
        const p = s.pieces[i];
        const lx = x - (p.x - this.pad);
        const ly = y - (p.y - this.pad);
        const a = this.art[i];
        if (lx < 0 || ly < 0 || lx > a.w || ly > a.h) continue;
        if (this.hitCtx.isPointInPath(a.path, lx, ly)) return i;
      }
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.state || this.phase === 'setup') return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer already went away */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && !this.dragging) {
      // Two fingers: pinch to zoom (and move).
      const [p1, p2] = [...this.pointers.values()];
      const r = this.canvas.getBoundingClientRect();
      this.panning = null;
      this.pinch = { dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), s: this.cam.s, mid: [(p1.x + p2.x) / 2 - r.left, (p1.y + p2.y) / 2 - r.top], cam: { ...this.cam } };
      return;
    }
    if (this.pointers.size > 1) return;
    const [bx, by] = this.toBoard(e);
    const i = this.phase === 'playing' ? this.pieceAt(bx, by) : null;
    const s = this.state;
    if (i !== null) {
      const g = s.pieces[i].g;
      const holder = this.held.get(g);
      if (s.locked.includes(g) || (holder && holder !== this.shell.alias)) {
        this.startPan(e);
        return;
      }
      const from = new Map<number, Pt>();
      for (const k of this.groups.get(g)!) from.set(k, [s.pieces[k].x, s.pieces[k].y]);
      const offY = by - s.pieces[i].y;
      this.dragging = {
        g,
        piece: i,
        offX: bx - s.pieces[i].x,
        offY,
        pointer: e.pointerId,
        touch: e.pointerType === 'touch',
        downX: e.clientX,
        downY: e.clientY,
        movedAt: null,
        lift: e.pointerType === 'touch' && TOUCH_AID === 'lift' ? this.liftFor(offY) : 0,
      };
      this.pendingGrab = { g, from };
      this.toTop(g);
      this.shell.sendGame({ t: 'pz-grab', piece: i });
      this.invalidate();
      return;
    }
    this.startPan(e);
  };

  private startPan(e: PointerEvent) {
    this.panning = { x: e.clientX, y: e.clientY, camX: this.cam.x, camY: this.cam.y };
  }

  private onMove = (e: PointerEvent) => {
    this.hoverAt = { x: e.clientX, y: e.clientY };
    if (!this.state) return;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();
    if (this.pinch && this.pointers.size >= 2) {
      const [p1, p2] = [...this.pointers.values()];
      const ratio = Math.hypot(p1.x - p2.x, p1.y - p2.y) / Math.max(1, this.pinch.dist);
      const r = this.canvas.getBoundingClientRect();
      const mid: Pt = [(p1.x + p2.x) / 2 - r.left, (p1.y + p2.y) / 2 - r.top];
      // Keep the board point under the starting midpoint under the fingers.
      const bx = this.pinch.cam.x + this.pinch.mid[0] / this.pinch.s;
      const by = this.pinch.cam.y + this.pinch.mid[1] / this.pinch.s;
      const { min, max } = this.zoomRange();
      this.cam.s = Math.min(max, Math.max(min, this.pinch.s * ratio));
      this.cam.x = bx - mid[0] / this.cam.s;
      this.cam.y = by - mid[1] / this.cam.s;
      this.clampCam();
      this.invalidate();
      return;
    }
    if (this.dragging) {
      // Only the finger (or mouse) that picked it up moves it.
      if (e.pointerId !== this.dragging.pointer) return;
      this.dragPointer = { clientX: e.clientX, clientY: e.clientY };
      const d = this.dragging;
      // A real drag (not a tap): help the finger see the piece (see TOUCH_AID).
      if (d.touch && d.movedAt === null && Math.hypot(e.clientX - d.downX, e.clientY - d.downY) > 8) {
        d.movedAt = now;
        if (d.lift) this.liftRaf = requestAnimationFrame(this.liftTick);
      }
      this.dragTo(this.dragPointer);
      // Near an edge: start scrolling (it keeps going while the finger holds still).
      if (!this.edgeRaf && this.edgeVelocity()) {
        this.edgeAt = now;
        this.edgeRaf = requestAnimationFrame(this.edgeScroll);
      }
      return;
    }
    if (this.panning) {
      this.cam.x = this.panning.camX - (e.clientX - this.panning.x) / this.cam.s;
      this.cam.y = this.panning.camY - (e.clientY - this.panning.y) / this.cam.s;
      this.clampCam();
      this.invalidate();
    }
    if (now - this.lastCursorSent > 120 && this.phase === 'playing') {
      this.lastCursorSent = now;
      const [bx, by] = this.toBoard(e);
      this.shell.sendGame({ t: 'pz-cursor', x: bx, y: by });
    }
  };

  /**
   * How far to lift a piece picked up by a finger: enough that its bottom (tabs and all) sits
   * LIFT_GAP pixels above the fingertip, within limits.
   */
  private liftFor(offY: number) {
    const s = this.state!;
    const ph = s.height / s.rows;
    const short = Math.min(s.width / s.cols, ph);
    const below = (ph + TAB_REACH * short - offY) * this.cam.s;
    return Math.min(LIFT_MAX, Math.max(56, below + LIFT_GAP));
  }

  /** The lift right now (it eases in over LIFT_MS). */
  private liftNow() {
    const d = this.dragging;
    if (!d?.lift || d.movedAt === null) return 0;
    const t = Math.min(1, (performance.now() - d.movedAt) / LIFT_MS);
    return d.lift * (1 - (1 - t) ** 3);
  }

  private liftTick = () => {
    this.liftRaf = 0;
    const d = this.dragging;
    if (!d || d.movedAt === null || !this.dragPointer) return;
    this.dragTo(this.dragPointer);
    if (performance.now() - d.movedAt < LIFT_MS) this.liftRaf = requestAnimationFrame(this.liftTick);
  };

  /** Put the held group under the pointer (and tell the others, a few times a second). */
  private dragTo(at: { clientX: number; clientY: number }) {
    const d = this.dragging;
    if (!d || !this.state) return;
    const [bx, by] = this.toBoard({ clientX: at.clientX, clientY: at.clientY - this.liftNow() });
    const p = this.state.pieces[d.piece];
    this.moveGroup(d.g, bx - d.offX - p.x, by - d.offY - p.y);
    const now = performance.now();
    if (now - this.lastDragSent > 66) {
      this.lastDragSent = now;
      this.shell.sendGame({ t: 'pz-drag', x: p.x, y: p.y });
    }
    this.invalidate();
  }

  /** Screen pixels a second to scroll while holding a piece near an edge, or null. */
  private edgeVelocity(): [number, number] | null {
    const at = this.dragPointer;
    if (!at || !this.dragging) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = at.clientX - r.left;
    const y = at.clientY - r.top;
    const zx = Math.min(EDGE_ZONE, r.width * 0.12);
    const zy = Math.min(EDGE_ZONE, r.height * 0.12);
    // 0 at the zone's inner edge, 1 at the screen's edge (or past it); eased so it starts slow.
    const depth = (d: number, zone: number) => {
      const t = Math.min(1, Math.max(0, 1 - d / zone));
      return t * t;
    };
    const vx = (depth(r.width - x, zx) - depth(x, zx)) * EDGE_SPEED;
    const hud = this.hud();
    const vy = (depth(r.height - hud.bottom - y, zy) - depth(y - hud.top, zy)) * EDGE_SPEED;
    return vx || vy ? [vx, vy] : null;
  }

  private edgeScroll = (now: number) => {
    this.edgeRaf = 0;
    const v = this.edgeVelocity();
    if (!v || !this.dragPointer) return;
    const dt = Math.min(0.05, Math.max(0, now - this.edgeAt) / 1000);
    this.edgeAt = now;
    this.cam.x += (v[0] * dt) / this.cam.s;
    this.cam.y += (v[1] * dt) / this.cam.s;
    this.clampCam();
    // The table slid under the finger: keep the piece with the finger.
    this.dragTo(this.dragPointer);
    this.edgeRaf = requestAnimationFrame(this.edgeScroll);
  };

  private stopEdgeScroll() {
    cancelAnimationFrame(this.edgeRaf);
    cancelAnimationFrame(this.liftRaf);
    this.edgeRaf = 0;
    this.liftRaf = 0;
    this.dragPointer = null;
  }

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    if (this.dragging && this.dragging.pointer !== e.pointerId) return;
    if (this.dragging && this.state) {
      const p = this.state.pieces[this.dragging.piece];
      // The server answers with where it ended up (snapped to neighbours if it fits).
      this.shell.sendGame({ t: 'pz-drop', x: p.x, y: p.y });
    }
    this.stopEdgeScroll();
    if (this.dragging) this.invalidate(); // the magnifier and the shadow go away
    this.dragging = null;
    this.panning = null;
  };

  /**
   * A pinch on a trackpad (an iPad's or a Mac's, in Safari) zooms the puzzle around the pointer.
   * Fingers on the screen already zoom through the pointer events above, so then it's ignored.
   */
  private onGestureStart = (e: Event) => {
    e.preventDefault();
    this.gesture = this.pointers.size === 0 && this.state && this.phase !== 'setup' ? { s: this.cam.s } : null;
  };

  private onGestureChange = (e: Event) => {
    e.preventDefault();
    if (!this.gesture || this.pointers.size > 0) return;
    const g = e as SafariGesture;
    const r = this.canvas.getBoundingClientRect();
    const x = g.clientX ?? this.hoverAt?.x ?? r.left + r.width / 2;
    const y = g.clientY ?? this.hoverAt?.y ?? r.top + r.height / 2;
    this.zoomAt(x - r.left, y - r.top, (this.gesture.s * g.scale) / this.cam.s);
  };

  private onGestureEnd = (e: Event) => {
    e.preventDefault();
    this.gesture = null;
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.state || this.phase === 'setup') return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  };

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const pickImage = t.closest<HTMLElement>('[data-image]')?.dataset.image;
    if (pickImage) {
      this.pickImage = pickImage;
      this.renderSetup();
      return;
    }
    const count = t.closest<HTMLElement>('[data-count]')?.dataset.count;
    if (count) {
      this.pickCount = Number(count);
      this.renderSetup();
      return;
    }
    const resume = t.closest<HTMLElement>('[data-resume]')?.dataset.resume;
    if (resume) return this.shell.sendGame({ t: 'pz-resume', id: resume });
    const drop = t.closest<HTMLElement>('[data-forget]')?.dataset.forget;
    if (drop) return this.forgetSave(drop);
    const act = t.closest<HTMLElement>('[data-pz]')?.dataset.pz;
    const r = this.canvas.getBoundingClientRect();
    switch (act) {
      case 'start':
        return this.shell.sendGame({ t: 'pz-new', image: this.pickImage, pieces: this.pickCount });
      case 'picture': {
        const img = this.el.querySelector('.pz-preview') as HTMLElement;
        img.hidden = !img.hidden;
        t.closest('[data-pz]')!.setAttribute('aria-pressed', String(!img.hidden));
        return;
      }
      case 'edges':
        this.edgesOnly = !this.edgesOnly;
        t.closest('[data-pz]')!.setAttribute('aria-pressed', String(this.edgesOnly));
        this.invalidate();
        return;
      case 'loupe':
        this.magnifier = !this.magnifier;
        store(MAGNIFIER_KEY, this.magnifier ? '1' : '0');
        // You know what it is now.
        store(MAGNIFIER_HINT_KEY, '1');
        t.closest('[data-pz]')!.setAttribute('aria-pressed', String(this.magnifier));
        this.shell.toast(this.magnifier ? 'Magnifier on: it shows the piece under your finger.' : 'Magnifier off.');
        this.clampCam();
        this.invalidate();
        return;
      case 'tidy':
        return this.shell.sendGame({ t: 'pz-tidy' });
      case 'fit':
        return this.fit();
      case 'zoom-in':
        return this.zoomAt(r.width / 2, r.height / 2, 1.35);
      case 'zoom-out':
        return this.zoomAt(r.width / 2, r.height / 2, 1 / 1.35);
      case 'setup':
        return this.newPuzzle();
    }
  };

  /** Menu: New puzzle, while a puzzle is out. */
  menuItems() {
    return this.phase !== 'setup' && this.state ? [{ id: 'new-puzzle', label: 'New puzzle' }] : [];
  }

  onMenuItem(id: string) {
    if (id === 'new-puzzle') this.newPuzzle();
  }

  /** Put this puzzle away (it's saved) and go back to picking one. */
  private newPuzzle() {
    const s = this.state;
    const ask =
      s && puzzleUntouched(s)
        ? 'Put this puzzle away? Nothing’s been placed yet, so it won’t be kept.'
        : 'Put this puzzle away? It’s saved, so anyone here can continue it later.';
    if (this.phase === 'done' || confirm(ask)) this.shell.sendGame({ t: 'pz-setup' });
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.stopEdgeScroll();
    this.observer.disconnect();
    this.el.removeEventListener('click', this.onClick);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}
