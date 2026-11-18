import {
  cloneLayout,
  dealDominoes,
  DOMINOES_RULES,
  dominoesBotMove,
  DominoesRound,
  endCount,
  freshName,
  type DominoesView,
  type GameInput,
} from '@tank/shared';
import type { GameHost, Member, ServerGame } from './types';
import { HAND_END_MS } from './hearts';

/** Bots (and bots covering for disconnected players) think this long. */
const BOT_PLAY_MS: [number, number] = [900, 1700];
/** Drawing from the boneyard is quicker, one tile at a time. */
const BOT_DRAW_MS: [number, number] = [350, 650];
/** Someone stuck with an empty boneyard passes by themselves after this long. */
const PASS_MS = 1300;

interface Seat {
  session: string | null;
  botName: string;
  botColor: number;
  score: number;
}

/**
 * Dominoes (All Fives) for four seats, everyone for themselves. Members take seats in the
 * order they arrived; bots fill the rest and play for anyone who disconnects. Each player only
 * ever sees their own tiles.
 */
export class DominoesGame implements ServerGame {
  readonly id = 'dominoes' as const;
  readonly capacity = 4;
  seats: Seat[];
  round!: DominoesRound;
  handNumber = 0;
  history: number[][] = [];
  phase: DominoesView['phase'] = 'playing';
  winners: number[] = [];
  /** Between hands: seats whose player said they're ready for the next one. */
  ready = new Set<number>();
  /** With nobody at the table (only bots and absent players), the next hand starts at this time. */
  private nextHandAt: number | null = null;
  private botAt = 0;
  private lastLeader: number | undefined;
  private dice = { int: (min: number, max: number) => min + this.host.randomInt(max - min + 1) };

  constructor(private host: GameHost) {
    const used = new Set(host.members().map((m) => m.name.toLowerCase()));
    const colors = new Set(host.members().map((m) => m.color));
    this.seats = [0, 1, 2, 3].map(() => {
      const botName = freshName(used, this.dice);
      used.add(botName.toLowerCase());
      let botColor = 0;
      while (colors.has(botColor)) botColor++;
      colors.add(botColor);
      return { session: null, botName, botColor, score: 0 };
    });
    this.startHand(undefined);
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
    return !this.memberAt(seat)?.conn;
  }

  private nameOf(seat: number) {
    return this.memberAt(seat)?.name ?? this.seats[seat].botName;
  }

  addPlayer(m: Member): boolean {
    if (this.seatOf(m.session) !== null) return true;
    const free = this.seats.findIndex((s) => s.session === null);
    if (free < 0) {
      this.sendInit(m, false);
      return true;
    }
    this.seats[free].session = m.session;
    this.renameClashingBots(m.name);
    this.host.log('dominoes_seat', { pid: m.pid, seat: free });
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
    return 'A bot will play their tiles.';
  }

