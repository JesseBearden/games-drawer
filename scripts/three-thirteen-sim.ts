// How Three Thirteen's computer players get on: turns per round and the slowest turn.
// Run with: npx tsx scripts/three-thirteen-sim.ts
import { Rng, ThreeThirteenRound, ttBotDiscard, ttBotTakesDiscard, TT_ROUNDS } from '../packages/shared/src';

const rng = new Rng(42);
const rand = (n: number) => Math.floor(rng.next() * n);
const perRound: number[][] = Array.from({ length: TT_ROUNDS }, () => []);
let worst = 0;
const t0 = performance.now();
for (let g = 0; g < 10; g++) {
  for (let round = 1; round <= TT_ROUNDS; round++) {
    const r = new ThreeThirteenRound(round, round % 4, rand);
    let turns = 0;
    while (r.phase === 'playing') {
      const s = r.turn;
      const a = performance.now();
      r.draw(s, ttBotTakesDiscard(r, s) ? 'discard' : 'stock');
      r.throwAway(s, ttBotDiscard(r, s));
      worst = Math.max(worst, performance.now() - a);
      turns++;
    }
    perRound[round - 1].push(turns);
  }
}
const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(0);
console.log('average turns per round, rounds 1-11:', perRound.map(avg).join(' '));
console.log(`10 games in ${Math.round(performance.now() - t0)} ms; slowest computer turn ${worst.toFixed(1)} ms`);
