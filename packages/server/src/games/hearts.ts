import {
  botPass,
  botPlay,
  freshBotName,
  deal,
  HEARTS_TARGET,
  HeartsRound,
  passDirFor,
  trickWinner,
  type GameInput,
  type HandResult,
  type HeartsView,
} from '@tank/shared';
import { botPlays, leftLongAgo, TIMER_GAME_TICKS, type GameHost, type Member, type ServerGame } from './types';

/** A finished trick stays on the table this long so everyone sees who took it. */
export const TRICK_PAUSE_MS = 1400;
/** Hand results stay up this long before the next deal. */
export const HAND_END_MS = 6000;
/** Bots (and bots covering for disconnected players) think this long. */
const BOT_PLAY_MS: [number, number] = [700, 1500];
const BOT_PASS_MS: [number, number] = [1200, 2600];

interface Seat {
  /** Member holding this seat, or null for a bot. */
  session: string | null;
  botName: string;
  botColor: number;
  score: number;
}

/**
 * Four seats. Members take seats in the order they arrived; bots fill the rest and play for
 * anyone who disconnects. Each player only ever receives their own cards.
 */
export class HeartsGame implements ServerGame {
  readonly id = 'hearts' as const;
  readonly tickEvery = TIMER_GAME_TICKS;
  readonly capacity = 4;
  seats: Seat[];
  round!: HeartsRound;
  handNumber = 0;
  history: number[][] = [];
  phase: HeartsView['phase'] = 'passing';
  result: HandResult | null = null;
  winners: number[] = [];
  /** When the finished trick on the table gets collected. */
  private collectAt: number | null = null;
  private nextHandAt: number | null = null;
  private botAt = 0;

  /** The host's random numbers, in the shape the name picker wants. */
  private dice = { int: (min: number, max: number) => min + this.host.randomInt(max - min + 1) };

  constructor(private host: GameHost) {
    const used = new Set(host.members().map((m) => m.name.toLowerCase()));
    const colors = new Set(host.members().map((m) => m.color));
    this.seats = [0, 1, 2, 3].map(() => {
      const botName = freshBotName(used, this.dice);
      used.add(botName.toLowerCase());
      let botColor = 0;
      while (colors.has(botColor)) botColor++;
      colors.add(botColor);
      return { session: null, botName, botColor, score: 0 };
    });
    this.startHand();
  }

  // ------------------------------------------------------------------ seats

  seatOf(session: string): number | null {
    const i = this.seats.findIndex((s) => s.session === session);
    return i >= 0 ? i : null;
  }

  private memberAt(seat: number): Member | undefined {
    const s = this.seats[seat].session;
    return s ? this.host.member(s) : undefined;
  }

  /** True when nobody is at the seat to play it right now (bot, or player disconnected). */
  private botControls(seat: number) {
    return botPlays(this.memberAt(seat), this.host.now());
  }

  /**
   * Someone at the table is still choosing cards to pass. Bots hold their own passes until
   * then, so a friend who sits down mid-pass (taking a bot's seat) still gets to choose.
   */
  private peopleStillPassing() {
    return this.seats.some((_, i) => !this.botControls(i) && !this.round.passes[i]);
  }

  addPlayer(m: Member, seat?: number): boolean {
    if (this.seatOf(m.session) !== null) return true;
    // The seat they picked at the table, if it's free; otherwise the first free one.
    const free = seat !== undefined && this.seats[seat]?.session === null ? seat : this.seats.findIndex((s) => s.session === null);
    if (free < 0) {
      // Watching: the room has more people than seats.
      this.sendInit(m, false);
      return true;
    }
    this.seats[free].session = m.session;
    this.renameClashingBots(m.name);
    this.host.log('hearts_seat', { pid: m.pid, seat: free });
    this.schedule();
    this.sync();
    return true;
  }

  reconnect(m: Member): boolean {
    const had = this.seatOf(m.session) !== null;
    if (!had) this.addPlayer(m);
    this.sync();
    return had;
  }

  disconnect(m: Member): string | null {
    if (this.seatOf(m.session) === null) return null;
    this.schedule();
    this.sync();
    return 'If they’re not back soon, the computer plays their cards until they are.';
  }

  removePlayer(m: Member) {
    const seat = this.seatOf(m.session);
    if (seat === null) return;
    this.seats[seat].session = null;
    // Someone watching can take the seat.
    const watcher = this.host.members().find((o) => o.session !== m.session && this.seatOf(o.session) === null && !leftLongAgo(o, this.host.now()));
    if (watcher) this.seats[seat].session = watcher.session;
    this.schedule();
    this.sync();
  }

  renamed(m: Member) {
    this.renameClashingBots(m.name);
    this.sync();
  }

  private renameClashingBots(name: string) {
    const lower = name.toLowerCase();
    const taken = new Set(this.host.members().map((o) => o.name.toLowerCase()));
    for (const s of this.seats) taken.add(s.botName.toLowerCase());
    for (const s of this.seats) {
      if (s.session === null && s.botName.toLowerCase() === lower) {
        s.botName = freshBotName(taken, this.dice);
        taken.add(s.botName.toLowerCase());
      }
    }
  }

  // ------------------------------------------------------------------ flow

  private startHand() {
    this.handNumber++;
    this.round = new HeartsRound(
      deal((n) => this.host.randomInt(n)),
      passDirFor(this.handNumber),
    );
    this.phase = this.round.phase === 'passing' ? 'passing' : 'playing';
    this.result = null;
    this.collectAt = null;
    this.nextHandAt = null;
    this.schedule();
  }

  private newGame() {
    for (const s of this.seats) s.score = 0;
    this.history = [];
    this.winners = [];
    this.handNumber = 0;
    this.startHand();
    this.host.log('hearts_new_game', {});
  }

