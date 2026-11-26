import {
  deal,
  freshBotName,
  scoreSpadesHand,
  spadesBotBid,
  spadesBotPlay,
  SpadesRound,
  spadesTrickWinner,
  spadesWinners,
  SPADES_TARGET,
  partnerOf,
  teamOf,
  type GameInput,
  type SpadesView,
  type TeamHandResult,
} from '@tank/shared';
import { botPlays, leftLongAgo, TIMER_GAME_TICKS, watchersTakeSeats, type GameHost, type Member, type ServerGame } from './types';
import { HAND_END_MS, TRICK_PAUSE_MS } from './hearts';

/** Bots (and bots covering for disconnected players) think this long. */
const BOT_PLAY_MS: [number, number] = [700, 1500];
const BOT_BID_MS: [number, number] = [900, 2200];

interface Seat {
  /** Member holding this seat, or null for a bot. */
  session: string | null;
  botName: string;
  botColor: number;
}

/**
 * Partnership Spades: seats 0 and 2 play together against 1 and 3. Members take seats in the
 * order they arrived (so the first two people are opponents, and a third partners the first);
 * bots fill the rest and play for anyone who disconnects. Each player only ever receives
 * their own cards.
 */
export class SpadesGame implements ServerGame {
  readonly id = 'spades' as const;
  readonly tickEvery = TIMER_GAME_TICKS;
  readonly capacity = 4;
  seats: Seat[];
  round!: SpadesRound;
  handNumber = 0;
  scores = [0, 0];
  bags = [0, 0];
  history: number[][] = [];
  phase: SpadesView['phase'] = 'bidding';
  result: TeamHandResult[] | null = null;
  winners: number[] = [];
  private collectAt: number | null = null;
  private nextHandAt: number | null = null;
  private botAt = 0;
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
      return { session: null, botName, botColor };
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

  private botControls(seat: number) {
    return botPlays(this.memberAt(seat), this.host.now());
  }

  private nameOf(seat: number) {
    return this.memberAt(seat)?.name ?? this.seats[seat].botName;
  }

