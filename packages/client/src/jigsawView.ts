import { CARD_SOUNDS } from './audio';
import {
  cutPuzzle,
  gridFor,
  maxPieces,
  photoIdOf,
  photoUploadUrl,
  PHOTO_MAX_BYTES,
  PHOTO_MAX_SIDE,
  PHOTO_MIN_SIDE,
  PIECE_COUNTS,
  puzzleProgress,
  puzzleUntouched,
  PUZZLE_IMAGES,
  puzzleImage,
  TAB_REACH,
  tabCurve,
  keepGroupOnTable,
  tableBounds,
  type GameServerMessage,
  type PuzzlePhase,
  type PuzzleState,
  type PuzzleImage,
  type PuzzleSummary,
  type TablePhotoInfo,
  type TabShape,
} from '@tank/shared';
import { loupeZoom } from './loupe';
import { getSession } from './net';
import { colorCss, escapeHtml } from './html';
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
/** Remembered per browser: '0' once you turn the magnifier off. */
const MAGNIFIER_KEY = 'gd.magnifier';
/** The lift: the piece's bottom ends up LIFT_GAP pixels above the fingertip, gliding over LIFT_MS. */
const LIFT_MS = 140;
const LIFT_GAP = 36;
const LIFT_MAX = 170;
/** Someone's pointer starts fading this long after it last moved (or they stopped talking), and is gone at CURSOR_GONE_MS. */
const CURSOR_FADE_MS = 4000;
const CURSOR_GONE_MS = 6000;

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
  /** The piece's soft shadow (its own, lower-resolution bitmap), and how much wider than the
   *  piece's bitmap it is on each side, in board units. */
  shadow: HTMLCanvasElement;
  sp: number;
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

/** A rubbish bin, for taking a puzzle off your list. */
const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/></svg>';

function forget(ids: string[]) {
  if (!ids.length) return;
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(loadSaved().filter((s) => !ids.includes(s.id))));
  } catch {
    /* nothing stored */
  }
}

/** A camera, for the "Your own photo" tile. */
const CAMERA_ICON =
  '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.6"/></svg>';

/** What to tell you when your photo isn't used (photos.ts says why). */
const PHOTO_REFUSED: Record<string, string> = {
  blocked: 'That photo didn’t pass the family-friendly check. Try a different one.',
  'too-small': 'That photo is too small for a puzzle. Try a bigger one.',
  'too-big': 'That photo is too big. Try a different one.',
  'not-image': 'That doesn’t look like a photo. Try a different one.',
  busy: 'Lots of photos are being added right now. Try again in a little while.',
  full: 'This table can’t take any more photos right now.',
  'not-at-table': 'Only people at the table can add a photo.',
  off: 'Adding your own photos is turned off right now.',
  unavailable: 'Your photo couldn’t be checked just now. Try again in a minute.',
};

/** What's happening while your photo is added, in the photo panel. */
const ADDING_WORDS = {
  ready: 'Getting your photo ready…',
  send: 'Sending your photo…',
  check: 'Checking it’s family friendly…',
} as const;
type AddingStep = keyof typeof ADDING_WORDS;

/**
 * How far along the bar is (percent). Getting the photo ready and the check can't be measured,
 * so the bar glides toward their marks (jigsaw.css); sending moves with what's really been sent,
 * the part that's slow on a slow connection.
 */
const addingPercent = (step: AddingStep, sent: number) => (step === 'ready' ? 15 : step === 'send' ? 15 + Math.round(75 * sent) : 97);

/** Cancel was pressed while your photo was being added. */
const STOPPED = new Error('stopped');

/**
 * Send your photo. XMLHttpRequest, not fetch: only it says how much has gone, in every browser
 * (Safari included). `sent` hears the share sent so far (0 to 1); `checking`, that it's all there
 * and being checked.
 */
function sendPhoto(
  url: string,
  jpeg: Blob,
  headers: Record<string, string>,
  on: { sent(share: number): void; checking(): void },
  signal: AbortSignal,
): Promise<{ ok?: boolean; image?: string; reason?: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(STOPPED);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    // A connection that stalls part-way gives up in the end, rather than leaving the bar stuck.
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) on.sent(Math.min(1, e.loaded / e.total));
    };
    xhr.upload.onload = () => on.checking();
    xhr.onload = () => {
      let out: unknown = null;
      try {
        out = JSON.parse(xhr.responseText);
      } catch {
        /* not an answer from us */
      }
      resolve(out && typeof out === 'object' ? out : {});
    };
    xhr.onerror = xhr.ontimeout = () => reject(new Error('unavailable'));
    xhr.onabort = () => reject(STOPPED);
    signal.addEventListener(
      'abort',
      () => {
        xhr.abort();
        reject(STOPPED);
      },
      { once: true },
    );
    xhr.send(jpeg);
  });
}

/**
 * Your photo, smaller (PHOTO_MAX_SIDE on its long side) and as a fresh JPEG: drawing it onto a
 * canvas keeps only the picture, so its location, camera and date stay on your device. Throws
 * 'not-image', 'too-small' or 'too-big' (PHOTO_REFUSED).
 */
async function shrinkPhoto(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error('not-image');
    }
    const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k);
    const h = Math.round(img.naturalHeight * k);
    if (Math.min(w, h) < PHOTO_MIN_SIDE) throw new Error('too-small');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', quality));
      if (blob && blob.size <= PHOTO_MAX_BYTES) return blob;
    }
    throw new Error('too-big');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The jigsaw table. Pieces are cut from the picture once (each with its own tab shapes) and
 * drawn on a canvas you can pan and zoom. Dragging moves the piece straight away; the server
 * confirms on drop (and snaps it to neighbours that fit).
 */
/** How the table under the pieces looks (see JigsawView.tableLook). */
interface TableLook {
  area: string;
  frame: string;
  edge: string;
  img: HTMLImageElement | null;
  pattern: CanvasPattern | null;
}