  /** Give the next bot move a human-feeling delay. */
  private schedule() {
    const [lo, hi] = this.phase === 'passing' ? BOT_PASS_MS : BOT_PLAY_MS;
    this.botAt = this.host.now() + lo + this.host.randomInt(hi - lo);
  }

  private endHand() {
    const result = this.round.result();
    this.result = result;
    for (let i = 0; i < 4; i++) this.seats[i].score += result.points[i];
    this.history.push(this.seats.map((s) => s.score));
    if (result.moon !== null) this.host.systemChat(`${this.nameOf(result.moon)} shot the moon!`);
    this.host.log('hearts_hand', { hand: this.handNumber, points: result.points, moon: result.moon });
    if (this.seats.some((s) => s.score >= HEARTS_TARGET)) {
      const low = Math.min(...this.seats.map((s) => s.score));
      this.winners = this.seats.flatMap((s, i) => (s.score === low ? [i] : []));
      this.phase = 'gameOver';
      const names = this.winners.map((i) => this.nameOf(i));
      this.host.systemChat(`${names.join(' and ')} won Hearts!`);
      this.host.log('hearts_game_over', { scores: this.seats.map((s) => s.score), winners: this.winners });
    } else {
      this.phase = 'handEnd';
      this.nextHandAt = this.host.now() + HAND_END_MS;
    }
  }

  private nameOf(seat: number) {
    return this.memberAt(seat)?.name ?? this.seats[seat].botName;
  }

  // ------------------------------------------------------------------ input

  handle(m: Member, input: GameInput) {
    const seat = this.seatOf(m.session);
    if (input.t === 'again') {
      if (this.phase === 'gameOver' && seat !== null) {
        this.host.systemChat(`${m.name} dealt a new game.`);
        this.newGame();
        this.sync();
      }
      return;
    }
    if (seat === null) return;
    if (input.t === 'pass') {
      if (this.phase !== 'passing') return;
      if (!this.round.submitPass(seat, input.cards)) return;
      this.afterPass();
      this.sync();
    } else if (input.t === 'play') {
      if (this.phase !== 'playing' || this.collectAt !== null) return;
      if (!this.round.play(seat, input.card)) return;
      this.afterPlay();
      this.sync();
    }
  }

  private afterPass() {
    if (this.round.phase === 'playing') this.phase = 'playing';
    // Bots pass a moment after the last person does (and the first play gets a fresh delay).
    this.schedule();
  }

  private afterPlay() {
    if (this.round.trickComplete) this.collectAt = this.host.now() + TRICK_PAUSE_MS;
    else this.schedule();
  }

  // ------------------------------------------------------------------ time

  step() {
    const now = this.host.now();
    let changed = false;
    if (this.collectAt !== null && now >= this.collectAt) {
      this.collectAt = null;
      this.round.collect();
      if (this.round.phase === 'done') this.endHand();
      else this.schedule();
      changed = true;
    }
    if (this.phase === 'handEnd' && this.nextHandAt !== null && now >= this.nextHandAt) {
      this.startHand();
      changed = true;
    }
    if (now >= this.botAt) {
      if (this.phase === 'passing' && !this.peopleStillPassing()) {
        for (let s = 0; s < 4 && this.phase === 'passing'; s++) {
          if (this.round.passes[s] || !this.botControls(s)) continue;
          this.round.submitPass(s, botPass(this.round.hands[s]));
          this.afterPass();
          changed = true;
        }
      } else if (this.phase === 'playing' && this.collectAt === null && this.round.turn >= 0 && this.botControls(this.round.turn)) {
        const seat = this.round.turn;
        this.round.play(seat, botPlay(this.round, seat));
        this.afterPlay();
        changed = true;
      }
    }
    if (changed) this.sync();
  }

  // ------------------------------------------------------------------ views

  viewFor(session: string | null): HeartsView {
    const seat = session !== null ? this.seatOf(session) : null;
    const r = this.round;
    const live = this.phase === 'passing' || this.phase === 'playing';
    return {
      seat,
      phase: this.phase,
      hand: this.handNumber,
      passDir: r.passDir,
      seats: this.seats.map((s, i) => {
        const m = this.memberAt(i);
        return {
          name: m?.name ?? s.botName,
          alias: m?.alias ?? null,
          color: m?.color ?? s.botColor,
          bot: !m,
          away: !!m && !m.conn,
          score: s.score,
          taken: r.takenPoints()[i],
          cards: r.hands[i].length,
          passed: !!r.passes[i],
        };
      }),
      cards: seat !== null && live ? [...r.hands[seat]] : [],
      legal: seat !== null && this.collectAt === null ? r.legal(seat) : [],
      passing: seat !== null && this.phase === 'passing' ? r.passes[seat] : null,
      received: seat !== null && live ? [...r.received[seat]] : [],
      trick: r.trick.map((t) => ({ ...t })),
      trickWinner: this.collectAt !== null && r.trickComplete ? trickWinner(r.trick) : null,
      turn: this.phase === 'playing' && r.turn >= 0 ? r.turn : null,
      heartsBroken: r.heartsBroken,
      history: this.history.map((h) => [...h]),
      result: this.result,
      winners: [...this.winners],
      target: HEARTS_TARGET,
    };
  }

  sendInit(m: Member, _reclaimed = false) {
    this.host.send(m, { t: 'hearts', view: this.viewFor(m.session) });
  }

  /** Everyone gets their own view after any change. */
  private sync() {
    for (const m of this.host.members()) if (m.conn) this.host.send(m, { t: 'hearts', view: this.viewFor(m.session) });
  }

  dispose() {}

  stats() {
    return { hand: this.handNumber, phase: this.phase, bots: this.seats.filter((_, i) => this.botControls(i)).length };
  }
}
