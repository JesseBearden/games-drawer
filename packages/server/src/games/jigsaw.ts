import {
  gridFor,
  maxPieces,
  photoIdOf,
  PIECE_COUNTS,
  puzzleImage,
  puzzleProgress,
  puzzleUntouched,
  r1,
  tableBounds,
  type GameInput,
  type PieceSpot,
  type PuzzlePhase,
  type PuzzleServerMessage,
  type PuzzleState,
} from '@tank/shared';
import type { PuzzleStore } from '../puzzleStore';
import type { GameHost, Member, Outgoing, ServerGame } from './types';

/** 15 times a second: as often as a browser sends a drag, so batching costs no smoothness. */
const JIGSAW_TICKS = 4;
/**
 * Pointers and drags go out together at most this often, each person's newest only. (A little
 * under JIGSAW_TICKS' gap, so a tick that comes a millisecond early still sends.)
 */
const LIVE_GAP_MS = 60;
/** Saves wait this long after a change, so a busy table writes a few times a minute at most. */
const SAVE_DELAY_MS = 4000;
/** How close (as a fraction of a piece's short side) two pieces must be to snap together. */
const SNAP = 0.22;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
/**
 * Puzzles one table may start or bring back per hour. Plenty for people; a wall for a script
 * starting puzzle after puzzle, since each one can become a save file on the shared disk.
 */
const STARTS_PER_HOUR = 20;
/** One person may ask "which of my saves are still there?" this often (each save is a file read). */
const SAVES_ASK_GAP_MS = 3000;
/** The browser remembers at most 30 saves; never look up more than that at once. */
const SAVES_ASK_MAX = 30;

/**
 * Slot positions along one axis: outside the frame's span (lo..hi), packed outwards from it to
 * the table's edge, and across the span itself (centred).
 */
function slotLines(lo: number, hi: number, size: number, min: number, max: number) {
  const outside: number[] = [];
  for (let v = lo - size; v >= min; v -= size) outside.push(v);
  for (let v = hi; v + size <= max; v += size) outside.push(v);
  const n = Math.max(1, Math.floor((hi - lo) / size));
  const start = (lo + hi - n * size) / 2;
  const across = Array.from({ length: n }, (_, i) => start + i * size);
  return { outside, across };
}

/**
 * A jigsaw everyone in the room builds together (no bots, no seats). Anyone picks the picture
 * and piece count; pieces you pick up are yours until you drop them (others see who has them);
 * pieces that fit snap into groups; a group dropped where it belongs locks into the frame. The
 * puzzle saves to disk as it changes, so it can be continued later by its id.
 */
export class JigsawGame implements ServerGame {
  readonly id = 'jigsaw' as const;
  readonly capacity = 4;
  readonly tickEvery = JIGSAW_TICKS;
  phase: PuzzlePhase = 'setup';
  state: PuzzleState | null = null;
  /** group -> session holding it */
  private held = new Map<number, string>();
  /** session -> the group and piece they picked up */
  private holding = new Map<string, { g: number; piece: number }>();
  private saveAt: number | null = null;
  /** Newest pointer and drag of each session, until they next go out together. */
  private cursors = new Map<string, PuzzleServerMessage>();
  private drags = new Map<string, PuzzleServerMessage>();
  private liveSentAt = -Infinity;
  /** When this table started or brought back a puzzle, over the last hour. */
  private starts: number[] = [];
  private savesAskedAt = new Map<string, number>();
  /** A saved puzzle is being read from the disk. */
  private loading = false;
  private disposed = false;

  constructor(
    private host: GameHost,
    private store: PuzzleStore,
  ) {}

  // ------------------------------------------------------------------ people

  addPlayer(m: Member): boolean {
    this.sendInit(m);
    return true;
  }

  reconnect(m: Member): boolean {
    // A new connection holds nothing. One that replaced a live connection (a phone hopping from
    // Wi-Fi to mobile data mid-drag) never went through disconnect, and its piece stayed "held":
    // nobody else could pick it up.
    this.letGo(m);
    this.sendInit(m);
    return true;
  }

  disconnect(m: Member): string | null {
    this.letGo(m);
    return null;
  }

  removePlayer(m: Member) {
    this.letGo(m);
  }

  renamed() {}

  // ------------------------------------------------------------------ geometry

  private get pw() {
    return this.state!.width / this.state!.cols;
  }

  private get ph() {
    return this.state!.height / this.state!.rows;
  }