/** A held group this big or smaller casts the picked-up shadow (as many of its pieces as show). */
const HELD_SHADOW_PIECES = 40;
/**
 * The most canvas pixels the picked-up shadow may keep (iPhones limit canvas memory). Past it (a
 * big group, zoomed far in) the shadow is blurred as it's drawn, every frame.
 */
const HELD_SHADOW_PX = 8_000_000;

/** Your pointer goes to the others at most this often, and only after moving this many screen pixels. */
const CURSOR_SEND_MS = 120;
const CURSOR_SEND_PX = 4;

export class JigsawTable implements View {
  readonly landscape = false;
  readonly helpHtml =
    '<p>Drag pieces around the table; when two fit together they snap and move as one. A group dropped where it belongs locks into the frame.</p><p>Scroll or pinch to zoom, drag the empty table to look around. <b>Edges</b> hides the middle pieces (just for you), <b>Tidy</b> spreads loose pieces back around the edges.</p><p>On a touch screen, a magnifier above your finger shows the piece you’re dragging. The magnifier button turns it off.</p><p>The puzzle saves as you go: pick it again under “Continue a puzzle”. A puzzle nobody plays for 30 days is cleared away.</p><p><b>Your photo</b> makes a puzzle of your own picture. Only the people at this table see it, and it’s deleted when the table closes, so that puzzle isn’t saved.</p>';
  private el = $('jigsaw-view');
  private phase: PuzzlePhase = 'setup';
  private state: PuzzleState | null = null;
  private held = new Map<number, string>();
  private saves: PuzzleSummary[] = [];
  private pickImage = PUZZLE_IMAGES[0].id;
  private pickCount: number = 100;
  /** The pictures to choose from, in a new order each time the setup screen opens. */
  private pictures: PuzzleImage[] = [];
  /**
   * The setup screen is built once each time it opens; after that, picking only moves the
   * "picked" marks. Rebuilding it redrew every picture, which flashed on iPhones (Safari blanks
   * and reloads each image; Chrome doesn't).
   */
  private setupBuilt = false;
  private savesHtml = '';
  /** Photos people at this table uploaded (only in memory, gone when the table closes). */
  private photos: TablePhotoInfo[] = [];
  /** Whether this table may upload photos at all. */
  private photosOn = false;
  /**
   * Your photo while it's being added: the step it's at, the share sent, a small copy of it to
   * show, and Cancel. Null when you aren't adding one.
   */
  private adding: { step: AddingStep; sent: number; preview: string | null; stop: AbortController } | null = null;
  /** Why your last photo wasn't added: the photo panel says so until you try again or close it. */
  private photoRefused: string | null = null;

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
  private raf = 0;
  private edgesOnly = false;
  private cursors = new Map<string, { x: number; y: number; at: number }>();
  /**
   * Everyone else's pointer, as little page elements over the table (the canvas doesn't draw
   * them): the pulse while someone talks is then animated by the browser on its own, without
   * redrawing the whole table every frame, which people talking much of the time would cost.
   */
  private cursorEls = new Map<string, HTMLElement>();
  private cursorBox!: HTMLElement;
  private cursorTimer = 0;
  /** Who's talking right now: their pointer pulses, and doesn't fade while it does. */
  private speaking = new Set<string>();

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
  private dragSentAt: Pt | null = null;
  private lastCursorSent = 0;
  private cursorSentAt: Pt | null = null;
  /** Where the pointer is now, waiting its turn to be sent. */
  private cursorNext: { clientX: number; clientY: number } | null = null;
  private cursorSendTimer: number | undefined;
  private cursorRaf = 0;
  /** The colours held pieces are outlined in: the table only redraws for members when they change. */
  private heldColors = '';
  /** Where things are on screen, measured again only when one of them changes size. */
  private boxes: { hud: { top: number; bottom: number; side: number }; felt: Pt } | null = null;
  private boxObserver = new ResizeObserver(() => (this.boxes = null));
  /**
   * The held group's picked-up shadow, already blurred: one for the table and one for the
   * magnifier (it has its own zoom). `at` is its corner, measured from the group's `first` piece.
   */
  private heldShadows = new Map<CanvasRenderingContext2D, { key: string; canvas: HTMLCanvasElement; first: number; at: Pt }>();
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
        <div class="pz-cursors" aria-hidden="true"></div>
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
    this.cursorBox = this.el.querySelector('.pz-cursors') as HTMLElement;
    this.loupe = this.el.querySelector('.pz-loupe') as HTMLCanvasElement;
    this.loupeCtx = this.loupe.getContext('2d')!;
    this.el.addEventListener('click', this.onClick);
    this.el.addEventListener('change', this.onChange);
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
    for (const el of [this.canvas.closest('#game'), this.el.querySelector('.pz-status'), this.el.querySelector('.pz-tools')]) {
      if (el) this.boxObserver.observe(el);
    }
    shell.sfx.preloadSounds(CARD_SOUNDS);
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
        // A finished puzzle comes off your "Continue a puzzle" list; one in progress goes on it.
        // (Puzzles of your own photos are never saved, so they never go on it.)
        if (m.state) {
          if (m.phase === 'done') forget([m.state.id]);
          else if (!photoIdOf(m.state.image)) remember(m.state.id);
        }
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
        this.scheduleCursors();
        return;
      case 'pz-saves': {
        // Puzzles that no longer exist (nothing placed, or not played for 30 days) leave the list,
        // and so do finished ones: there's nothing left to continue.
        const drop = [...m.gone, ...m.saves.filter((s) => s.done).map((s) => s.id)];
        forget(drop);
        const gone = new Set(drop);
        this.saves = (m.saves.length ? m.saves : this.saves).filter((s) => !gone.has(s.id));
        if (this.phase === 'setup') this.renderSaves();
        return;
      }
      case 'pz-photos':
        this.photos = m.photos;
        this.photosOn = m.on;
        if (this.setupBuilt) {
          this.renderPhotos();
          this.renderPicks();
        }
        return;
    }
  }

  onMembers() {
    // Pointers are page elements; the table itself only shows people in held pieces' outlines.
    const members = this.shell.members();
    const colors = [...this.held.values()].map((by) => members.find((m) => m.id === by)?.color ?? 0).join();
    if (colors !== this.heldColors) {
      this.heldColors = colors;
      this.invalidate();
    } else this.scheduleCursors();
  }

  onSpeaking(aliases: Set<string>) {
    // Someone who stops talking keeps their pointer a few seconds, as after they stop moving.
    const now = performance.now();
    for (const alias of this.speaking) {
      const c = this.cursors.get(alias);
      if (c && !aliases.has(alias)) c.at = now;
    }
    this.speaking = aliases;
    this.scheduleCursors();
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
    this.boxes = null;
    this.el.dataset.phase = this.phase;
    if (this.phase === 'setup') {
      // Opening the setup screen deals the pictures out in a new order (see setupBuilt).
      if (!this.setupBuilt) this.renderSetup(true);
      const ids = loadSaved().map((s) => s.id);
      if (ids.length) this.shell.sendGame({ t: 'pz-saves', ids });
      return;
    }
    this.setupBuilt = false;
    void this.prepareArt();
    this.updateStatus();
    this.renderDone();
  }

  /** Build the setup screen; `shuffle` deals the pictures out in a new order. */
  private renderSetup(shuffle = false) {
    if (shuffle || !this.pictures.length) this.shuffleImages();
    let html = '<div class="pz-setup-card"><h2>Jigsaw puzzle</h2><div class="pz-saves-box"></div>';
    html += '<h4>How many pieces?</h4><div class="pz-counts">';
    for (const n of PIECE_COUNTS) html += `<button type="button" class="pz-btn" data-count="${n}">${n}</button>`;
    html += '</div><h4>Choose a puzzle</h4>';
    // What happens to your own photo, before you pick one (the tile opens it); then how adding it
    // is going, or why it wasn't added (renderPhotoNote).
    html +=
      '<div class="pz-photo-note" hidden><div class="pz-photo-about"><p><b>Use your own photo.</b> Only the people at this table see it, and it’s deleted when the table closes, so this puzzle can’t be continued another day.</p>' +
      '<p>It’s checked automatically first: photos that aren’t family friendly are turned away.</p></div>' +
      `<div class="pz-photo-work" hidden><span class="pz-photo-thumb">${CAMERA_ICON}<img alt="" hidden /></span>` +
      '<div class="pz-photo-what"><p class="pz-photo-step" role="status"></p>' +
      '<div class="pz-photo-bar" role="progressbar" aria-label="Adding your photo" aria-valuemin="0" aria-valuemax="100"><span></span></div></div></div>' +
      '<p class="pz-photo-refused" role="alert" hidden></p>' +
      '<div class="pz-photo-actions"><label class="pc-btn pc-btn-main pz-photo-choose"><span>Choose a photo</span><input type="file" accept="image/*" class="pz-photo-file" hidden /></label>' +
      '<button type="button" class="pc-btn pc-btn-plain" data-pz="photo-cancel">Not now</button>' +
      '<button type="button" class="pc-btn pc-btn-plain" data-pz="photo-stop" hidden>Cancel</button></div></div>';
    html += '<div class="pz-images"><div class="pz-own"></div>';
    for (const i of this.pictures) {
      html += `<button type="button" class="pz-image" data-image="${i.id}"><img src="${i.thumb}" alt="" loading="lazy" /><span>${escapeHtml(i.title)}</span></button>`;
    }
    html += '</div><div class="pz-start-bar"><p class="pc-small pz-grid"></p>';
    html += '<button type="button" class="pc-btn pc-btn-main pc-btn-big pz-start" data-pz="start">Start puzzle</button>';
    html += '<p class="pc-small pz-credit"></p></div></div>';
    (this.el.querySelector('.pz-setup') as HTMLElement).innerHTML = html;
    this.setupBuilt = true;
    this.savesHtml = '';
    this.renderSaves();
    this.renderPhotos();
    this.renderPhotoNote();
    this.renderPicks();
  }

  /**
   * The table's own photos, first in the grid, after the "Your own photo" tile. Tiles are added
   * and removed one by one (rebuilding them all made pictures blink on iPhones).
   */
  private renderPhotos() {
    const own = this.el.querySelector<HTMLElement>('.pz-own');
    if (!own) return;
    let tile = own.querySelector<HTMLButtonElement>('.pz-upload');
    if (this.photosOn && !tile) {
      own.insertAdjacentHTML('afterbegin', `<button type="button" class="pz-image pz-upload" data-pz="photo"><span class="pz-upload-art">${CAMERA_ICON}</span><span class="pz-upload-label"></span></button>`);
      tile = own.querySelector<HTMLButtonElement>('.pz-upload');
    }
    if (!this.photosOn) tile?.remove();
    if (tile) {
      tile.disabled = !!this.adding;
      tile.querySelector('.pz-upload-label')!.textContent = this.adding ? 'Adding…' : 'Your photo';
    }
    const want = new Set(this.photos.map((p) => p.image));
    for (const b of own.querySelectorAll<HTMLElement>('[data-image]')) if (!want.has(b.dataset.image!)) b.remove();
    const have = new Set([...own.querySelectorAll<HTMLElement>('[data-image]')].map((b) => b.dataset.image));
    for (const p of this.photos) {
      if (have.has(p.image)) continue;
      // Newest first, right after the tile.
      const html = `<button type="button" class="pz-image" data-image="${escapeHtml(p.image)}"><img src="${escapeHtml(p.url)}" alt="" /><span>${escapeHtml(p.title)}</span></button>`;
      if (tile) tile.insertAdjacentHTML('afterend', html);
      else own.insertAdjacentHTML('afterbegin', html);
    }
  }

  /**
   * The photo panel: what happens to your photo, before you choose one; while it's being added,
   * the photo with what's happening and a bar (and Cancel); if it's turned away, why.
   */
  private renderPhotoNote() {
    const note = this.el.querySelector<HTMLElement>('.pz-photo-note');
    if (!note) return;
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => note.querySelector<T>(sel)!;
    const a = this.adding;
    const refused = a ? null : this.photoRefused;
    const work = q('.pz-photo-work');
    const fresh = !!a && (note.hidden || work.hidden);
    if (a) note.hidden = false;
    q('.pz-photo-about').hidden = !!a || !!refused;
    work.hidden = !a;
    const why = q('.pz-photo-refused');
    why.hidden = !refused;
    why.textContent = refused ?? '';
    q('.pz-photo-choose').hidden = !!a;
    q('.pz-photo-choose span').textContent = refused ? 'Try another photo' : 'Choose a photo';
    q('[data-pz="photo-cancel"]').hidden = !!a;
    q('[data-pz="photo-stop"]').hidden = !a;
    if (!a) return;
    q('.pz-photo-step').textContent = ADDING_WORDS[a.step];
    const img = q<HTMLImageElement>('.pz-photo-thumb img');
    if (a.preview && img.getAttribute('src') !== a.preview) img.src = a.preview;
    img.hidden = !a.preview;
    const bar = q('.pz-photo-bar');
    const fill = q('.pz-photo-bar span');
    const percent = addingPercent(a.step, a.sent);
    if (fresh) {
      // From empty, not from where the last photo's bar was left.
      fill.style.transition = 'none';
      fill.style.width = '0%';
      void fill.offsetWidth;
      fill.style.transition = '';
    }
    bar.dataset.step = a.step;
    bar.setAttribute('aria-valuenow', String(percent));
    fill.style.width = `${percent}%`;
  }

  /** The picture that's picked (a photo of the table's, or one of the site's), with its credit line. */
  private picked(): { id: string; title: string; width: number; height: number; credit: string } {
    const photo = this.photos.find((p) => p.image === this.pickImage);
    if (photo) return { id: photo.image, title: photo.title, width: photo.width, height: photo.height, credit: 'Only people at this table see this photo' };
    return this.pictures.find((i) => i.id === this.pickImage) ?? this.pictures[0] ?? PUZZLE_IMAGES[0];
  }

  /** The pictures in a new order with the first one picked, so different ones are up top each time. */
  private shuffleImages() {
    const list = [...PUZZLE_IMAGES];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    this.pictures = list;
    this.pickImage = list[0].id;
  }

  /** "Continue a puzzle", above the rest: people coming back want their puzzle first. */
  private renderSaves() {
    const box = this.el.querySelector<HTMLElement>('.pz-saves-box');
    if (!box) return;
    let html = '';
    if (this.saves.length) {
      html += '<h3>Continue a puzzle</h3><ul class="pz-saves">';
      for (const s of [...this.saves].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const when = new Date(s.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
        // Each part kept together (no-break spaces), so a narrow row breaks only between them.
        const about = [`${s.pieces} pieces`, `${Math.round(s.progress * 100)}% done`, when].map((p) => p.replace(/ /g, ' ')).join(' · ');
        html += `<li><img src="${escapeHtml(puzzleImage(s.image)?.thumb ?? s.imageFile)}" alt="" loading="lazy" /><span><b>${escapeHtml(puzzleImage(s.image)?.title ?? s.title)}</b><small>${escapeHtml(about)}</small></span><button type="button" class="pc-btn pc-btn-plain" data-resume="${s.id}">Continue</button><button type="button" class="pc-btn pc-btn-alert pz-forget" data-forget="${s.id}" aria-label="Remove ${escapeHtml(s.title)} from your list" title="Remove from your list">${TRASH_ICON}</button></li>`;
      }
      html += '</ul><h3>Or start a new one</h3>';
    }
    // Redrawn only when the list really changed (the same flash as above).
    if (html === this.savesHtml) return;
    this.savesHtml = html;
    box.innerHTML = html;
  }

  /** The size to start: the one picked, or the picked picture's most if that's fewer. */
  private count() {
    const img = this.picked();
    return Math.min(this.pickCount, maxPieces(img.width, img.height));
  }

  /** Mark the picked picture and size, and say what you'd get, without rebuilding anything. */
  private renderPicks() {
    const card = this.el.querySelector<HTMLElement>('.pz-setup-card');
    if (!card) return;
    const img = this.picked();
    for (const b of card.querySelectorAll<HTMLElement>('[data-image]')) b.classList.toggle('picked', b.dataset.image === img.id);
    // A smaller picture offers fewer pieces: bigger sizes are greyed out, and a size you picked
    // that's too big for it comes down to its most (and comes back with a bigger picture).
    const most = maxPieces(img.width, img.height);
    const count = this.count();
    for (const b of card.querySelectorAll<HTMLButtonElement>('[data-count]')) {
      const n = Number(b.dataset.count);
      const g = gridFor(img.width, img.height, n);
      b.disabled = n > most;
      b.classList.toggle('picked', n === count);
      b.title = n > most ? `This picture is too small for ${n} pieces` : `${g.cols * g.rows} pieces`;
    }
    // The grid has to fit the picture, so the real count is close to the one picked.
    const grid = gridFor(img.width, img.height, count);
    const cap = most < PIECE_COUNTS[PIECE_COUNTS.length - 1] ? ` This picture is big enough for up to ${most}.` : '';
    card.querySelector('.pz-grid')!.innerHTML = `<b>${escapeHtml(img.title)}</b>: ${grid.cols * grid.rows} pieces, ${grid.cols} across and ${grid.rows} down.${cap}`;
    card.querySelector('.pz-credit')!.textContent = `Anyone at the table can pick. ${img.credit}.`;
  }

  /**
   * Take a puzzle off your "Continue" list. Only yours: friends who worked on it keep it (and
   * the save is deleted for good once nobody has played it for 30 days).
   */
  private forgetSave(id: string) {
    const s = this.saves.find((x) => x.id === id);
    if (s && s.progress > 0) {
      const pct = Math.round(s.progress * 100);
      if (!confirm(`Take “${s.title}” (${s.pieces} pieces, ${pct}% done) off your list? Friends who worked on it can still continue it.`)) return;
    }
    forget([id]);
    this.saves = this.saves.filter((x) => x.id !== id);
    this.renderSaves();
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
    return { canvas, path, w, h, ...this.pieceShadow(path, w, h, short, k) };
  }

  /**
   * A thin piece of card lying on the felt casts a small, soft shadow, mostly downward. It's kept
   * as its own bitmap (at half the piece's resolution: it's blurred anyway) so a group's shadows
   * can all go down before its pieces, and never fall across the seams of joined pieces.
   */
  private pieceShadow(path: Path2D, w: number, h: number, short: number, k: number) {
    const sp = short * 0.14;
    const blur = short * 0.05;
    const drop = short * 0.03;
    const ks = k * 0.5;
    const shadow = document.createElement('canvas');
    shadow.width = Math.ceil((w + sp * 2) * ks);
    shadow.height = Math.ceil((h + sp * 2) * ks);
    const g = shadow.getContext('2d')!;
    // Shadows ignore the canvas's scale, so blur and offset are in its pixels: draw the piece far
    // off to the left, and let only its shadow fall back into view.
    const away = shadow.width + 100;
    g.setTransform(ks, 0, 0, ks, sp * ks - away, sp * ks);
    g.shadowColor = 'rgba(34, 26, 18, 0.55)';
    g.shadowBlur = blur * ks;
    g.shadowOffsetX = away;
    g.shadowOffsetY = drop * ks;
    g.fillStyle = '#000';
    g.fill(path);
    return { shadow, sp };
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
    this.boxes = null;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // A new screen size (rotating a phone, resizing a window): if you were looking at the whole
    // table, look at the whole table again; zoomed in, stay zoomed sensibly and on the table.
    if (this.state && this.art.length) {
      if (this.lastFit > 0 && this.cam.s <= this.lastFit * 1.03) {
        this.fit();
        return;
      }
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
    return this.measure().hud;
  }

  /** The hud, and how far the canvas sits from the game's corner (for the cloth). */
  private measure() {
    if (this.boxes) return this.boxes;
    const c = this.canvas.getBoundingClientRect();
    const game = this.canvas.closest('#game')?.getBoundingClientRect();
    const felt: Pt = game ? [c.left - game.left, c.top - game.top] : [0, 0];
    const status = this.el.querySelector('.pz-status')?.getBoundingClientRect();
    const tools = this.el.querySelector('.pz-tools')?.getBoundingClientRect();
    const top = status?.height ? Math.max(HUD.top, status.bottom - c.top + 10) : HUD.top;
    const bottom = tools?.height ? Math.max(HUD.bottom, c.bottom - tools.top + 10) : HUD.bottom;
    const boxes = { hud: { top, bottom, side: HUD.side }, felt };
    // (Not on screen yet: nothing worth remembering.)
    if (c.width) this.boxes = boxes;
    return boxes;
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
    this.lastFit = fit;
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

  /** The whole-table zoom when it was last worked out (so a resize can tell if you were there). */
  private lastFit = 0;

  private fit() {
    if (!this.state) return;
    this.cam.s = this.lastFit = this.fitScale();
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

  /** Move the pointers without redrawing the table. (A redraw that's coming moves them anyway.) */
  private scheduleCursors() {
    if (this.raf || this.cursorRaf) return;
    this.cursorRaf = requestAnimationFrame(() => {
      this.cursorRaf = 0;
      this.placeCursors();
    });
  }

  private invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  /** The last cloth position handed to the page, so it's only updated when the view moves. */
  private feltKey = '';

  /**
   * The felt look's table cloth zooms and pans with the puzzle, as if leaning over a real table
   * (felt.css reads --felt-zoom, --felt-x and --felt-y on #game). It's tied to the board: the
   * whole-table view shows it at its normal size, and the board's corner is the cloth's corner.
   */
  private moveFelt(on: boolean) {
    const game = this.canvas.closest<HTMLElement>('#game');
    if (!game) return;
    if (!on || !this.state) {
      if (this.feltKey) for (const p of ['--felt-zoom', '--felt-x', '--felt-y']) game.style.removeProperty(p);
      this.feltKey = '';
      return;
    }
    const [left, top] = this.measure().felt;
    const zoom = this.cam.s / this.fitScale();
    const x = left - this.cam.x * this.cam.s;
    const y = top - this.cam.y * this.cam.s;
    const key = `${zoom.toFixed(4)} ${x.toFixed(1)} ${y.toFixed(1)}`;
    if (key === this.feltKey) return;
    this.feltKey = key;
    game.style.setProperty('--felt-zoom', zoom.toFixed(4));
    game.style.setProperty('--felt-x', `${x.toFixed(1)}px`);
    game.style.setProperty('--felt-y', `${y.toFixed(1)}px`);
  }

  /**
   * How the table under the pieces looks, from the page's styles: the felt look gives the frame
   * a sheet of felt (--pz-frame-img) and the piece area a warm tint (--pz-area); the paper look
   * gives neither, and the frame is cream paper.
   */
  private look: TableLook | null = null;

  private tableLook() {
    if (this.look) return this.look;
    const css = getComputedStyle(this.canvas.closest('#game') ?? document.documentElement);
    const area = css.getPropertyValue('--pz-area').trim() || 'rgba(17, 40, 117, 0.06)';
    const frame = css.getPropertyValue('--pz-frame').trim();
    const edge = css.getPropertyValue('--pz-frame-edge').trim() || 'rgba(17, 40, 117, 0.4)';
    const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(css.getPropertyValue('--pz-frame-img'))?.[1] ?? null;
    const look: TableLook = { area, frame, edge, img: null, pattern: null };
    if (url) {
      const img = new Image();
      img.onload = () => {
        // From a canvas copy, not the <img>: an image pattern beside the pieces' canvases makes
        // Chrome draw the whole table on the CPU (see renderer.ts, the Tanks sky).
        const copy = document.createElement('canvas');
        copy.width = img.naturalWidth;
        copy.height = img.naturalHeight;
        copy.getContext('2d')!.drawImage(img, 0, 0);
        look.pattern = this.ctx.createPattern(copy, 'repeat');
        this.invalidate();
      };
      img.src = url;
      look.img = img;
    }
    this.look = look;
    return look;
  }

  private draw() {
    const s = this.state;
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.dragging) this.freeHeldShadows();
    this.drawLoupe(dpr);
    this.placeCursors();
    if (!s || this.phase === 'setup') {
      this.moveFelt(false);
      return;
    }
    this.moveFelt(true);
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
    this.drawTable(ctx, this.cam.s, dpr, view);
  }

  /**
   * Everyone else's pointer, with their name, where it is on screen now. One that hasn't moved for
   * a few seconds fades away (jigsaw.css), unless they're talking: then it pulses and stays.
   */
  private placeCursors() {
    clearTimeout(this.cursorTimer);
    const show = !!this.state && this.phase !== 'setup';
    const now = performance.now();
    const seen = new Set<string>();
    let wake = Infinity;
    for (const [alias, c] of show ? this.cursors : []) {
      if (alias === this.shell.alias) continue;
      const member = this.shell.members().find((m) => m.id === alias);
      if (!member) continue;
      const talking = this.speaking.has(alias);
      const age = talking ? 0 : now - c.at;
      if (age >= CURSOR_GONE_MS) continue;
      seen.add(alias);
      let el = this.cursorEls.get(alias);
      if (!el) {
        el = document.createElement('div');
        el.className = 'pz-cursor';
        el.innerHTML = '<i></i><span></span>';
        this.cursorBox.append(el);
        this.cursorEls.set(alias, el);
      }
      const label = el.lastElementChild as HTMLElement;
      if (label.textContent !== member.name) label.textContent = member.name;
      el.style.setProperty('--c', colorCss(member.color));
      el.style.transform = `translate(${((c.x - this.cam.x) * this.cam.s).toFixed(1)}px, ${((c.y - this.cam.y) * this.cam.s).toFixed(1)}px)`;
      el.classList.toggle('talking', talking);
      const fading = age >= CURSOR_FADE_MS;
      el.classList.toggle('fading', fading);
      if (!talking) wake = Math.min(wake, c.at + (fading ? CURSOR_GONE_MS : CURSOR_FADE_MS));
    }
    for (const [alias, el] of this.cursorEls) {
      if (seen.has(alias)) continue;
      el.remove();
      this.cursorEls.delete(alias);
    }
    // Look again when the next one should start fading or be gone (without redrawing the table).
    if (wake < Infinity) this.cursorTimer = window.setTimeout(() => this.placeCursors(), Math.max(0, wake - now) + 20);
  }

  /**
   * The table, the frame where the finished puzzle goes, and the pieces, at `zoom` screen pixels
   * per board unit (the caller sets the transform). Pieces outside `view` (board units) are
   * skipped. False if the pieces aren't cut yet.
   */
  private drawTable(ctx: CanvasRenderingContext2D, zoom: number, dpr: number, view: { x0: number; y0: number; x1: number; y1: number }) {
    const s = this.state!;
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    // On the table (the page shows through): the area pieces can go a shade darker, and the
    // frame where the finished picture goes: sunken cream felt (felt look), or cream paper with a
    // dashed ink edge.
    const look = this.tableLook();
    ctx.fillStyle = look.area;
    ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    if (look.frame) {
      // A patch of cream felt set a touch below the table: its texture tied to the board (the
      // same size as the cloth at the whole-table view).
      const t = 0.5 / this.fitScale();
      look.pattern?.setTransform(new DOMMatrix([t, 0, 0, t, 0, 0]));
      // Not quite opaque (invisible to the eye): only pieces are drawn fully opaque, which is how
      // the browser tests find them on the canvas.
      ctx.save();
      ctx.globalAlpha = 0.97;
      ctx.fillStyle = look.frame;
      ctx.fillRect(0, 0, s.width, s.height);
      ctx.restore();
      if (look.pattern) {
        // The felt's grain on top, keeping the frame's own (not quite opaque) alpha.
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = look.pattern;
        ctx.fillRect(0, 0, s.width, s.height);
        ctx.restore();
      }
      // Sunken: the grey felt's edge casts a soft shadow just inside the frame, deepest along the
      // top (light from above). A ring round the frame, clipped away, drops its shadow inward.
      const m = 60 / zoom;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, s.width, s.height);
      ctx.clip();
      ctx.beginPath();
      ctx.rect(-m, -m, s.width + 2 * m, s.height + 2 * m);
      ctx.rect(0, 0, s.width, s.height);
      ctx.shadowColor = 'rgba(34, 26, 18, 0.4)';
      ctx.shadowBlur = 6 * dpr;
      ctx.shadowOffsetY = 2 * dpr;
      ctx.fillStyle = 'rgb(34, 26, 18)';
      ctx.fill('evenodd');
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(255, 252, 245, 0.8)';
      ctx.fillRect(0, 0, s.width, s.height);
      ctx.setLineDash([8 / zoom, 6 / zoom]);
      ctx.strokeStyle = look.edge;
      ctx.lineWidth = 2 / zoom;
      ctx.strokeRect(0, 0, s.width, s.height);
      ctx.setLineDash([]);
    }
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
    const locked = new Set(s.locked);
    for (const g of this.order) {
      if (this.hidden(g)) continue;
      const list = this.groups.get(g)?.filter(seen);
      if (!list?.length) continue;
      // The piece in your hand casts a soft shadow, so it looks picked up. (Shadows first, then
      // the pieces, so a group's shadows don't fall across its own seams.)
      if (this.dragging?.g === g && list.length <= HELD_SHADOW_PIECES) {
        this.drawHeldShadow(ctx, g, list, zoom * dpr, dpr);
      } else if (!locked.has(g)) {
        // Loose pieces cast a small shadow on the felt (pieces locked into the frame lie flat in it).
        for (const i of list) {
          const p = s.pieces[i];
          const a = this.art[i];
          ctx.drawImage(a.shadow, p.x - this.pad - a.sp, p.y - this.pad - a.sp, a.w + a.sp * 2, a.h + a.sp * 2);
        }
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

  /**
   * The soft shadow under what's in your hand. Blurring is the costly part, so it's done once, as
   * it's picked up, and that picture then moves with the group (its pieces can't move among
   * themselves while held). It's blurred again only if the zoom changes, or, for a group too big
   * to keep whole, as pieces come on or off the screen. `k` is canvas pixels per board unit.
   */
  private drawHeldShadow(ctx: CanvasRenderingContext2D, g: number, showing: number[], k: number, dpr: number) {
    const all = this.groups.get(g)!;
    // Far enough out for the blur (3 sigma, 21) and the drop (6).
    const margin = 32 * dpr;
    const bounds = (pieces: number[]) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const i of pieces) {
        const x = this.state!.pieces[i].x - this.pad;
        const y = this.state!.pieces[i].y - this.pad;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + this.art[i].w);
        y1 = Math.max(y1, y + this.art[i].h);
      }
      const w = Math.ceil((x1 - x0) * k + margin * 2);
      const h = Math.ceil((y1 - y0) * k + margin * 2);
      return { pieces, x: x0 - margin / k, y: y0 - margin / k, w, h, fits: w * h <= HELD_SHADOW_PX };
    };
    let box = bounds(all.length <= HELD_SHADOW_PIECES ? all : showing);
    if (!box.fits && box.pieces !== showing) box = bounds(showing);
    if (!box.fits) return this.paintHeldShadow(ctx, showing, dpr);

    const key = `${g} ${k} ${dpr} ${box.pieces.join()}`;
    let kept = this.heldShadows.get(ctx);
    if (kept?.key !== key) {
      const canvas = kept?.canvas ?? document.createElement('canvas');
      canvas.width = box.w; // (also wipes it)
      canvas.height = box.h;
      const c = canvas.getContext('2d');
      // (Out of canvas memory.)
      if (!c) return this.paintHeldShadow(ctx, showing, dpr);
      c.setTransform(k, 0, 0, k, -box.x * k, -box.y * k);
      this.paintHeldShadow(c, box.pieces, dpr);
      const first = this.state!.pieces[box.pieces[0]];
      kept = { key, canvas, first: box.pieces[0], at: [box.x - first.x, box.y - first.y] };
      this.heldShadows.set(ctx, kept);
    }
    const p = this.state!.pieces[kept.first];
    ctx.drawImage(kept.canvas, p.x + kept.at[0], p.y + kept.at[1], kept.canvas.width / k, kept.canvas.height / k);
  }

  private paintHeldShadow(ctx: CanvasRenderingContext2D, pieces: number[], dpr: number) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 14 * dpr;
    ctx.shadowOffsetY = 6 * dpr;
    for (const i of pieces) {
      const p = this.state!.pieces[i];
      const a = this.art[i];
      ctx.drawImage(a.canvas, p.x - this.pad, p.y - this.pad, a.w, a.h);
    }
    ctx.restore();
  }

  private freeHeldShadows() {
    // (Emptied, not just dropped: Safari is slow to give canvas memory back.)
    for (const { canvas } of this.heldShadows.values()) canvas.width = canvas.height = 0;
    this.heldShadows.clear();
  }

  private drawLoupe(dpr: number) {
    const el = this.loupe;
    const v = this.loupeView();
    if (!v) {
      el.classList.remove('on');
      return;
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
    // A first finger (or the mouse) means nothing else is touching. Forget any finger whose lift
    // never arrived (an iPhone can lose one when it's turned), or this touch would count as its
    // second finger and pinch, and a piece it held would stay stuck to it.
    if (e.isPrimary && this.pointers.size) {
      if (this.dragging) this.release(this.dragging.pointer);
      this.pointers.clear();
      this.pinch = null;
      this.panning = null;
    }
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
    if (this.phase === 'playing') this.pointAt(e);
  };

  /** Nobody else at the table to show pointers and drags to. */
  private alone() {
    const me = this.shell.alias;
    return !this.shell.members().some((m) => m.id !== me && m.connected);
  }

  /** Tell the others where your pointer is: not too often, not for a twitch, always where it stopped. */
  private pointAt(e: { clientX: number; clientY: number }) {
    if (this.alone()) {
      // Nobody to show. Moving it still counts as being here (which keeps the table open).
      this.shell.stillHere();
      return;
    }
    this.cursorNext = { clientX: e.clientX, clientY: e.clientY };
    if (this.cursorSendTimer !== undefined) return;
    const wait = this.lastCursorSent + CURSOR_SEND_MS - performance.now();
    if (wait <= 0) this.sendCursor();
    else this.cursorSendTimer = window.setTimeout(() => this.sendCursor(), wait);
  }

  private sendCursor() {
    clearTimeout(this.cursorSendTimer);
    this.cursorSendTimer = undefined;
    const at = this.cursorNext;
    this.cursorNext = null;
    // (While dragging, your pointer rides along with the piece.)
    if (!at || this.dragging || this.phase !== 'playing') return;
    const [x, y] = this.toBoard(at);
    const was = this.cursorSentAt;
    if (was && Math.hypot(x - was[0], y - was[1]) * this.cam.s < CURSOR_SEND_PX) return;
    this.lastCursorSent = performance.now();
    this.cursorSentAt = [x, y];
    this.shell.sendGame({ t: 'pz-cursor', x, y });
  }

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
    const to = keepGroupOnTable(this.state, this.groups.get(d.g) ?? [], d.piece, bx - d.offX, by - d.offY);
    this.moveGroup(d.g, to.x - p.x, to.y - p.y);
    const now = performance.now();
    const was = this.dragSentAt;
    // (Alone, the drop says where it ended up. And holding still says nothing new.)
    if (now - this.lastDragSent > 66 && (!was || was[0] !== p.x || was[1] !== p.y) && !this.alone()) {
      this.lastDragSent = now;
      this.dragSentAt = [p.x, p.y];
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

  private onUp = (e: PointerEvent) => this.release(e.pointerId);

  /** A finger lifted (or the mouse let go): end its pinch, drag or look-around. */
  private release(pointerId: number) {
    this.pointers.delete(pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    if (this.dragging && this.dragging.pointer !== pointerId) return;
    if (this.dragging && this.state) {
      const p = this.state.pieces[this.dragging.piece];
      // The server answers with where it ended up (snapped to neighbours if it fits).
      this.shell.sendGame({ t: 'pz-drop', x: p.x, y: p.y });
      this.dragSentAt = null;
      this.cursorSentAt = null; // theirs followed the piece: the next move is news
    }
    this.stopEdgeScroll();
    if (this.dragging) this.invalidate(); // the magnifier and the shadow go away
    this.dragging = null;
    this.panning = null;
  }

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

  /** A photo of your own was chosen. */
  private onChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (!input.classList?.contains('pz-photo-file')) return;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.uploadPhoto(file);
  };

  /**
   * Shrink your photo here (which also leaves its location and camera details behind), send it
   * to be checked, and pick it once it's in. Everyone at the table gets it in their picker. The
   * photo panel shows how it's going the whole time (renderPhotoNote).
   */
  private async uploadPhoto(file: File) {
    if (this.adding) return;
    const adding: NonNullable<JigsawTable['adding']> = { step: 'ready', sent: 0, preview: null, stop: new AbortController() };
    this.adding = adding;
    this.photoRefused = null;
    this.renderPhotos();
    this.renderPhotoNote();
    const update = () => {
      if (this.adding === adding) this.renderPhotoNote();
    };
    const stopped = new Promise<never>((_, reject) => adding.stop.signal.addEventListener('abort', () => reject(STOPPED), { once: true }));
    let reason = 'unavailable';
    let added = false;
    try {
      const began = performance.now();
      // Getting it ready can't be cut short, but Cancel needn't wait for it.
      const jpeg = await Promise.race([shrinkPhoto(file), stopped]);
      const readyMs = Math.round(performance.now() - began);
      adding.preview = URL.createObjectURL(jpeg);
      adding.step = 'send';
      update();
      const out = await sendPhoto(
        photoUploadUrl(this.shell.roomCode),
        jpeg,
        { 'content-type': 'image/jpeg', 'x-gd-session': getSession() ?? '', 'x-gd-ready-ms': String(readyMs) },
        {
          sent: (share) => {
            adding.sent = share;
            update();
          },
          checking: () => {
            adding.step = 'check';
            update();
          },
        },
        adding.stop.signal,
      );
      if (out.ok && out.image) {
        this.pickImage = out.image;
        added = true;
        reason = '';
      } else reason = out.reason ?? reason;
    } catch (err) {
      if (err === STOPPED) reason = '';
      else if (err instanceof Error && err.message in PHOTO_REFUSED) reason = err.message;
    } finally {
      if (adding.preview) URL.revokeObjectURL(adding.preview);
      this.adding = null;
    }
    this.photoRefused = reason ? (PHOTO_REFUSED[reason] ?? PHOTO_REFUSED.unavailable) : null;
    if (this.setupBuilt) {
      // Added: the panel goes, and the photo is picked in the grid. Turned away: the panel says
      // why. Cancelled: it's back to choosing one.
      const note = this.el.querySelector<HTMLElement>('.pz-photo-note');
      if (note) note.hidden = added;
      this.renderPhotos();
      this.renderPicks();
      this.renderPhotoNote();
    } else if (this.photoRefused) {
      // The puzzle began meanwhile, and the panel isn't on screen.
      this.shell.toast(this.photoRefused);
      this.photoRefused = null;
    }
  }

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const pickImage = t.closest<HTMLElement>('[data-image]')?.dataset.image;
    if (pickImage) {
      this.pickImage = pickImage;
      this.renderPicks();
      return;
    }
    const count = t.closest<HTMLElement>('[data-count]')?.dataset.count;
    if (count) {
      this.pickCount = Number(count);
      this.renderPicks();
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
        return this.shell.sendGame({ t: 'pz-new', image: this.picked().id, pieces: this.count() });
      case 'photo':
      case 'photo-cancel': {
        const note = this.el.querySelector<HTMLElement>('.pz-photo-note');
        if (note) note.hidden = act === 'photo-cancel' || !note.hidden;
        // Closed: it starts from the beginning next time.
        if (note?.hidden && this.photoRefused) {
          this.photoRefused = null;
          this.renderPhotoNote();
        }
        return;
      }
      case 'photo-stop':
        this.adding?.stop.abort();
        return;
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
      s && photoIdOf(s.image)
        ? 'Put this puzzle away? Puzzles of your own photos aren’t saved, so it can’t be continued later.'
        : s && puzzleUntouched(s)
          ? 'Put this puzzle away? Nothing’s been placed yet, so it won’t be kept.'
          : 'Put this puzzle away? It’s saved, so anyone here can continue it later.';
    if (this.phase === 'done' || confirm(ask)) this.shell.sendGame({ t: 'pz-setup' });
  }

  dispose() {
    this.freeHeldShadows();
    // Stop cutting pieces (prepareArt checks artFor between pieces), and give the pieces' canvases
    // back now: emptied, not just dropped, as Safari is slow to give canvas memory back.
    this.artFor = '';
    for (const a of this.art) a.canvas.width = a.canvas.height = a.shadow.width = a.shadow.height = 0;
    this.art = [];
    this.boxObserver.disconnect();
    clearTimeout(this.cursorSendTimer);
    cancelAnimationFrame(this.cursorRaf);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.cursorTimer);
    this.cursorEls.clear();
    this.moveFelt(false);
    this.stopEdgeScroll();
    this.observer.disconnect();
    this.el.removeEventListener('click', this.onClick);
    this.el.removeEventListener('change', this.onChange);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}