  removePlayer(m: Member) {
    const seat = this.seatOf(m.session);
    if (seat === null) return;
    this.seats[seat].session = null;
    const watcher = this.host.members().find((o) => o.session !== m.session && this.seatOf(o.session) === null);
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
        s.botName = freshName(taken, this.dice);
        taken.add(s.botName.toLowerCase());
      }
    }
  }

  // ------------------------------------------------------------------ flow

  /** `leader` undefined: the first hand, led by the highest double. */
  private startHand(leader: number | undefined) {
    this.handNumber++;
    this.round = new DominoesRound(dealDominoes((n) => this.host.randomInt(n)), { leader });
    this.lastLeader = this.round.turn;
    this.phase = 'playing';
    this.nextHandAt = null;
    this.ready.clear();
    this.schedule();
  }

  /**
   * Between hands, everyone gets to look at the board and the scores: the next hand waits until
   * every player at the table says they're ready. Bots and players who have dropped out don't
   * hold it up; a table with nobody at it moves on after a short pause.
   */
  private nextHandIfReady(): boolean {
    if (this.phase !== 'handEnd') return false;
    const people = this.seats.map((_, i) => i).filter((i) => !this.botControls(i));
    const go = people.length ? people.every((i) => this.ready.has(i)) : this.nextHandAt !== null && this.host.now() >= this.nextHandAt;
    if (!go) return false;
    // The last hand's winner leads; after a blocked tie, the next player along.
    const res = this.round.result;
    this.startHand(res?.winner ?? ((this.lastLeader ?? 0) + 1) % 4);
    return true;
  }

  private newGame() {
    for (const s of this.seats) s.score = 0;
    this.history = [];
    this.winners = [];
    this.handNumber = 0;
    this.startHand(undefined);
    this.host.log('dominoes_new_game', {});
  }

  private schedule(ms?: [number, number]) {
    const [lo, hi] = ms ?? BOT_PLAY_MS;
    this.botAt = this.host.now() + lo + this.host.randomInt(hi - lo);
  }

  /** After any points: reaching the target ends the game, even mid-hand. */
  private checkWin(): boolean {
    const top = Math.max(...this.seats.map((s) => s.score));
    if (top < DOMINOES_RULES.target) return false;
    this.winners = this.seats.flatMap((s, i) => (s.score === top ? [i] : []));
    this.phase = 'gameOver';
    this.history.push(this.seats.map((s) => s.score));
    this.host.systemChat(`${this.winners.map((i) => this.nameOf(i)).join(' and ')} won Dominoes!`);
    this.host.log('dominoes_game_over', { scores: this.seats.map((s) => s.score), winners: this.winners });
    return true;
  }

  private afterMove() {
    const r = this.round;
    if (r.phase === 'done') {
      const res = r.result!;
      if (res.winner !== null) this.seats[res.winner].score += res.points;
      this.host.log('dominoes_hand', { hand: this.handNumber, winner: res.winner, blocked: res.blocked, points: res.points });
      if (this.checkWin()) return;
      this.history.push(this.seats.map((s) => s.score));
      this.phase = 'handEnd';
      this.ready.clear();
      this.nextHandAt = this.host.now() + HAND_END_MS;
      return;
    }
    this.schedule();
  }

  private playMove(seat: number, tile: string, arm: string): boolean {
    const points = this.round.play(seat, tile, arm);
    if (points === null) return false;
    if (points) {
      this.seats[seat].score += points;
      if (this.checkWin()) return true;
    }
    this.afterMove();
    return true;
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
      if (this.phase === 'handEnd' && seat !== null && !this.ready.has(seat)) {
        this.ready.add(seat);
        this.nextHandIfReady();
        this.sync();
      }
      return;
    }
    if (seat === null || this.phase !== 'playing') return;
    if (input.t === 'place') {
      if (this.playMove(seat, input.tile, input.arm)) this.sync();
    } else if (input.t === 'draw') {
      if (this.round.draw(seat)) {
        this.schedule();
        this.sync();
      }
    }
  }

  // ------------------------------------------------------------------ time

  step() {
    const now = this.host.now();
    let changed = false;
    // Someone we were waiting on may have dropped out.
    if (this.nextHandIfReady()) changed = true;
    const r = this.round;
    if (this.phase === 'playing' && r.phase === 'playing' && now >= this.botAt) {
      const seat = r.turn;
      if (r.mustPass(seat)) {
        // Nobody can do anything else here, person or bot.
        if (now >= this.botAt + (this.botControls(seat) ? 0 : PASS_MS - BOT_PLAY_MS[0])) {
          r.pass(seat);
          this.afterMove();
          changed = true;
        }
      } else if (this.botControls(seat)) {
        const move = dominoesBotMove(r, seat, () => this.host.randomInt(100) / 50);
        if (move) changed = this.playMove(seat, move.tile, move.arm) || changed;
        else if (r.draw(seat)) {
          this.schedule(BOT_DRAW_MS);
          changed = true;
        }
      }
    }
    if (changed) this.sync();
  }

  // ------------------------------------------------------------------ views

  viewFor(session: string | null): DominoesView {
    const seat = session !== null ? this.seatOf(session) : null;
    const r = this.round;
    const playing = this.phase === 'playing';
    return {
      seat,
      phase: this.phase,
      hand: this.handNumber,
      seats: this.seats.map((s, i) => {
        const m = this.memberAt(i);
        return {
          name: m?.name ?? s.botName,
          alias: m?.alias ?? null,
          color: m?.color ?? s.botColor,
          bot: !m,
          away: !!m && !m.conn,
          score: s.score,
          tiles: r.hands[i].length,
        };
      }),
      layout: cloneLayout(r.layout),
      count: endCount(r.layout),
      boneyard: r.boneyard.length,
      tiles: seat !== null ? [...r.hands[seat]] : [],
      moves: seat !== null && playing ? r.moves(seat) : [],
      mustDraw: seat !== null && playing && r.mustDraw(seat),
      turn: playing && r.turn >= 0 ? r.turn : null,
      lastPlay: r.lastPlay,
      result: r.result,
      history: this.history.map((h) => [...h]),
      ready: [...this.ready].sort((x, y) => x - y),
      winners: [...this.winners],
      target: DOMINOES_RULES.target,
    };
  }

  sendInit(m: Member, _reclaimed = false) {
    this.host.send(m, { t: 'dominoes', view: this.viewFor(m.session) });
  }

  private sync() {
    for (const m of this.host.members()) if (m.conn) this.host.send(m, { t: 'dominoes', view: this.viewFor(m.session) });
  }

  dispose() {}

  stats() {
    return { hand: this.handNumber, phase: this.phase, scores: this.seats.map((s) => s.score), bots: this.seats.filter((_, i) => this.botControls(i)).length };
  }
}