  private members(g: number) {
    const out: number[] = [];
    this.state!.pieces.forEach((p, i) => p.g === g && out.push(i));
    return out;
  }

  private moveGroup(g: number, dx: number, dy: number) {
    for (const p of this.state!.pieces) {
      if (p.g !== g) continue;
      p.x += dx;
      p.y += dy;
    }
  }

  /** Keep a dragged piece on the table. */
  private clamp(x: number, y: number) {
    const s = this.state!;
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    return { x: Math.min(b.maxX - this.pw, Math.max(b.minX, x)), y: Math.min(b.maxY - this.ph, Math.max(b.minY, y)) };
  }

  /**
   * Lay pieces out around the frame in a grid of slots (a little jitter each), starting right
   * next to the frame and going out to the table's edge, so they don't pile up. `which`
   * defaults to every piece.
   */
  private scatter(which?: number[]) {
    const s = this.state!;
    const { pw, ph } = this;
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    const cellW = pw * 1.3;
    const cellH = ph * 1.3;
    const pad = Math.min(pw, ph) * 0.6;
    const xs = slotLines(-pad, s.width + pad, cellW, b.minX, b.maxX);
    const ys = slotLines(-pad, s.height + pad, cellH, b.minY, b.maxY);
    // Beside the frame (any row), or above and below it.
    const slots: { x: number; y: number }[] = [];
    for (const x of xs.outside) for (const y of [...ys.outside, ...ys.across]) slots.push({ x, y });
    for (const x of xs.across) for (const y of ys.outside) slots.push({ x, y });
    for (let i = slots.length - 1; i > 0; i--) {
      const j = this.host.randomInt(i + 1);
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    const pieces = which ?? s.pieces.map((_, i) => i);
    pieces.forEach((idx, k) => {
      const slot = slots[k % Math.max(1, slots.length)] ?? { x: b.minX, y: b.minY };
      const jitter = (n: number) => (this.host.randomInt(1000) / 1000 - 0.5) * n;
      s.pieces[idx].x = slot.x + (cellW - pw) / 2 + jitter(pw * 0.2);
      s.pieces[idx].y = slot.y + (cellH - ph) / 2 + jitter(ph * 0.2);
    });
  }

  // ------------------------------------------------------------------ messages out

  private stateMessage(): PuzzleServerMessage {
    return {
      t: 'pz-state',
      phase: this.phase,
      state: this.state,
      held: [...this.held].map(([g, session]) => ({ g, by: this.host.member(session)?.alias ?? '' })),
    };
  }

  sendInit(m: Member, _reclaimed = false) {
    this.host.send(m, this.stateMessage());
    this.host.send(m, this.photosMessage());
  }

  private photosMessage(): PuzzleServerMessage {
    return { t: 'pz-photos', on: !!this.host.photoUploads, photos: this.host.photos?.() ?? [] };
  }

  photosChanged() {
    this.host.broadcast(this.photosMessage());
  }

  usesPhoto(image: string) {
    return this.state?.image === image;
  }

  private broadcastState() {
    this.host.broadcast(this.stateMessage());
  }

  private changed() {
    this.state!.updatedAt = this.host.now();
    this.saveAt ??= this.host.now() + SAVE_DELAY_MS;
  }

  private saveNow() {
    this.saveAt = null;
    const s = this.state;
    if (!s) return;
    // Puzzles of your own photos are never saved: the photo is only in memory, for this table.
    if (photoIdOf(s.image)) return;
    // A puzzle nobody has placed anything in isn't kept (so trying one out leaves no clutter),
    // and a finished one has nothing left to continue.
    if (puzzleUntouched(s) || s.doneAt !== null) this.store.remove(s.id);
    else this.store.save(s);
  }

  /**
   * Whatever `m` is holding comes to rest where it was last dragged to (they dropped out, came
   * back on a new connection, or picked up something else). It rests as a dropped piece does:
   * joined to what it lines up with, and saved. Left loose a hair from its place instead, a later
   * piece could join the frame's group to it and pull the finished part of the picture askew.
   */
  private letGo(m: Member) {
    const h = this.holding.get(m.session);
    if (!h) return;
    if (this.state && this.phase === 'playing') {
      this.drags.delete(m.session); // the resting place below says where it really is
      this.rest(m, h);
      return;
    }
    this.holding.delete(m.session);
    this.held.delete(h.g);
    this.host.broadcast({ t: 'pz-held', g: h.g, by: null });
  }

  // ------------------------------------------------------------------ input

  handle(m: Member, input: GameInput) {
    switch (input.t) {
      case 'pz-new':
        return this.newPuzzle(m, input.image, input.pieces);
      case 'pz-resume':
        return this.resume(m, input.id);
      case 'pz-setup':
        return this.backToSetup(m);
      case 'pz-saves': {
        const now = this.host.now();
        const last = this.savesAskedAt.get(m.session);
        if (last !== undefined && now - last < SAVES_ASK_GAP_MS) return;
        this.savesAskedAt.set(m.session, now);
        const ids = [...new Set(input.ids)].slice(0, SAVES_ASK_MAX);
        this.sendSaves(m, ids).catch((err) => this.host.log('jigsaw_saves_failed', { error: String(err) }));
        return;
      }
      case 'pz-cursor':
        this.cursors.set(m.session, { t: 'pz-cursor', by: m.alias, x: r1(input.x), y: r1(input.y) });
        return;
      case 'pz-grab':
        return this.grab(m, input.piece);
      case 'pz-drag':
        return this.drag(m, input.x, input.y, false);
      case 'pz-drop':
        return this.drag(m, input.x, input.y, true);
      case 'pz-tidy':
        return this.tidy(m);
    }
  }

  private newPuzzle(m: Member, imageId: string, count: number) {
    if (this.phase === 'playing') return;
    const photo = photoIdOf(imageId) ? this.host.photos?.().find((p) => p.image === imageId) : undefined;
    const image = photo ? { id: photo.image, file: photo.url, title: photo.title, width: photo.width, height: photo.height } : puzzleImage(imageId);
    if (!image || !(PIECE_COUNTS as readonly number[]).includes(count)) return;
    if (!this.mayStart(m)) return;
    if (this.state) this.saveNow();
    // A small picture offers fewer pieces (each keeps MIN_PIECE_PX of it across): asking for
    // more gets its most. (The picker greys out the sizes it can't do.)
    const { cols, rows } = gridFor(image.width, image.height, Math.min(count, maxPieces(image.width, image.height)));
    let id = '';
    for (let i = 0; i < 16; i++) id += ID_CHARS[this.host.randomInt(ID_CHARS.length)];
    const now = this.host.now();
    this.state = {
      id,
      image: image.id,
      imageFile: image.file,
      title: image.title,
      width: image.width,
      height: image.height,
      cols,
      rows,
      seed: this.host.randomInt(2 ** 31),
      pieces: Array.from({ length: cols * rows }, (_, i): PieceSpot => ({ x: 0, y: 0, g: i })),
      locked: [],
      createdAt: now,
      updatedAt: now,
      doneAt: null,
    };
    this.scatter();
    this.reset('playing');
    this.saveNow();
    this.host.systemChat(`${m.name} started a ${cols * rows}-piece puzzle: ${image.title}.`);
    this.host.log('jigsaw_new', { image: photo ? 'photo' : image.id, pieces: cols * rows, by: m.pid });
  }

  private resume(m: Member, id: string) {
    if (this.phase === 'playing' || this.loading) return;
    if (!this.mayStart(m)) return;
    this.loading = true;
    const before = this.state;
    this.store
      .load(id)
      .then((s) => {
        this.loading = false;
        // Someone may have started another, or the table moved on, while the disk was read.
        if (this.disposed || this.phase === 'playing' || this.state !== before) return;
        this.resumed(m, id, s);
      })
      .catch((err) => {
        this.loading = false;
        this.host.log('jigsaw_load_failed', { error: String(err) });
      });
  }

  private async sendSaves(m: Member, ids: string[]) {
    const saves = (await Promise.all(ids.map((id) => this.store.summary(id)))).flatMap((s) => s ?? []);
    if (this.disposed) return;
    const found = new Set(saves.map((s) => s.id));
    this.host.send(m, { t: 'pz-saves', saves, gone: ids.filter((id) => !found.has(id)) });
  }

  private resumed(m: Member, id: string, s: PuzzleState | null) {
    if (!s) {
      this.host.send(m, { t: 'pz-saves', saves: [], gone: [id] });
      return;
    }
    if (this.state) this.saveNow();
    this.state = s;
    this.reset(s.doneAt !== null ? 'done' : 'playing');
    const pct = Math.round(puzzleProgress(s.pieces, s.locked) * 100);
    this.host.systemChat(`${m.name} brought back a puzzle: ${s.title} (${pct}% done).`);
    this.host.log('jigsaw_resume', { id: s.id, by: m.pid });
  }

  /** Room for one more puzzle this hour? (If not, the person who asked is told.) */
  private mayStart(m: Member): boolean {
    const now = this.host.now();
    this.starts = this.starts.filter((t) => now - t < 3_600_000);
    if (this.starts.length >= STARTS_PER_HOUR) {
      this.host.systemChat(`That's a lot of puzzles for one hour, ${m.name}. Try again in a few minutes.`);
      return false;
    }
    this.starts.push(now);
    return true;
  }

  private backToSetup(m: Member) {
    if (this.phase === 'setup') return;
    const s = this.state;
    const photo = !!s && !!photoIdOf(s.image);
    const done = !!s && s.doneAt !== null;
    const untouched = !s || puzzleUntouched(s);
    if (s) this.saveNow();
    this.state = null;
    this.reset('setup');
    this.host.systemChat(
      photo
        ? `${m.name} put the puzzle away. Puzzles of your own photos aren't saved.`
        : done
          ? `${m.name} put the finished puzzle away.`
          : untouched
            ? `${m.name} put the puzzle away (nothing was placed, so it wasn't kept).`
            : `${m.name} put the puzzle away (it's saved). Pick another, or continue one.`,
    );
  }

  private reset(phase: PuzzlePhase) {
    this.phase = phase;
    this.held.clear();
    this.holding.clear();
    this.cursors.clear();
    this.drags.clear();
    this.broadcastState();
  }

  private grab(m: Member, piece: number) {
    const s = this.state;
    if (this.phase !== 'playing' || !s || piece >= s.pieces.length) return;
    const g = s.pieces[piece].g;
    const holder = this.held.get(g);
    if (s.locked.includes(g) || (holder && holder !== m.session)) {
      // Tell them who has it (or that it's locked in), so their screen puts it back.
      this.host.send(m, { t: 'pz-held', g, by: holder ? (this.host.member(holder)?.alias ?? '') : '' });
      return;
    }
    this.letGo(m);
    this.held.set(g, m.session);
    this.holding.set(m.session, { g, piece });
    this.host.broadcast({ t: 'pz-held', g, by: m.alias });
  }

  private drag(m: Member, x: number, y: number, drop: boolean) {
    const h = this.holding.get(m.session);
    const s = this.state;
    if (!h || !s || this.phase !== 'playing') return;
    const to = this.clamp(x, y);
    const anchor = s.pieces[h.piece];
    this.moveGroup(h.g, to.x - anchor.x, to.y - anchor.y);
    // Their pointer rides along with the piece, so an older one waiting to go out is out of date.
    this.cursors.delete(m.session);
    if (!drop) {
      this.drags.set(m.session, { t: 'pz-drag', g: h.g, piece: h.piece, x: r1(to.x), y: r1(to.y), by: m.alias });
      return;
    }
    this.drags.delete(m.session); // the drop says where it really is
    this.rest(m, h);
  }

  /** A held group is let go where it is: join it to what it lines up with, tell everyone, save. */
  private rest(m: Member, h: { g: number; piece: number }) {
    const s = this.state!;
    const { g, touched, snapped } = this.snap(h.g);
    this.holding.delete(m.session);
    this.held.delete(h.g);
    this.held.delete(g);
    this.changed();
    this.host.broadcastTogether([
      {
        msg: {
          t: 'pz-moved',
          pieces: touched.map((i) => [i, s.pieces[i].x, s.pieces[i].y, s.pieces[i].g]),
          locked: [...s.locked],
          by: m.alias,
          snapped,
        },
      },
      { msg: { t: 'pz-held', g: h.g, by: null } },
    ]);
    if (snapped) this.host.log('jigsaw_snap', { by: m.pid });
    this.checkDone();
  }

  /**
   * Join a dropped group to any neighbours lined up with it, then lock it into the frame if
   * it's where it belongs. The dropped group moves onto what it joins. Returns the group id
   * it ended up in and every piece that moved or changed group.
   */
  private snap(g0: number): { g: number; touched: number[]; snapped: boolean } {
    const s = this.state!;
    const { pw, ph } = this;
    const tol = SNAP * Math.min(pw, ph);
    let g = g0;
    const touched = new Set(this.members(g));
    let snapped = false;
    for (let joined = true; joined; ) {
      joined = false;
      for (const i of this.members(g)) {
        const r = Math.floor(i / s.cols);
        const c = i % s.cols;
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= s.rows || nc >= s.cols) continue;
          const n = nr * s.cols + nc;
          const other = s.pieces[n].g;
          if (other === g || (this.held.has(other) && other !== g0)) continue;
          const ex = s.pieces[i].x + dc * pw;
          const ey = s.pieces[i].y + dr * ph;
          if (Math.abs(s.pieces[n].x - ex) > tol || Math.abs(s.pieces[n].y - ey) > tol) continue;
          // Line the dropped group up exactly with its new neighbour, then merge. Once it has
          // joined the frame it stays put, and the neighbour comes to it: the frame never moves.
          if (s.locked.includes(g) && !s.locked.includes(other)) this.moveGroup(other, ex - s.pieces[n].x, ey - s.pieces[n].y);
          else this.moveGroup(g, s.pieces[n].x - ex, s.pieces[n].y - ey);
          const wasLocked = s.locked.includes(g) || s.locked.includes(other);
          for (const p of s.pieces) if (p.g === g) p.g = other;
          s.locked = s.locked.filter((x) => x !== g);
          if (wasLocked && !s.locked.includes(other)) s.locked.push(other);
          g = other;
          for (const k of this.members(g)) touched.add(k);
          snapped = joined = true;
          break;
        }
        if (joined) break;
      }
    }
    // Into the frame: the group's pieces are within reach of where they belong.
    if (!s.locked.includes(g)) {
      const i = this.members(g)[0];
      const dx = (i % s.cols) * pw - s.pieces[i].x;
      const dy = Math.floor(i / s.cols) * ph - s.pieces[i].y;
      if (Math.abs(dx) <= tol && Math.abs(dy) <= tol) {
        this.moveGroup(g, dx, dy);
        s.locked.push(g);
        snapped = true;
      }
    }
    return { g, touched: [...touched], snapped };
  }

  private tidy(m: Member) {
    const s = this.state;
    if (!s || this.phase !== 'playing') return;
    const sizes = new Map<number, number>();
    for (const p of s.pieces) sizes.set(p.g, (sizes.get(p.g) ?? 0) + 1);
    // Loose single pieces nobody is holding go back around the edges.
    const loose = s.pieces.flatMap((p, i) => (sizes.get(p.g) === 1 && !this.held.has(p.g) && !s.locked.includes(p.g) ? [i] : []));
    if (!loose.length) return;
    this.scatter(loose);
    this.changed();
    this.host.broadcast({ t: 'pz-moved', pieces: loose.map((i) => [i, s.pieces[i].x, s.pieces[i].y, s.pieces[i].g]), locked: [...s.locked], by: m.alias, snapped: false });
    this.host.systemChat(`${m.name} tidied up the loose pieces.`);
  }

  private checkDone() {
    const s = this.state!;
    if (s.doneAt !== null || new Set(s.pieces.map((p) => p.g)).size > 1) return;
    s.doneAt = this.host.now();
    this.phase = 'done';
    this.saveNow();
    const minutes = Math.max(1, Math.round((s.doneAt - s.createdAt) / 60_000));
    this.host.systemChat(`Puzzle finished! ${s.pieces.length} pieces in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    this.host.log('jigsaw_done', { id: s.id, pieces: s.pieces.length, minutes });
    this.broadcastState();
  }

  // ------------------------------------------------------------------ time

  step() {
    const now = this.host.now();
    if ((this.cursors.size || this.drags.size) && now - this.liveSentAt >= LIVE_GAP_MS) this.sendLive();
    if (this.saveAt !== null && now >= this.saveAt) this.saveNow();
  }

  /** Everybody else's newest pointer or drag, in one frame each. */
  private sendLive() {
    this.liveSentAt = this.host.now();
    const out: Outgoing[] = [];
    for (const waiting of [this.drags, this.cursors]) {
      for (const [session, msg] of waiting) out.push({ msg, except: session });
      waiting.clear();
    }
    this.host.broadcastTogether(out);
  }

  dispose() {
    this.disposed = true;
    if (this.state) this.saveNow();
  }

  stats() {
    return { phase: this.phase, pieces: this.state?.pieces.length ?? 0, progress: this.state ? Math.round(puzzleProgress(this.state.pieces, this.state.locked) * 100) : 0 };
  }
}
