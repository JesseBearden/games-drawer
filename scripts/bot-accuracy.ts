// Measures how accurate bots are by simulating bot-only matches.
//   npx tsx scripts/bot-accuracy.ts [minutes=5] [seeds=8] ['{"configOverride":1}']
// Reports shots per direct hit and per credited kill (a spread volley is one shot), how often
// the first shot at a new target hits (overall and when the target is close), and how often
// each bot fires.
import { World, type GameConfig } from '../packages/shared/src/index';

const minutes = Number(process.argv[2] ?? 5);
const seeds = Number(process.argv[3] ?? 8);
const overrides: Partial<GameConfig> = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const CLOSE = 350;

let shots = 0;
let hits = 0;
let kills = 0;
let flightTicks = 0;
let flights = 0;
const first = { shots: 0, hits: 0, closeShots: 0, closeHits: 0 };
let botSeconds = 0;

for (let seed = 1; seed <= seeds; seed++) {
  const w = new World({ seed: seed * 7919, cfg: overrides });
  for (let i = 0; i < 4; i++) w.addTank({ name: `Bot ${i}`, controller: 'bot' });
  const ticks = minutes * 60 * w.cfg.tickRate;
  botSeconds += 4 * minutes * 60;
  // Per shooter: which target its recent shots were at, and how many in a row.
  const streak = new Map<number, { target: number | null; n: number }>();
  // Per shell: the shot it belongs to.
  const shellShot = new Map<number, { target: number | null; n: number; close: boolean; born: number }>();
  for (let t = 0; t < ticks; t++) {
    for (const e of w.step()) {
      if (e.type === 'fire') {
        shots++;
        const target = w.bots.get(e.tank)?.target ?? null;
        const s = streak.get(e.tank) ?? { target: null, n: 0 };
        if (s.target !== target) {
          s.target = target;
          s.n = 0;
        }
        s.n++;
        streak.set(e.tank, s);
        const shooter = w.tanks.get(e.tank);
        const victim = target !== null ? w.tanks.get(target) : undefined;
        const close = !!shooter && !!victim && Math.abs(shooter.x - victim.x) < CLOSE;
        if (s.n === 1) {
          first.shots++;
          if (close) first.closeShots++;
        }
        for (const sh of e.shells) shellShot.set(sh.id, { target, n: s.n, close, born: e.tick });
      } else if (e.type === 'explode') {
        const shot = shellShot.get(e.shell);
        shellShot.delete(e.shell);
        if (shot) {
          flightTicks += e.tick - shot.born;
          flights++;
        }
        if (e.hitTank !== null && e.hitTank !== e.owner && !e.shielded) {
          hits++;
          if (shot && shot.n === 1 && e.hitTank === shot.target) {
            first.hits++;
            if (shot.close) first.closeHits++;
          }
        }
      } else if (e.type === 'kill' && (e.cause === 'direct' || e.cause === 'fall')) {
        kills++;
      }
    }
  }
}
const r = (x: number) => Math.round(x * 10) / 10;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : null);
console.log(
  JSON.stringify({
    minutes,
    seeds,
    shotsPerHit: hits ? r(shots / hits) : null,
    shotsPerKill: kills ? r(shots / kills) : null,
    firstShotHit: pct(first.hits, first.shots),
    firstShotHitClose: pct(first.closeHits, first.closeShots),
    closeFirstShots: first.closeShots,
    shotsPerBotMinute: r(shots / (botSeconds / 60)),
    avgFlightSeconds: flights ? r(flightTicks / flights / 60) : null,
  }),
);
