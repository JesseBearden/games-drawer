import {
  freshBotName,
  MahjongHand,
  mjBotClaim,
  mjBotTurn,
  mjSort,
  mjTileName,
  MJ_MIN_FAAN,
  MJ_SEATS,
  WIND_NAMES,
  type GameInput,
  type MahjongView,
  type MjClaim,
  type MjOpening,
  type MjPhase,
  type MjRules,
} from '@tank/shared';
import { botPlays, leftLongAgo, TIMER_GAME_TICKS, watchersTakeSeats, type GameHost, type Member, type ServerGame } from './types';
import { HAND_END_MS } from './hearts';

/** The shuffle and the wall being built (the pages animate it meanwhile). */
export const MJ_SHUFFLE_MS = 2600;
/** The dealer has this long to roll the dice before they roll by themselves. */
export const MJ_ROLL_WAIT_MS = 6000;
/** A computer dealer rolls after this long. */
const BOT_ROLL_MS: [number, number] = [900, 1500];
/** The dice showing, then the deal. */
export const MJ_DICE_MS = 1800;
export const MJ_DEAL_MS = 2200;
/** Computers (and computers covering for someone away) take this long over a turn. */
const BOT_TURN_MS: [number, number] = [900, 1600];
/**
 * After a discard: a pause of 1.5-2 s, a little different each time, so nobody can tell whether
 * someone could have taken it and passed (user, 2026-11-23). Anyone who can take it gets up to 15 s
 * to decide (5 was far too short: user, 2026-11-23); answering ends it sooner, but never before
 * the pause is over.
 */
export const MJ_CLAIM_MIN_MS = 1500;
export const MJ_CLAIM_SPREAD_MS = 500;
export const MJ_CLAIM_MAX_MS = 15_000;
/** With nobody else to keep waiting (everyone else a computer), a whole minute (user, 2026-11-24). */
export const MJ_CLAIM_ALONE_MS = 60_000;
/**
 * After a Pung, Chow or Kong, play waits this long before the next computer moves, so everyone
 * sees it happen: the word by the player's name, the tile sliding over, the set lifting (user,
 * 2026-11-23).
 */
export const MJ_SHOW_CLAIM_MS = 2500;

interface Seat {
  /** Member holding this seat, or null for a computer player. */
  session: string | null;
  botName: string;
  botColor: number;
  /** With points: their total. */
  points: number;
  wins: number;
}

interface ClaimWindow {
  /** When the pause is over, and when the last answer is due. */
  minAt: number;
  maxAt: number;
  answers: (MjClaim | null)[];
  /** People (not computers) who can take what's on offer and haven't answered yet. */
  waiting: Set<number>;
}

/**
 * Mahjong for four, Hong Kong style, with points if the table chose them (see mahjong.ts for the
 * rules). People take the seats they picked; computers play the rest and anyone who drops out.
 * Every hand opens with a shuffle, the wall, the dealer's dice and the deal, which the pages
 * animate while the server waits.
 */
export class MahjongGame implements ServerGame {
  readonly id = 'mahjong' as const;
  readonly tickEvery = TIMER_GAME_TICKS;
  readonly capacity = MJ_SEATS;
  seats: Seat[];
  hand: MahjongHand | null = null;
  handNumber = 0;
  phase: MjPhase = 'opening';
  opening: MjOpening | null = 'shuffle';
  private openingUntil = 0;
  dice: number[] | null = null;
  private breakAt = 0;
  dealer = 0;
  /** How many times the deal has moved on (the round's wind changes every four). */
  dealerPasses = 0;
  history: number[][] = [];
  ready = new Set<number>();
  winners: number[] = [];
  claim: ClaimWindow | null = null;
  private nextHandAt: number | null = null;
  private botAt = 0;
  private dice6 = { int: (min: number, max: number) => min + this.host.randomInt(max - min + 1) };

  constructor(
    private host: GameHost,
    readonly rules: MjRules,
  ) {
    const used = new Set(host.members().map((m) => m.name.toLowerCase()));
    const colors = new Set(host.members().map((m) => m.color));
    this.seats = Array.from({ length: MJ_SEATS }, () => {
      const botName = freshBotName(used, this.dice6);
      used.add(botName.toLowerCase());
      let botColor = 0;
      while (colors.has(botColor)) botColor++;
      colors.add(botColor);
      return { session: null, botName, botColor, points: 0, wins: 0 };
    });
    this.startHand();
  }

