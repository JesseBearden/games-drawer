import {
  CARD_BACK_COUNT,
  freshBotName,
  SEAT_FILL_ORDER,
  ThreeThirteenRound,
  ttBotDiscard,
  ttBotTakesDiscard,
  TT_ROUNDS,
  TT_SEATS,
  wildRankOf,
  type GameInput,
  type ThreeThirteenView,
} from '@tank/shared';
import { botPlays, leftLongAgo, TIMER_GAME_TICKS, type GameHost, type Member, type ServerGame } from './types';
import { HAND_END_MS } from './hearts';

/** Computer players (and computers covering for disconnected players) think this long. */
const BOT_DRAW_MS: [number, number] = [700, 1300];
const BOT_DISCARD_MS: [number, number] = [800, 1600];

interface Seat {
  /** Member holding this seat, or null for a computer player. */
  session: string | null;
  botName: string;
  botColor: number;
  score: number;
}

/**
 * Three Thirteen for 2 to 4 players, everyone for themselves, 11 rounds. The table picks how many
 * play; people take the seats they picked, computers fill the rest of that many (and play for
 * anyone who drops out). Seats not in play get no cards. Each player only ever sees their own
 * cards (and the top of the discards).
 */
export class ThreeThirteenGame implements ServerGame {
  readonly id = 'threethirteen' as const;
  readonly tickEvery = TIMER_GAME_TICKS;
  readonly capacity = TT_SEATS;
  seats: Seat[];
  round!: ThreeThirteenRound;
  roundNumber = 0;
  history: number[][] = [];
  phase: ThreeThirteenView['phase'] = 'playing';
  winners: number[] = [];
  /** Between rounds: seats whose player said they're ready for the next one. */
  ready = new Set<number>();
  /** With nobody at the table (only computers and absent players), the next round starts at this time. */
  private nextRoundAt: number | null = null;
  private botAt = 0;
  /** This game's card back, picked at random for the whole table. */
  private back = 1;
  private dice = { int: (min: number, max: number) => min + this.host.randomInt(max - min + 1) };

  /** The seats in play this game, in seat order. */
  readonly active: number[];

