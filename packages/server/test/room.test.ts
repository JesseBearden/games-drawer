import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@tank/shared';
import { ChatModerator, joinSpacedLetters, normalizeForFilter } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { RoomManager } from '../src/manager';
import type { Conn } from '../src/room';

class FakeConn implements Conn {
  sent: ServerMessage[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  chats() {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: 'chat' }> => m.t === 'chat').map((m) => m.msg);
  }
}

function setup(overrides: Partial<ConstructorParameters<typeof RoomManager>[0]> = {}) {
  const clock = { now: 1_000_000 };
  const log = new MemoryLog();
  const mgr = new RoomManager({
    now: () => clock.now,
    log,
    moderator: new ChatModerator(),
    emptyRoomMs: 60_000,
    publicReclaimMs: 60_000,
    maxPublicRooms: 10,
    maxPrivateRooms: 10,
    chatHistorySize: 10,
    ...overrides,
  });
  return { clock, log, mgr };
}

function join(mgr: RoomManager, session: string, req: Parameters<RoomManager['resolve']>[0] = { kind: 'public' }) {
  const lookup = mgr.resolve(req, session);
  if (!lookup.ok) throw new Error(lookup.code);
  const conn = new FakeConn();
  const r = lookup.room.join(conn, session, session, 'desktop');
  if (!r.ok) throw new Error(r.code);
  lookup.room.sendWelcome(session, r);
  return { room: lookup.room, conn, tankId: lookup.room.tanks?.tankIdOf(session) ?? -1, reclaimed: r.reclaimed };
}

describe('rooms and bots', () => {
  it('fills a solo player room to four tanks with bots', () => {
    const { mgr } = setup();
    const { room } = join(mgr, 'session-aaaa');
    expect(room.tanks!.world.tanks.size).toBe(4);
    expect([...room.tanks!.world.tanks.values()].filter((t) => t.controller === 'bot')).toHaveLength(3);
  });

  it('a newcomer replaces a bot instead of growing the room', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    expect(b.room).toBe(a.room);
    expect(a.room.tanks!.world.tanks.size).toBe(4);
    expect([...a.room.tanks!.world.tanks.values()].filter((t) => t.controller === 'human')).toHaveLength(2);
  });

  it('hands a disconnected tank to a bot and lets the player reclaim it with progress', () => {
    const { mgr, clock, log } = setup();
    const a = join(mgr, 'session-aaaa');
    const tank = a.room.tanks!.world.tanks.get(a.tankId)!;
    tank.level = 7;
    tank.kills = 7;
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    expect(tank.controller).toBe('bot');
    clock.now += 30_000;
    mgr.housekeeping();
    const again = join(mgr, 'session-aaaa');
    expect(again.room).toBe(a.room);
    expect(again.tankId).toBe(a.tankId);
    expect(again.reclaimed).toBe(true);
    expect(tank.controller).toBe('human');
    expect(tank.level).toBe(7);
    expect(log.events.some((e) => e.type === 'bot_handoff')).toBe(true);
  });

  it('public reservations expire after 60 seconds; a newcomer then gets a fresh tank', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    a.room.tanks!.world.tanks.get(a.tankId)!.level = 9;
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    clock.now += 61_000;
    mgr.housekeeping();
    expect(a.room.hasSession('session-aaaa')).toBe(false);
    const again = join(mgr, 'session-aaaa');
    expect(again.room).toBe(b.room);
    expect(a.room.tanks!.world.tanks.get(again.tankId)!.level).toBe(0);
  });

  it('private reservations last for the room lifetime', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa', { kind: 'create-private' });
    const b = join(mgr, 'session-bbbb', { kind: 'private', code: a.room.code.toLowerCase() });
    expect(b.room).toBe(a.room);
    a.room.handle('session-aaaa', { t: 'pick', game: 'tanks' });
    a.tankId = a.room.tanks!.tankIdOf('session-aaaa')!;
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    // Ten minutes later (b kept playing, so the table isn't idle), a's tank is still theirs.
    for (let i = 0; i < 10; i++) {
      clock.now += 60_000;
      b.room.handle('session-bbbb', { t: 'active' });
      mgr.housekeeping();
    }
    const again = join(mgr, 'session-aaaa', { kind: 'private', code: a.room.code });
    expect(again.tankId).toBe(a.tankId);
    expect(again.reclaimed).toBe(true);
  });

  it('closes a room 60 seconds after the last human leaves, unless someone returns', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    clock.now += 50_000;
    mgr.housekeeping();
    expect(mgr.rooms.size).toBe(1);
    join(mgr, 'session-aaaa');
    clock.now += 50_000;
    mgr.housekeeping();
    expect(mgr.rooms.size).toBe(1);
    a.room.disconnect('session-aaaa', null, 'disconnect');
    clock.now += 61_000;
    mgr.housekeeping();
    expect(mgr.rooms.size).toBe(0);
  });

  it('refuses new rooms over the cap but still lets people join open rooms', () => {
    const { mgr } = setup({ maxPrivateRooms: 1 });
    const a = join(mgr, 'session-aaaa', { kind: 'create-private' });
    const r = mgr.resolve({ kind: 'create-private' }, 'session-cccc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('Try again later.');
    expect(join(mgr, 'session-bbbb', { kind: 'private', code: a.room.code }).room).toBe(a.room);
  });

  it('caps a room at the configured size (4 tanks)', () => {
    const { mgr } = setup();
    const first = join(mgr, 'session-0000');
    const max = first.room.tanks!.world.cfg.maxTanksPerRoom;
    expect(max).toBe(4);
    for (let i = 1; i < max; i++) join(mgr, `session-000${i}`);
    expect(first.room.tanks!.world.tanks.size).toBe(max);
    expect([...first.room.tanks!.world.tanks.values()].every((t) => t.controller === 'human')).toBe(true);
    expect(first.room.openSlots()).toBe(0);
    // The next player lands in a new public room.
    const next = join(mgr, 'session-0009');
    expect(next.room).not.toBe(first.room);
  });

  it('a full private room turns away one more player', () => {
    const { mgr } = setup();
    const host = join(mgr, 'session-0000', { kind: 'create-private' });
    const max = host.room.capacity();
    for (let i = 1; i < max; i++) join(mgr, `session-000${i}`, { kind: 'private', code: host.room.code });
    const r = mgr.resolve({ kind: 'private', code: host.room.code }, 'session-0009');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('room-full');
  });

  it('announces the winner in room chat', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const w = a.room.tanks!.world;
    const me = w.tanks.get(a.tankId)!;
    const victim = [...w.tanks.values()].find((t) => t.id !== me.id)!;
    me.level = w.cfg.winLevel - 1;
    victim.phase = 'ground';
    w.killTank(victim, 'direct', me.id, null);
    mgr.stepAll();
    const said = a.conn.chats().filter((m) => m.system).map((m) => m.text);
    expect(said).toContain(`${me.name} won!`);
    expect(a.room.chatHistory.some((m) => m.text === `${me.name} won!`)).toBe(true);
  });

  it('keeps simulating and broadcasting', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    for (let i = 0; i < 60 * 5; i++) mgr.stepAll();
    const types = new Set(a.conn.sent.map((m) => (m.t === 'g' ? m.m.t : m.t)));
    expect(types.has('state')).toBe(true);
    expect(types.has('events')).toBe(true);
    expect(types.has('info')).toBe(true);
  });
});

