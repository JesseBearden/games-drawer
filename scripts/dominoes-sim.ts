// How the Dominoes (All Fives) bots play against each other: points per hand, game length,
// blocked hands. Run with: npx tsx scripts/dominoes-sim.ts
import { dealDominoes, DOMINOES_RULES, dominoesBotMove, DominoesRound, Rng } from '../packages/shared/src/index';

const rng = new Rng(5);
const rand = (n: number) => rng.int(0, n - 1);
let hands = 0;
let blocked = 0;
let playPoints = 0;
let domPoints = 0;
const lengths: number[] = [];
for (let g = 0; g < 300; g++) {
  const scores = [0, 0, 0, 0];
  let leader: number | undefined;
  let over = false;
  for (let h = 0; !over; h++) {
    const r = new DominoesRound(dealDominoes(rand), { leader });
    let guard = 0;
    while (r.phase === 'playing' && guard++ < 500) {
      const s = r.turn;
      const m = dominoesBotMove(r, s, () => rng.next() * 2);
      if (m) {
        const pts = r.play(s, m.tile, m.arm);
        if (pts === null) throw new Error(`illegal bot move ${JSON.stringify(m)}`);
        scores[s] += pts;
        playPoints += pts;
        if (scores[s] >= DOMINOES_RULES.target) over = true;
        if (over) break;
      } else if (r.mustDraw(s)) r.draw(s);
      else r.pass(s);
    }
    hands++;
    if (r.result) {
      if (r.result.blocked) blocked++;
      if (r.result.winner !== null) {
        scores[r.result.winner] += r.result.points;
        domPoints += r.result.points;
        leader = r.result.winner;
      }
    }
    if (Math.max(...scores) >= DOMINOES_RULES.target) {
      over = true;
      lengths.push(h + 1);
    }
  }
}
lengths.sort((a, b) => a - b);
console.log(`hands: ${hands}, blocked: ${Math.round((100 * blocked) / hands)}%`);
console.log(`points per hand: ${(playPoints / hands).toFixed(1)} from plays, ${(domPoints / hands).toFixed(1)} for going out`);
console.log(`hands per game to ${DOMINOES_RULES.target}: median ${lengths[lengths.length >> 1]}, range ${lengths[0]}-${lengths.at(-1)}`);