  constructor(
    private host: GameHost,
    table?: { players: number; seats: (string | null)[] },
  ) {
    const used = new Set(host.members().map((m) => m.name.toLowerCase()));
    const colors = new Set(host.members().map((m) => m.color));
    this.seats = Array.from({ length: TT_SEATS }, () => {
      const botName = freshBotName(used, this.dice);
      used.add(botName.toLowerCase());
      let botColor = 0;
      while (colors.has(botColor)) botColor++;
      colors.add(botColor);
      return { session: null, botName, botColor, score: 0 };
    });
    // In play: the seats people picked, then free ones (across first) up to how many play (never
    // fewer than the people here, never fewer than 2). Someone who left long ago isn't one of
    // them, unless they'd picked a seat.
    const sessions = new Set(host.members().map((m) => m.session));
    const picked = (table?.seats ?? []).flatMap((s, i) => (s && sessions.has(s) ? [i] : []));
    const playing = host.members().filter((m) => table?.seats.includes(m.session) || !leftLongAgo(m, host.now()));
    const count = Math.max(2, Math.min(TT_SEATS, Math.max(table?.players ?? TT_SEATS, playing.length)));
    const active = new Set(picked);
    for (const i of SEAT_FILL_ORDER) if (active.size < count) active.add(i);
    this.active = [...active].sort((a, b) => a - b);
    this.back = 1 + host.randomInt(CARD_BACK_COUNT);
    this.startRound();
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

  private botControls(seat: number) {
    return botPlays(this.memberAt(seat), this.host.now());
  }

  private nameOf(seat: number) {
    return this.memberAt(seat)?.name ?? this.seats[seat].botName;
  }

  addPlayer(m: Member, seat?: number): boolean {
    if (this.seatOf(m.session) !== null) return true;
    // The seat they picked at the table, if it's in play and free; otherwise the first free one.
    const open = (i: number) => this.active.includes(i) && this.seats[i]?.session === null;
    const free = seat !== undefined && open(seat) ? seat : this.active.find(open) ?? -1;
    if (free < 0) {
      this.sendInit(m, false);
      return true;
    }
    this.seats[free].session = m.session;
    this.renameClashingBots(m.name);
    this.host.log('threethirteen_seat', { pid: m.pid, seat: free });
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
    const watcher = this.active.includes(seat) ? this.host.members().find((o) => o.session !== m.session && this.seatOf(o.session) === null && !leftLongAgo(o, this.host.now())) : undefined;
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

  private startRound() {
    this.roundNumber++;
    // The deal moves round the seats in play; round 1's dealer is the last of them, so the first starts.
    const n = this.active.length;
    const first = (this.roundNumber - 1) % n;
    const dealer = this.active[(first - 1 + n) % n];
    this.round = new ThreeThirteenRound(this.roundNumber, dealer, (k) => this.host.randomInt(k), this.active);
    this.phase = 'playing';
    this.nextRoundAt = null;
    this.ready.clear();
    this.schedule();
  }

  /**
   * Between rounds, everyone looks at the hands and the scores: the next round waits until every
   * player at the table says they're ready. Computers and players who have dropped out don't hold
   * it up; a table with nobody at it moves on after a short pause.
   */
  private nextRoundIfReady(): boolean {
    if (this.phase !== 'roundEnd') return false;
    const people = this.active.filter((i) => !this.botControls(i));
    const go = people.length ? people.every((i) => this.ready.has(i)) : this.nextRoundAt !== null && this.host.now() >= this.nextRoundAt;
    if (!go) return false;
    this.startRound();
    return true;
  }

  private newGame() {
    for (const s of this.seats) s.score = 0;
    this.history = [];
    this.winners = [];
    this.roundNumber = 0;
    this.back = 1 + this.host.randomInt(CARD_BACK_COUNT);
    this.startRound();
    this.host.log('threethirteen_new_game', {});
  }

  private schedule() {
    const [lo, hi] = this.round?.step === 'discard' ? BOT_DISCARD_MS : BOT_DRAW_MS;
    this.botAt = this.host.now() + lo + this.host.randomInt(hi - lo);
  }

  /** After a throw-away: someone may have gone out, or the round may be over. */
  private afterDiscard(seat: number, wasOut: number | null) {
    const r = this.round;
    if (wasOut === null && r.outSeat !== null) this.host.systemChat(`${this.nameOf(seat)} went out!`);
    if (r.phase === 'done') this.endRound();
    else this.schedule();
  }

  private endRound() {
    const res = this.round.result!;
    res.forEach((x, i) => (this.seats[i].score += x.points));
    this.history.push(this.seats.map((s) => s.score));
    this.host.log('threethirteen_round', { round: this.roundNumber, out: this.round.outSeat, points: res.map((x) => x.points) });
    if (this.roundNumber >= TT_ROUNDS) {
      const low = Math.min(...this.active.map((i) => this.seats[i].score));
      this.winners = this.active.filter((i) => this.seats[i].score === low);
      this.phase = 'gameOver';
      this.host.systemChat(`${this.winners.map((i) => this.nameOf(i)).join(' and ')} won Three Thirteen!`);
      this.host.log('threethirteen_game_over', { scores: this.seats.map((s) => s.score), winners: this.winners });
      return;
    }
    this.phase = 'roundEnd';
    this.ready.clear();
    this.nextRoundAt = this.host.now() + HAND_END_MS;
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
    if (input.t === 'ready') {
      if (this.phase === 'roundEnd' && seat !== null && !this.ready.has(seat)) {
        this.ready.add(seat);
        this.nextRoundIfReady();
        this.sync();
      }
      return;
    }
    if (seat === null || this.phase !== 'playing') return;
    const r = this.round;
    if (input.t === 'tt-draw') {
      if (r.draw(seat, input.from)) {
        this.schedule();
        this.sync();
      }
    } else if (input.t === 'tt-discard') {
      const wasOut = r.outSeat;
      if (r.throwAway(seat, input.card)) {
        this.afterDiscard(seat, wasOut);
        this.sync();
      }
    } else if (input.t === 'tt-arrange') {
      // Only the player's own view changes.
      if (r.arrange(seat, input.cards)) this.host.send(m, { t: 'threethirteen', view: this.viewFor(m.session) });
    }
  }

  // ------------------------------------------------------------------ time

  step() {
    const now = this.host.now();
    let changed = false;
    // Someone we were waiting on may have dropped out.
    if (this.nextRoundIfReady()) changed = true;
    const r = this.round;
    if (this.phase === 'playing' && r.phase === 'playing' && now >= this.botAt && this.botControls(r.turn)) {
      const seat = r.turn;
      if (r.step === 'draw') {
        r.draw(seat, ttBotTakesDiscard(r, seat) ? 'discard' : 'stock');
        this.schedule();
      } else {
        const wasOut = r.outSeat;
        r.throwAway(seat, ttBotDiscard(r, seat));
        this.afterDiscard(seat, wasOut);
      }
      changed = true;
    }
    if (changed) this.sync();
  }

  // ------------------------------------------------------------------ views

  viewFor(session: string | null): ThreeThirteenView {
    const seat = session !== null ? this.seatOf(session) : null;
    const r = this.round;
    const playing = this.phase === 'playing' && r.phase === 'playing';
    const mine = seat !== null ? r.hands[seat] : null;
    const myTurn = playing && seat !== null && r.turn === seat;
    return {
      seat,
      phase: this.phase,
      round: this.roundNumber,
      rounds: TT_ROUNDS,
      wild: wildRankOf(this.roundNumber),
      back: this.back,
      dealer: r.dealer,
      seats: this.seats.map((s, i) => {
        const m = this.memberAt(i);
        return {
          name: m?.name ?? s.botName,
          alias: m?.alias ?? null,
          color: m?.color ?? s.botColor,
          bot: !m,
          away: !!m && !m.conn,
          score: s.score,
          cards: r.hands[i].length,
          out: r.outSeat === i,
          playing: this.active.includes(i),
        };
      }),
      cards: mine ? [...mine] : [],
      plan: mine ? r.plan(mine) : null,
      turn: playing ? r.turn : null,
      step: r.step,
      stock: r.stock.length,
      discardTop: r.discardTop,
      tookFromDiscard: myTurn ? r.tookFromDiscard : null,
      goOut: myTurn && r.outSeat === null ? r.goOutCard(seat) : null,
      outSeat: r.outSeat,
      lastDiscard: r.lastDiscard,
      result: r.result,
      history: this.history.map((h) => [...h]),
      ready: [...this.ready].sort((x, y) => x - y),
      winners: [...this.winners],
    };
  }

  sendInit(m: Member, _reclaimed = false) {
    this.host.send(m, { t: 'threethirteen', view: this.viewFor(m.session) });
  }

  private sync() {
    for (const m of this.host.members()) if (m.conn) this.host.send(m, { t: 'threethirteen', view: this.viewFor(m.session) });
  }

  dispose() {}

  stats() {
    return { round: this.roundNumber, phase: this.phase, scores: this.seats.map((s) => s.score), players: this.active.length, bots: this.active.filter((i) => this.botControls(i)).length };
  }
}
