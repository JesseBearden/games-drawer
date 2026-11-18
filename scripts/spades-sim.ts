// How well the Spades bots play against each other: bids made, nils, bags and game length.
// Run with: npx tsx scripts/spades-sim.ts
import { deal, Rng, scoreSpadesHand, spadesBotBid, spadesBotPlay, SpadesRound, spadesWinners } from '../packages/shared/src/index';

const rng = new Rng(42);
let hands = 0;
let made = 0;
let teamHands = 0;
let nils = 0;
let nilsMade = 0;
let bags = 0;
let bagPenalties = 0;
const gameLengths: number[] = [];
for (let g = 0; g < 200; g++) {
  const scores = [0, 0];
  const bagCount = [0, 0];
  for (let h = 0; ; h++) {
    const r = new SpadesRound(
      deal((n) => rng.int(0, n - 1)),
      h % 4,
    );
    while (r.phase === 'bidding') r.bid(r.turn, spadesBotBid(r.hands[r.turn], r.bids[(r.turn + 2) % 4]));
    while (r.phase === 'playing') {
      if (r.trickComplete) r.collect();
      else r.play(r.turn, spadesBotPlay(r, r.turn));
    }
    const res = scoreSpadesHand(r.bids.map((b) => b ?? 0), r.tricks, bagCount);
    hands++;
    for (const t of [0, 1]) {
      scores[t] += res[t].points;
      bagCount[t] = res[t].bagsAfter;
      if (res[t].bid > 0) {
        teamHands++;
        if (!res[t].set) made++;
      }
      bags += res[t].bags;
      if (res[t].bagPenalty) bagPenalties++;
      for (const n of res[t].nils) {
        nils++;
        if (n.made) nilsMade++;
      }
    }
    if (spadesWinners(scores)) {
      gameLengths.push(h + 1);
      break;
    }
  }
}
const pct = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))}%`;
console.log(`hands: ${hands}, bids made: ${pct(made, teamHands)}, nil bids: ${nils} (${pct(nilsMade, nils)} made)`);
console.log(`bags per team-hand: ${(bags / (hands * 2)).toFixed(2)}, bag penalties: ${bagPenalties}`);
gameLengths.sort((a, b) => a - b);
console.log(`hands per game to 500: median ${gameLengths[gameLengths.length >> 1]}, range ${gameLengths[0]}-${gameLengths.at(-1)}`);
