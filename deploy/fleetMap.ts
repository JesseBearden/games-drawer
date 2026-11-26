/**
 * The fleet map: which game server boxes are live, where each one is, and which of them take
 * new tables. The fleet tool (fleet.ts, run by the pipeline's deploy steps) writes it to every box; each
 * box's rollout tool turns it into Caddy routes (routesSnippet). Shared by both, so both agree.
 *
 * Every box can answer any request: a request for a table on another box (its code names that
 * box's slot, sent as ?slot=) is passed to that box over the private network, and new tables
 * go wherever the map says. So the front door (CloudFront, or the domain's DNS while CloudFront
 * isn't available) can point at any one box, and moving it to a new box never cuts off a game
 * on an old one.
 */
import { SLOTS, type Slot } from '@tank/shared';

export { SLOTS, type Slot };

/** The game server's port on every box (only Caddy, on the same box, talks to it). */
export const GAME_PORT = 8801;
/** Caddy's port for requests another box passes on (plain HTTP, over the private network). */
export const HOP_PORT = 8080;
/** Header a box adds when it passes a request to another box: "serve this yourself". */
export const HOP_HEADER = 'X-Gd-Hop';

export interface FleetMap {
  /** Private IP of every live box, by slot. */
  boxes: Partial<Record<Slot, string>>;
  /** Where new tables (and page loads) go, with weights: one box, or the current one and a canary. */
  newTables: [Slot, number][];
  /** The box behind staging.<domain>: the newest one. */
  staging: Slot | null;
}

export function isFleetMap(v: unknown): v is FleetMap {
  if (!v || typeof v !== 'object') return false;
  const m = v as FleetMap;
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  if (!m.boxes || typeof m.boxes !== 'object') return false;
  for (const [slot, ip] of Object.entries(m.boxes)) if (!SLOTS.includes(slot as Slot) || typeof ip !== 'string' || !ipv4.test(ip)) return false;
  if (!Array.isArray(m.newTables) || !m.newTables.length) return false;
  for (const e of m.newTables) if (!Array.isArray(e) || !(e[0] in m.boxes) || !Number.isInteger(e[1]) || e[1] < 1 || e[1] > 100) return false;
  return m.staging === null || m.staging in m.boxes;
}

/**
 * Every route change reloads Caddy, and by default a reload closes every proxied WebSocket: each
 * deploy step would knock everyone off their table and voice (they'd reconnect, but it's jarring).
 * This keeps open connections on the routes they started on, for longer than a retiring box takes
 * to drain (DRAIN_MAX_MS, 3 hours), so a reload never drops anyone.
 */
export const KEEP_STREAMS = 'stream_close_delay 4h';

const indent = (lines: string[]) => lines.map((l) => `\t${l}`);

/**
 * When another box doesn't answer. A retired box powers itself off, but the other boxes keep its
 * route until the fleet tool next writes the map (the next deploy), so a late invite link or a
 * phone waking up would wait on a box that's gone and get only an error, retrying forever. Give
 * up on a box after 2 s (marking it gone for 30 s) and try the next address instead.
 */
const WHEN_GONE = ['lb_try_duration 4s', 'fail_duration 30s', 'transport http {', '\tdial_timeout 2s', '}'];

/**
 * Caddy lines that send a request to one box: this box's own server, or another box (marked as
 * passed on). If that box is gone, this box answers instead: it doesn't have the table, so it
 * says the table has closed, which the page shows right away.
 */
function proxyTo(slot: Slot, map: FleetMap, self: Slot): string[] {
  if (slot === self) return [`reverse_proxy 127.0.0.1:${GAME_PORT} {`, `\t${KEEP_STREAMS}`, '}'];
  return [
    `reverse_proxy ${map.boxes[slot]}:${HOP_PORT} 127.0.0.1:${GAME_PORT} {`,
    '\tlb_policy first',
    ...indent(WHEN_GONE),
    `\theader_up ${HOP_HEADER} 1`,
    `\t${KEEP_STREAMS}`,
    '}',
  ];
}

/** Caddy lines that spread new tables over the boxes taking them. */
function proxyNewTables(map: FleetMap, self: Slot): string[] {
  if (map.newTables.length === 1) return proxyTo(map.newTables[0][0], map, self);
  const target = (s: Slot) => (s === self ? `127.0.0.1:${GAME_PORT}` : `${map.boxes[s]}:${HOP_PORT}`);
  return [
    `reverse_proxy ${map.newTables.map(([s]) => target(s)).join(' ')} {`,
    `\tlb_policy weighted_round_robin ${map.newTables.map(([, w]) => w).join(' ')}`,
    // A box that's gone is skipped: its share of new tables goes to the others.
    ...indent(WHEN_GONE),
    // Only another box reads it (as "serve this yourself"); this box's own server ignores it.
    `\theader_up ${HOP_HEADER} 1`,
    `\t${KEEP_STREAMS}`,
    '}',
  ];
}

/**
 * The routes for one box (/etc/caddy/games-drawer-routes.caddy, imported inside its site block).
 * Order matters: Caddy tries the handle blocks top to bottom and uses the first that matches.
 */
export function routesSnippet(map: FleetMap, self: Slot, domain: string): string {
  const lines: string[] = [`# Box ${self}. Written by the rollout tool from the fleet map (deploy/fleetMap.ts).`, ''];
  lines.push(`@www host www.${domain}`, 'handle @www {', `\tredir https://${domain}{uri} permanent`, '}', '');
  lines.push('# Passed on by another box: always served here.', `@hop header ${HOP_HEADER} 1`, 'handle @hop {', ...indent(proxyTo(self, map, self)), '}', '');
  if (map.staging) lines.push('# Staging is the newest box.', `@staging host staging.${domain}`, 'handle @staging {', ...indent(proxyTo(map.staging, map, self)), '}', '');
  lines.push("# A table's own box (its code says which; the page adds ?slot=).");
  for (const slot of SLOTS) {
    if (!map.boxes[slot]) continue;
    lines.push(`@slot_${slot} query slot=${slot}`, `handle @slot_${slot} {`, ...indent(proxyTo(slot, map, self)), '}');
  }
  lines.push('', '# Everything else: new tables and page loads.', 'handle {', ...indent(proxyNewTables(map, self)), '}', '');
  return lines.join('\n');
}

/** Before the fleet tool has said anything: this box serves everything itself. */
export function soloMap(self: Slot, privateIp: string): FleetMap {
  return { boxes: { [self]: privateIp }, newTables: [[self, 100]], staging: self };
}
