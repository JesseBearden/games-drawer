// Checks shot reach: from each map's deepest valley, can some angle/power (up to 100%) land
// within half a tank width of each surface point, even into the strongest headwind?
//   npx tsx scripts/reach.ts [maxShellSpeed]
import { advanceShell, barrelTip, DEFAULT_CONFIG, generateTerrain, type GameConfig } from '../packages/shared/src/index';

const speed = process.argv[2] ? Number(process.argv[2]) : DEFAULT_CONFIG.maxShellSpeed;
const cfg: GameConfig = { ...DEFAULT_CONFIG, maxShellSpeed: speed };

let total = 0;
let reachable = 0;
const misses: string[] = [];
for (let seed = 1; seed <= 12; seed++) {
  const terrain = generateTerrain(cfg, seed * 1013);
  let sx = 40;
  for (let x = 40; x < cfg.worldWidth - 40; x++) if (terrain.topAt(x) > terrain.topAt(sx)) sx = x;
  const sy = terrain.topAt(sx);
  for (let tx = 30; tx < cfg.worldWidth - 30; tx += 60) {
    if (Math.abs(tx - sx) < 80) continue;
    const ty = terrain.topAt(tx);
    const dir = tx > sx ? 1 : -1;
    const wind = -dir * cfg.windMaxSpeed; // straight into the wind
    total++;
    let ok = false;
    for (let a = 15; a <= 88 && !ok; a += 1.5) {
      const angle = dir > 0 ? a : 180 - a;
      for (let p = 10; p <= 100 && !ok; p += 1) {
        const tip = barrelTip(cfg, sx, sy, angle);
        const v = (p / 100) * cfg.maxShellSpeed;
        const s = { x: tip.x, y: tip.y, vx: Math.cos((angle * Math.PI) / 180) * v, vy: -Math.sin((angle * Math.PI) / 180) * v };
        let hit: { x: number; y: number } | null = null;
        for (let t = 0; t < cfg.shellLifetimeTicks && !hit; t++) {
          advanceShell(cfg, s, wind, (q) => {
            if (q.x < 0 || q.x >= cfg.worldWidth || q.y >= cfg.worldHeight) {
              hit = { x: -9999, y: 0 };
              return true;
            }
            if (q.y >= 0 && terrain.solidAt(q.x, q.y)) {
              hit = { x: q.x, y: q.y };
              return true;
            }
            return false;
          });
        }
        const h = hit as { x: number; y: number } | null;
        if (h && Math.abs(h.x - tx) <= cfg.tankWidth / 2 && Math.abs(h.y - ty) <= 30) ok = true;
      }
    }
    if (ok) reachable++;
    else misses.push(`seed ${seed}: from x=${sx} to x=${tx} (rise ${sy - ty})`);
  }
}
console.log(JSON.stringify({ maxShellSpeed: speed, reachable, total, pct: Math.round((reachable / total) * 1000) / 10 }));
if (misses.length) console.log(misses.slice(0, 8).join('\n'));