describe('chat', () => {
  it('delivers clean messages to everyone and keeps the last 10 in history', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    for (let i = 0; i < 12; i++) {
      clock.now += 3000;
      a.room.handle('session-aaaa', { t: 'chat', text: `hello ${i}` });
    }
    expect(b.conn.chats().filter((m) => !m.system)).toHaveLength(12);
    expect(a.room.chatHistory).toHaveLength(10);
    expect(a.room.chatHistory.at(-1)!.text).toBe('hello 11');
  });

  it('logs counts only, never what was said or who said it, and forgets it all when the table closes', () => {
    const { mgr, log, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    join(mgr, 'session-bbbb');
    const name = a.room.players.get('session-aaaa')!.name;
    a.room.handle('session-aaaa', { t: 'chat', text: 'meet me at noon' });
    clock.now += 3000;
    a.room.handle('session-aaaa', { t: 'chat', text: 'you are a f u c k i n g idiot' });
    expect(log.chats.map((c) => c.outcome)).toEqual(['delivered', 'blocked']);
    const written = JSON.stringify([log.chats, log.events]);
    for (const kept of ['noon', 'idiot', name]) expect(written).not.toContain(kept);
    expect(a.room.chatHistory.some((m) => m.text === 'meet me at noon')).toBe(true);
    a.room.close('idle');
    expect(a.room.chatHistory).toHaveLength(0);
  });

  it('shadows blocked messages: only the sender sees them, and they are counted', () => {
    const { mgr, log } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    a.room.handle('session-aaaa', { t: 'chat', text: 'you are a f u c k i n g idiot' });
    expect(a.conn.chats().some((m) => m.text.includes('idiot'))).toBe(true);
    expect(b.conn.chats().some((m) => m.text.includes('idiot'))).toBe(false);
    expect(a.room.chatHistory.some((m) => m.text.includes('idiot'))).toBe(false);
    expect(log.chats.at(-1)!.outcome).toBe('blocked');
  });

  it('rate-limits rapid and repeated messages', () => {
    const { mgr, log } = setup();
    const a = join(mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'chat', text: 'gg' });
    a.room.handle('session-aaaa', { t: 'chat', text: 'gg' });
    for (let i = 0; i < 6; i++) a.room.handle('session-aaaa', { t: 'chat', text: `msg ${i}` });
    expect(log.chats.filter((c) => c.outcome === 'delivered')).toHaveLength(5);
    a.room.flushRateLimitCounts();
    const summary = log.chats.at(-1)!;
    expect(summary.outcome).toBe('rate-limited-summary');
    expect(summary.repeat).toBe(1);
    expect(summary.rapid).toBe(2);
  });

  it('normalises leetspeak for the extra blocklist', () => {
    expect(normalizeForFilter('B@d   W0rrrrd')).toBe('badworrd');
  });

  it('catches spaced-out letters without flagging ordinary phrases', () => {
    const m = new ChatModerator();
    expect(joinSpacedLetters('you are a f u c k i n g idiot')).toBe('you are afucking idiot');
    expect(m.screen('s.h.i.t').ok).toBe(false);
    expect(m.screen('this hit was great').ok).toBe(true);
    expect(m.screen('nice shot, classic assist').ok).toBe(true);
    expect(m.screen('Scunthorpe').ok).toBe(true);
  });

  it('rejects offensive names and keeps the old one', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'name', name: 'shithead' });
    const tank = a.room.tanks!.world.tanks.get(a.tankId)!;
    expect(tank.name).toBe('session-aaaa');
    a.room.handle('session-aaaa', { t: 'name', name: 'Sharpshooter' });
    expect(tank.name).toBe('Sharpshooter');
  });
});
