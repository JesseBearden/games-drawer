// How high do runs get? Simulates long bot-only matches and reports run-ending levels and
// how often each milestone is reached.
//   npx tsx scripts/progression-sim.ts [tanks=8] [minutes=60] [seeds=4] ['{"configOverride":1}']
import { DEFAULT_CONFIG, milestoneLevels, World, type GameConfig } from '../packages/shared/src/index';

const tanks = Number(process.argv[2] ?? 8);
const minutes = Number(process.argv[3] ?? 60);
const seeds = Number(process.argv[4] ?? 4);
const overrides: Partial<GameConfig> = process.argv[5] ? JSON.parse(process.argv[5]) : {};

const endLevels: number[] = [];
let best = 0;
const reached = new Map<number, number>();
const firstReachMinutes = new Map<number, number[]>();
let runs = 0;
let wins = 0;

for (let seed = 1; seed <= seeds; seed++) {
  const w = new World({ seed: seed * 104729, cfg: { ...overrides, maxTanksPerRoom: Math.max(8, tanks) } });
  for (let i = 0; i < tanks; i++) w.addTank({ name: `Bot ${i}`, controller: 'bot' });
  runs += tanks;
  const ticks = minutes * 60 * w.cfg.tickRate;
  for (let t = 0; t < ticks; t++) {
    for (const e of w.step()) {
      if (e.type === 'runReset') {
        endLevels.push(e.levelBefore);
        runs++;
      }
      if (e.type === 'milestone') {
        reached.set(e.level, (reached.get(e.level) ?? 0) + 1);
        const list = firstReachMinutes.get(e.level) ?? [];
        list.push(e.elapsedTicks / 3600);
        firstReachMinutes.set(e.level, list);
      }
      if (e.type === 'kill' && e.levelAfter > best) best = e.levelAfter;
      if (e.type === 'win') wins++;
    }
  }
}

const pct = (n: number) => `${((n / runs) * 100).toFixed(1)}%`;
const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '-');
const sorted = endLevels.slice().sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
console.log(`${seeds} matches x ${minutes} min with ${tanks} bots: ${runs} runs started, highest level ${best}, wins ${wins}`);
console.log(`run-ending level: median ${q(0.5)}, 90th pct ${q(0.9)}, 99th pct ${q(0.99)}, max ${sorted.at(-1)}`);
for (const lvl of milestoneLevels(DEFAULT_CONFIG)) {
  const n = reached.get(lvl) ?? 0;
  console.log(`  reached ${String(lvl).padStart(2)}: ${String(n).padStart(4)} runs (${pct(n)})${n ? `, avg ${avg(firstReachMinutes.get(lvl)!)} min into the run` : ''}`);
}
