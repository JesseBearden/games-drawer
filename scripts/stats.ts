// Summarise the JSONL logs: npm run stats [-- logDir]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'logs';
if (!fs.existsSync(dir)) {
  console.log(`No logs yet in ${dir}. Play a game first.`);
  process.exit(0);
}

type Row = Record<string, unknown> & { type?: string };
function read(prefix: string): Row[] {
  const rows: Row[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip a torn line */
      }
    }
  }
  return rows;
}

const events = read('events-');
const chats = read('chat-');
const of = (t: string) => events.filter((e) => e.type === t);
const count = <T>(rows: T[], key: (r: T) => unknown) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(String(key(r)), (m.get(String(key(r))) ?? 0) + 1);
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
};
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

const shots = of('shot');
const kills = of('kill');
const deaths = of('death');
const creditedFromShots = kills.filter((k) => k.cause === 'direct' || k.cause === 'fall' || k.cause === 'heli');
const third = deaths.filter((d) => d.deathNumber === 3);
const resets = of('runReset');

console.log(`\nLogs in ${path.resolve(dir)}: ${events.length} events, ${chats.length} chat lines\n`);
console.log('Shots fired (a spread volley counts once):', shots.length, count(shots, (s) => s.controller));
console.log('Credited kills from shots (direct + fall + helicopter):', creditedFromShots.length);
console.log('Shots per kill:', creditedFromShots.length ? Math.round((shots.length / creditedFromShots.length) * 10) / 10 : '(no kills)');
console.log('Death-blast kills:', kills.filter((k) => k.cause === 'blast').length);
console.log('Deaths by cause:', count(deaths, (d) => d.cause));
console.log('Kills by attacker → victim controller:', count(deaths.filter((d) => d.killer !== null), (d) => `${d.killerController}→${d.victimController}`));
console.log('Helicopter kills:', kills.filter((k) => k.heli).length);
console.log(`Average level at third death: ${avg(third.map((d) => Number(d.levelBefore)))} (n=${third.length})`, count(third, (d) => d.levelBefore));
console.log('Progression resets by reason/death number:', count(resets, (r) => (r.reason === 'nuke' ? 'nuke' : `death ${r.deathNumber}`)));
console.log(`Average level at death reset: ${avg(resets.filter((r) => r.reason === 'deaths').map((r) => Number(r.levelBefore)))}`);
console.log('Perk milestones reached:', count(of('milestone'), (m) => `L${m.level} ${m.controller}`));
console.log('Wins:', of('win').length, count(of('win'), (w) => w.controller));
console.log('Joins:', of('join').length, count(of('join'), (j) => j.device));
console.log('Disconnects:', of('disconnect').length, ' Bot handoffs:', of('bot_handoff').length);
console.log('Reclaims:', count(of('reclaim'), (r) => (r.success ? 'success' : 'failed')));
console.log('Rooms created / closed / rejected at capacity:', of('room_created').length, of('room_closed').length, of('room_rejected_capacity').length);
console.log('Room errors:', of('room_error').length, ' Flood disconnects:', of('flood_disconnect').length);
const limited = chats.filter((c) => c.outcome === 'rate-limited-summary');
console.log('\nChat:', count(chats.filter((c) => c.outcome !== 'rate-limited-summary'), (c) => c.outcome), {
  rateLimited: limited.reduce((a, c) => a + Number(c.rapid ?? 0) + Number(c.repeat ?? 0), 0),
});
const screened = chats.filter((c) => c.outcome === 'delivered' || c.outcome === 'blocked');
if (screened.length) console.log('Blocked share of screened messages:', `${Math.round((chats.filter((c) => c.outcome === 'blocked').length / screened.length) * 100)}%`, count(chats.filter((c) => c.outcome === 'blocked'), (c) => c.reason));