  addPlayer(m: Member, seat?: number): boolean {
    if (this.seatOf(m.session) !== null) return true;
    // The seat they picked at the table, if it's free; otherwise the first free one.
    const free = seat !== undefined && this.seats[seat]?.session === null ? seat : this.seats.findIndex((s) => s.session === null);
    if (free < 0) {
      this.sendInit(m, false);
      return true;
    }
    this.seats[free].session = m.session;
    this.renameClashingBots(m.name);
    this.host.log('spades_seat', { pid: m.pid, seat: free });
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

  removePlayer(m: Member, opts?: { comingBack?: boolean }) {
    const seat = this.seatOf(m.session);
    if (seat === null) return;
    this.seats[seat].session = null;
    // (Not when they're coming straight back in a new tab: the seat is still theirs.)
    const watcher = opts?.comingBack ? undefined : this.host.members().find((o) => o.session !== m.session && this.seatOf(o.session) === null && !leftLongAgo(o, this.host.now()));
    if (watcher) this.seats[seat].session = watcher.session;
    this.schedule();
    this.sync();
  }

  seatWatchers() {
    const moved = watchersTakeSeats(this.host, this.seats, [0, 1, 2, 3]);
    if (!moved.length) return;
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
    // The deal moves round the table; hand 1's dealer sits right of seat 0, so seat 0 bids first.
    const dealer = (this.handNumber + 2) % 4;
    this.round = new SpadesRound(
      deal((n) => this.host.randomInt(n)),
      dealer,
    );
    this.phase = 'bidding';
    this.result = null;
    this.collectAt = null;
    this.nextHandAt = null;
    this.schedule();
  }

  private newGame() {
    this.scores = [0, 0];
    this.bags = [0, 0];
    this.history = [];
    this.winners = [];
    this.handNumber = 0;
    this.startHand();
    this.host.log('spades_new_game', {});
  }

  private schedule() {
    const [lo, hi] = this.phase === 'bidding' ? BOT_BID_MS : BOT_PLAY_MS;
    this.botAt = this.host.now() + lo + this.host.randomInt(hi - lo);
  }

  private endHand() {
    const r = this.round;
    const result = scoreSpadesHand(
      r.bids.map((b) => b ?? 0),
      r.tricks,
      this.bags,
    );
    this.result = result;
    for (const t of [0, 1]) {
      this.scores[t] += result[t].points;
      this.bags[t] = result[t].bagsAfter;
    }
    this.history.push([...this.scores]);
    for (const t of result) for (const n of t.nils) if (n.made) this.host.systemChat(`${this.nameOf(n.seat)} made nil!`);
    this.host.log('spades_hand', { hand: this.handNumber, bids: r.bids, tricks: r.tricks, scores: this.scores });
    const winners = spadesWinners(this.scores);
    if (winners) {
      this.winners = winners;
      this.phase = 'gameOver';
      const names = winners.flatMap((t) => [t, t + 2].map((s) => this.nameOf(s)));
      this.host.systemChat(`${names.join(' and ')} won Spades!`);
      this.host.log('spades_game_over', { scores: this.scores, winners });
    } else {
      this.phase = 'handEnd';
      this.nextHandAt = this.host.now() + HAND_END_MS;
    }
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
    if (input.t === 'bid') {
      if (this.phase !== 'bidding' || !this.round.bid(seat, input.bid)) return;
      this.afterBid();
      this.sync();
    } else if (input.t === 'play') {
      if (this.phase !== 'playing' || this.collectAt !== null) return;
      if (!this.round.play(seat, input.card)) return;
      this.afterPlay();
      this.sync();
    }
  }

  private afterBid() {
    if (this.round.phase === 'playing') this.phase = 'playing';
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
    const r = this.round;
    if (now >= this.botAt && r.turn >= 0 && this.botControls(r.turn)) {
      const seat = r.turn;
      if (this.phase === 'bidding') {
        r.bid(seat, spadesBotBid(r.hands[seat], r.bids[partnerOf(seat)]));
        this.afterBid();
        changed = true;
      } else if (this.phase === 'playing' && this.collectAt === null) {
        r.play(seat, spadesBotPlay(r, seat));
        this.afterPlay();
        changed = true;
      }
    }
    if (changed) this.sync();
  }

  // ------------------------------------------------------------------ views

  viewFor(session: string | null): SpadesView {
    const seat = session !== null ? this.seatOf(session) : null;
    const r = this.round;
    const live = this.phase === 'bidding' || this.phase === 'playing';
    return {
      seat,
      phase: this.phase,
      hand: this.handNumber,
      dealer: r.dealer,
      seats: this.seats.map((s, i) => {
        const m = this.memberAt(i);
        return {
          name: m?.name ?? s.botName,
          alias: m?.alias ?? null,
          color: m?.color ?? s.botColor,
          bot: !m,
          away: !!m && !m.conn,
          bid: r.bids[i],
          tricks: r.tricks[i],
          cards: r.hands[i].length,
          team: teamOf(i),
        };
      }),
      teams: [0, 1].map((t) => ({
        score: this.scores[t],
        bags: this.bags[t],
        bid: [t, t + 2].reduce((n, s) => n + (r.bids[s] ?? 0), 0),
        tricks: r.tricks[t] + r.tricks[t + 2],
      })),
      cards: seat !== null && live ? [...r.hands[seat]] : [],
      legal: seat !== null && this.collectAt === null ? r.legal(seat) : [],
      trick: r.trick.map((t) => ({ ...t })),
      trickWinner: this.collectAt !== null && r.trickComplete ? spadesTrickWinner(r.trick) : null,
      turn: live && r.turn >= 0 ? r.turn : null,
      spadesBroken: r.spadesBroken,
      history: this.history.map((h) => [...h]),
      result: this.result,
      winners: [...this.winners],
      target: SPADES_TARGET,
    };
  }

  sendInit(m: Member, _reclaimed = false) {
    this.host.send(m, { t: 'spades', view: this.viewFor(m.session) });
  }

  private sync() {
    for (const m of this.host.members()) if (m.conn) this.host.send(m, { t: 'spades', view: this.viewFor(m.session) });
  }

  dispose() {}

  stats() {
    return { hand: this.handNumber, phase: this.phase, scores: this.scores, bots: this.seats.filter((_, i) => this.botControls(i)).length };
  }
}