  /** How many times the deal moves on before the game ends (0: it doesn't, without points). */
  get rounds() {
    return this.rules.points ? (this.rules.full ? 16 : 4) : 0;
  }

  get prevailing() {
    return Math.floor(this.dealerPasses / 4) % 4;
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
    const open = (i: number) => this.seats[i]?.session === null;
    const free = seat !== undefined && open(seat) ? seat : [0, 1, 2, 3].find(open) ?? -1;
    if (free < 0) {
      this.sendInit(m);
      return true;
    }
    this.seats[free].session = m.session;
    this.renameClashingBots(m.name);
    this.host.log('mahjong_seat', { pid: m.pid, seat: free });
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
    this.sync();
    return 'If they’re not back soon, the computer plays their tiles until they are.';
  }

  removePlayer(m: Member, opts?: { comingBack?: boolean }) {
    const seat = this.seatOf(m.session);
    if (seat === null) return;
    this.seats[seat].session = null;
    // Ready was theirs, not the seat's (whoever sits here next says so themselves).
    if (!opts?.comingBack) this.ready.delete(seat);
    // (Not when they're coming straight back in a new tab: the seat is still theirs.)
    const watcher = opts?.comingBack ? undefined : this.host.members().find((o) => o.session !== m.session && this.seatOf(o.session) === null && !leftLongAgo(o, this.host.now()));
    if (watcher) this.seats[seat].session = watcher.session;
    this.sync();
  }

  seatWatchers() {
    const moved = watchersTakeSeats(this.host, this.seats, [0, 1, 2, 3]);
    if (!moved.length) return;
    for (const seat of moved) this.ready.delete(seat);
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
        s.botName = freshBotName(taken, this.dice6);
        taken.add(s.botName.toLowerCase());
      }
    }
  }

  // ------------------------------------------------------------------ flow

  private wait(range: [number, number]) {
    return range[0] + this.host.randomInt(range[1] - range[0]);
  }

  private startHand() {
    this.handNumber++;
    this.hand = null;
    this.claim = null;
    this.dice = null;
    this.phase = 'opening';
    this.opening = 'shuffle';
    this.openingUntil = this.host.now() + MJ_SHUFFLE_MS;
    this.nextHandAt = null;
    this.ready.clear();
  }

  /** The dealer's dice: they pick where the wall is broken open, then the tiles are dealt. */
  private roll() {
    if (this.opening !== 'dice') return;
    const dice = [0, 1, 2].map(() => 1 + this.host.randomInt(6));
    const total = dice[0] + dice[1] + dice[2];
    // Count round the walls from the dealer's, then that many stacks along it.
    const side = (this.dealer + total - 1) % 4;
    this.breakAt = (side * 18 + (total % 18)) % 72;
    this.dice = dice;
    this.hand = new MahjongHand(this.dealer, this.prevailing, this.rules, (n) => this.host.randomInt(n));
    this.opening = 'deal';
    this.openingUntil = this.host.now() + MJ_DICE_MS + MJ_DEAL_MS;
    this.host.log('mahjong_hand', { hand: this.handNumber, dealer: this.dealer, points: this.rules.points, learning: !!this.rules.learning });
  }

  /** A discard (or an added Kong) is on offer: open the window for taking it. */
  private openClaims() {
    const h = this.hand!;
    const now = this.host.now();
    const answers: (MjClaim | null)[] = [null, null, null, null];
    const waiting = new Set<number>();
    for (const seat of h.claimants()) {
      if (this.botControls(seat)) answers[seat] = mjBotClaim(h, seat);
      else waiting.add(seat);
    }
    // Learning Mode: every person is asked about every discard (whether or not they can take it),
    // and there's no time limit.
    const learning = !!this.rules.learning;
    if (learning) {
      const from = h.step === 'rob' ? h.robbing?.seat : h.lastDiscard?.seat;
      for (let seat = 0; seat < 4; seat++) if (seat !== from && !this.botControls(seat)) waiting.add(seat);
    }
    const minAt = now + MJ_CLAIM_MIN_MS + this.host.randomInt(MJ_CLAIM_SPREAD_MS + 1);
    // Playing alone against the computers, there's nobody to keep waiting: take your time.
    const alone = [0, 1, 2, 3].filter((s) => !this.botControls(s)).length === 1;
    const most = learning ? Infinity : alone ? MJ_CLAIM_ALONE_MS : MJ_CLAIM_MAX_MS;
    this.claim = { minAt, maxAt: waiting.size ? Math.max(minAt, now + most) : minAt, answers, waiting };
  }

  private resolveClaims() {
    const h = this.hand!;
    const c = this.claim!;
    // Anyone still deciding who has dropped out meanwhile: the computer answers for them.
    for (const seat of c.waiting) if (this.botControls(seat)) c.answers[seat] = mjBotClaim(h, seat);
    this.claim = null;
    const before = h.melds.map((m) => m.length);
    const offered = h.step === 'claim' ? h.lastDiscard : null;
    h.resolve(c.answers);
    const taker = h.melds.findIndex((m, i) => m.length > before[i]);
    if (taker >= 0 && offered) {
      const m = h.melds[taker].at(-1)!;
      this.host.log('mahjong_claim', { seat: taker, kind: m.kind });
      // In Messages too, so a game against the computer is easy to follow (user, 2026-11-23).
      const kind = m.kind === 'kong' ? 'Kong' : m.kind === 'pung' ? 'Pung' : 'Chow';
      const run = m.kind === 'chow' ? ` (${m.tiles.map(mjTileName).join(', ')})` : '';
      this.note(`${this.nameOf(taker)} took ${this.nameOf(offered.seat)}’s ${mjTileName(offered.tile)} for a ${kind}${run}.`);
    }
    this.afterMove();
    if (taker >= 0) this.botAt += MJ_SHOW_CLAIM_MS;
  }

  /** A line in Messages about a move (not kept for people who arrive later). */
  private note(text: string) {
    if (this.host.gameNote) this.host.gameNote(text);
  }

  /** A Kong declared on someone's own turn: four from their hand, or a fourth added to a Pung. */
  private kongNote(seat: number, tile: string, added: boolean) {
    this.note(added ? `${this.nameOf(seat)} added the fourth ${mjTileName(tile)} to their Pung: a Kong.` : `${this.nameOf(seat)} made a Kong of ${mjTileName(tile)} from their own tiles.`);
  }

  /** After anything happens in a hand: the next window, the hand's end, or the next computer's turn. */
  private afterMove() {
    const h = this.hand!;
    if (h.step === 'done') return this.endHand();
    if (h.step === 'claim' || h.step === 'rob') return this.openClaims();
    this.botAt = this.host.now() + this.wait(BOT_TURN_MS);
  }

  private endHand() {
    const h = this.hand!;
    const r = h.result!;
    this.claim = null;
    if (r.winner !== null) {
      this.seats[r.winner].wins++;
      r.pay.forEach((p, i) => (this.seats[i].points += p));
      const how = r.selfDrawn ? 'on a tile they drew' : r.robbed ? `robbing ${this.nameOf(r.from!)}’s Kong` : `on ${this.nameOf(r.from!)}’s discard`;
      const worth = this.rules.points && r.score ? ` (${r.score.faan} faan)` : '';
      this.host.systemChat(`${this.nameOf(r.winner)} went Mahjong${worth}, ${how}!`);
    } else this.host.systemChat('The wall ran out: nobody won this hand.');
    this.history.push(this.seats.map((s) => (this.rules.points ? s.points : s.wins)));
    this.host.log('mahjong_hand_end', { hand: this.handNumber, winner: r.winner, selfDrawn: r.selfDrawn, faan: r.score?.faan ?? null });
    // With points the dealer keeps the deal after winning (or nobody winning); otherwise it moves on.
    const keep = this.rules.points && (r.winner === null || r.winner === this.dealer);
    if (!keep) {
      this.dealer = (this.dealer + 1) % 4;
      this.dealerPasses++;
    }
    if (this.rounds && this.dealerPasses >= this.rounds) {
      const top = Math.max(...this.seats.map((s) => s.points));
      this.winners = [0, 1, 2, 3].filter((i) => this.seats[i].points === top);
      this.phase = 'gameOver';
      this.host.systemChat(`${this.winners.map((i) => this.nameOf(i)).join(' and ')} won Mahjong!`);
      this.host.log('mahjong_game_over', { points: this.seats.map((s) => s.points), winners: this.winners });
      return;
    }
    this.phase = 'handEnd';
    this.ready.clear();
    this.nextHandAt = this.host.now() + HAND_END_MS;
  }

  /** Between hands: on once everyone at the table is ready (a table of only computers moves on by itself). */
  private nextHandIfReady(): boolean {
    if (this.phase !== 'handEnd') return false;
    const people = [0, 1, 2, 3].filter((i) => !this.botControls(i));
    const go = people.length ? people.every((i) => this.ready.has(i)) : this.nextHandAt !== null && this.host.now() >= this.nextHandAt;
    if (!go) return false;
    this.startHand();
    return true;
  }

  private newGame() {
    for (const s of this.seats) (s.points = 0), (s.wins = 0);
    this.history = [];
    this.winners = [];
    this.handNumber = 0;
    this.dealer = 0;
    this.dealerPasses = 0;
    this.startHand();
    this.host.log('mahjong_new_game', {});
  }

  // ------------------------------------------------------------------ input

  handle(m: Member, input: GameInput) {
    const seat = this.seatOf(m.session);
    if (seat === null) return;
    if (input.t === 'again') {
      if (this.phase === 'gameOver') {
        this.host.systemChat(`${m.name} dealt a new game.`);
        this.newGame();
        this.sync();
      }
      return;
    }
    if (input.t === 'ready') {
      if (this.phase === 'handEnd' && !this.ready.has(seat)) {
        this.ready.add(seat);
        this.nextHandIfReady();
        this.sync();
      }
      return;
    }
    if (input.t === 'mj-roll') {
      if (this.opening === 'dice' && seat === this.dealer) {
        this.roll();
        this.sync();
      }
      return;
    }
    const h = this.hand;
    if (!h || this.phase !== 'playing') return;
    if (input.t === 'mj-discard') {
      if (h.discard(seat, input.tile)) {
        this.afterMove();
        this.sync();
      }
    } else if (input.t === 'mj-win') {
      if (h.declareWin(seat)) {
        this.afterMove();
        this.sync();
      }
    } else if (input.t === 'mj-kong') {
      const added = h.melds[seat].some((x) => x.kind === 'pung' && x.tiles[0] === input.tile);
      if (h.declareKong(seat, input.tile)) {
        this.kongNote(seat, input.tile, added);
        this.afterMove();
        this.botAt += MJ_SHOW_CLAIM_MS;
        this.sync();
      }
    } else if (input.t === 'mj-claim') {
      const c = this.claim;
      if (!c || !c.waiting.has(seat)) return;
      // An answer held up on a slow line can arrive after the next tile is on offer: it isn't one.
      if (input.at !== undefined && input.at !== h.log.length) return;
      c.waiting.delete(seat);
      c.answers[seat] = input.claim === 'chow' ? { t: 'chow', chow: input.chow } : { t: input.claim };
      if (!c.waiting.size && this.host.now() >= c.minAt) this.resolveClaims();
      this.sync();
    }
  }

  // ------------------------------------------------------------------ time

  step() {
    const now = this.host.now();
    let changed = false;
    if (this.nextHandIfReady()) changed = true;
    if (this.phase === 'opening' && now >= this.openingUntil) {
      if (this.opening === 'shuffle') {
        this.opening = 'dice';
        this.openingUntil = now + (this.botControls(this.dealer) ? this.wait(BOT_ROLL_MS) : MJ_ROLL_WAIT_MS);
      } else if (this.opening === 'dice') this.roll();
      else {
        this.phase = 'playing';
        this.opening = null;
        this.afterMove();
      }
      changed = true;
    }
    const h = this.hand;
    if (this.phase === 'playing' && h) {
      const c = this.claim;
      // Anyone asked who has since dropped out for good (or left the table): the computer answers
      // for them now. Learning Mode's window has no time limit, so otherwise it would wait forever.
      if (c) {
        for (const seat of [...c.waiting]) {
          if (!this.botControls(seat)) continue;
          c.answers[seat] = mjBotClaim(h, seat);
          c.waiting.delete(seat);
          changed = true;
        }
      }
      if (c && now >= c.minAt && (!c.waiting.size || now >= c.maxAt)) {
        this.resolveClaims();
        changed = true;
      } else if (!c && h.step === 'discard' && now >= this.botAt && this.botControls(h.turn)) {
        const seat = h.turn;
        const a = mjBotTurn(h, seat);
        if (a.t === 'win') h.declareWin(seat);
        else if (a.t === 'kong') {
          const added = h.melds[seat].some((x) => x.kind === 'pung' && x.tiles[0] === a.tile);
          if (h.declareKong(seat, a.tile)) this.kongNote(seat, a.tile, added);
        } else h.discard(seat, a.tile);
        this.afterMove();
        if (a.t === 'kong') this.botAt += MJ_SHOW_CLAIM_MS;
        changed = true;
      }
    }
    if (changed) this.sync();
  }

  // ------------------------------------------------------------------ views

  viewFor(session: string | null): MahjongView {
    const seat = session !== null ? this.seatOf(session) : null;
    const h = this.hand;
    const now = this.host.now();
    const playing = this.phase === 'playing' && !!h;
    const done = !!h && h.step === 'done';
    const offer = playing && h.step === 'rob' && h.robbing ? { ...h.robbing, kong: true } : playing && h.step === 'claim' && h.lastDiscard ? { ...h.lastDiscard, kong: false } : null;
    const c = this.claim;
    const options = offer && seat !== null && c ? h!.options(seat) : null;
    // (Learning Mode asks everyone, so everyone asked gets the choices, even with nothing to take.)
    const asked = !!this.rules.learning && seat !== null && !!c && (c.waiting.has(seat) || !!c.answers[seat]) && !!offer && offer.seat !== seat;
    const canClaim = !!options && (asked || options.win || options.kong || options.pung || options.chows.length > 0);
    const answer = seat !== null && c?.answers[seat] && !c.waiting.has(seat) && canClaim ? c.answers[seat]!.t : null;
    return {
      seat,
      phase: this.phase,
      opening: this.opening,
      dice: this.dice,
      hand: this.handNumber,
      rules: { ...this.rules },
      minFaan: MJ_MIN_FAAN,
      prevailing: this.prevailing,
      dealer: this.dealer,
      seats: this.seats.map((s, i) => {
        const m = this.memberAt(i);
        return {
          name: m?.name ?? s.botName,
          alias: m?.alias ?? null,
          color: m?.color ?? s.botColor,
          bot: !m,
          away: !!m && !m.conn,
          wind: (i - this.dealer + 4) % 4,
          tiles: h ? h.hands[i].length : 0,
          melds: h ? h.melds[i].map((x) => ({ ...x, tiles: [...x.tiles] })) : [],
          flowers: h ? [...h.flowers[i]] : [],
          discards: h ? [...h.discards[i]] : [],
          score: this.rules.points ? s.points : s.wins,
          wins: s.wins,
        };
      }),
      tiles: h && seat !== null ? mjSort(h.hands[seat]) : [],
      drawn: playing && seat !== null && h.turn === seat ? h.drawn : null,
      drew: playing && seat !== null && h.turn === seat && h.justDrew,
      turn: playing ? h.turn : null,
      step: h ? h.step : null,
      offer,
      options: canClaim && !answer ? options : null,
      answered: answer,
      claimMs: canClaim && !answer && c && c.maxAt !== Infinity ? Math.max(0, c.maxAt - now) : null,
      self: playing && seat !== null && !c ? h.selfOptions(seat) : null,
      wall: { size: h?.wallSize ?? 144, left: h ? h.wall.length : 144, front: h?.front ?? 0, back: h?.back ?? 0, breakAt: this.breakAt },
      log: h ? h.log.map((d) => ({ ...d })) : [],
      result: done && h.result ? { ...h.result, hands: h.hands.map((x) => mjSort(x)) } : null,
      history: this.history.map((x) => [...x]),
      ready: [...this.ready].sort((a, b) => a - b),
      winners: [...this.winners],
      rounds: this.rounds,
    };
  }

  sendInit(m: Member, _reclaimed = false) {
    this.host.send(m, { t: 'mahjong', view: this.viewFor(m.session) });
  }

  private sync() {
    for (const m of this.host.members()) if (m.conn) this.host.send(m, { t: 'mahjong', view: this.viewFor(m.session) });
  }

  dispose() {}

  stats() {
    return {
      hand: this.handNumber,
      phase: this.phase,
      points: this.rules.points,
      round: WIND_NAMES[this.prevailing],
      bots: [0, 1, 2, 3].filter((i) => this.botControls(i)).length,
    };
  }
}
