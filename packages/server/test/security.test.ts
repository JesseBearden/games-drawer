import { describe, expect, it } from 'vitest';
import { Rng, type ClientMessage, type ServerMessage } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { SessionSigner, TokenBucket, WindowCounter } from '../src/guard';
import { RoomManager } from '../src/manager';
import { ANNOUNCE_COOLDOWN_MS, RENAME_COOLDOWN_MS, type Conn } from '../src/room';

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

function setup() {
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
  });
  return { clock, log, mgr };
}

function join(mgr: RoomManager, session: string, name = session) {
  const lookup = mgr.resolve({ kind: 'public' }, session);
  if (!lookup.ok) throw new Error(lookup.code);
  const conn = new FakeConn();
  const r = lookup.room.join(conn, session, name, 'desktop');
  if (!r.ok) throw new Error(r.code);
  return { room: lookup.room, conn, tankId: r.tankId, name: r.name };
}

describe('names', () => {
  it('replaces an offensive starting name with a default one', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa', 'shithead');
    expect(a.name.toLowerCase()).not.toContain('shit');
    expect(a.name.length).toBeGreaterThan(0);
  });

  it('cleans invisible characters out of names', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa', `Ad${String.fromCodePoint(0x200b)}min${String.fromCodePoint(0x202e)}`);
    expect(a.name).toBe('Admin');
  });

  it('limits renames to one per cooldown and never broadcasts the rejected ones', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    const before = b.conn.chats().length;
    for (let i = 0; i < 50; i++) a.room.handle('session-aaaa', { t: 'name', name: `Spam ${i}` });
    const tank = a.room.world.tanks.get(a.tankId)!;
    expect(tank.name).toBe('Spam 0');
    expect(b.conn.chats().length - before).toBe(1);
    clock.now += RENAME_COOLDOWN_MS;
    a.room.handle('session-aaaa', { t: 'name', name: 'Sharpshooter' });
    expect(tank.name).toBe('Sharpshooter');
  });

  it('bots give up a name a person picks', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const bot = [...a.room.world.tanks.values()].find((t) => t.controller === 'bot')!;
    const botName = bot.name;
    const b = join(mgr, 'session-bbbb', botName);
    expect(b.name).toBe(botName);
    const names = [...a.room.world.tanks.values()].map((t) => t.name.toLowerCase());
    expect(names.filter((n) => n === botName.toLowerCase())).toHaveLength(1);
  });

  it('cannot take another player name exactly', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa', 'Sharp Shooter');
    const b = join(mgr, 'session-bbbb', 'Sharp Shooter');
    expect(a.name).toBe('Sharp Shooter');
    expect(b.name).toBe('Sharp Shooter 2');
  });
});

describe('chat', () => {
  it('strips control and bidi characters before delivery', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    a.room.handle('session-aaaa', { t: 'chat', text: `nice${String.fromCodePoint(0x202e)}\n\n\nshot` });
    const got = b.conn.chats().filter((m) => !m.system).at(-1)!;
    expect(got.text).toBe('nice shot');
  });

  it('logs rate-limited spam as periodic counts, not one line per message', () => {
    const { mgr, clock, log } = setup();
    const a = join(mgr, 'session-aaaa');
    for (let i = 0; i < 500; i++) a.room.handle('session-aaaa', { t: 'chat', text: `spam ${i}` });
    const perMessage = log.chats.filter((c) => c.outcome === 'delivered' || c.outcome === 'blocked');
    expect(perMessage.length).toBeLessThanOrEqual(5);
    clock.now += 1000;
    mgr.housekeeping();
    const summary = log.chats.find((c) => c.outcome === 'rate-limited-summary')!;
    expect(summary.rapid).toBe(495);
    expect(log.chats.length).toBeLessThanOrEqual(6);
  });

  it('does not echo a notice for every flooded message', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const before = a.conn.sent.length;
    for (let i = 0; i < 300; i++) a.room.handle('session-aaaa', { t: 'chat', text: `spam ${i}` });
    // 5 delivered messages + at most one notice.
    expect(a.conn.sent.length - before).toBeLessThanOrEqual(7);
  });

  it('rejects overlong messages, counting emoji as one character', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    a.room.handle('session-aaaa', { t: 'chat', text: '🙂'.repeat(200) });
    expect(b.conn.chats().some((m) => m.text.startsWith('🙂'))).toBe(true);
    a.room.handle('session-aaaa', { t: 'chat', text: 'x'.repeat(201) });
    expect(b.conn.chats().some((m) => m.text.startsWith('xxx'))).toBe(false);
  });

  it('throttles join/leave notices from reconnect loops', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    const watcher = join(mgr, 'session-bbbb');
    const before = watcher.conn.chats().length;
    for (let i = 0; i < 30; i++) {
      a.room.disconnect('session-aaaa', null, 'disconnect');
      a.room.join(new FakeConn(), 'session-aaaa', 'x', 'desktop');
    }
    expect(watcher.conn.chats().length - before).toBeLessThanOrEqual(2);
    clock.now += ANNOUNCE_COOLDOWN_MS;
    a.room.disconnect('session-aaaa', null, 'disconnect');
    expect(watcher.conn.chats().length - before).toBeLessThanOrEqual(3);
  });
});

describe('human input reaches everyone', () => {
  it('a human shot is broadcast to other players and logged as a human shot', () => {
    const { mgr, log } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    const tank = a.room.world.tanks.get(a.tankId)!;
    a.room.world.helis = a.room.world.helis.filter((h) => h.tankId !== tank.id);
    tank.phase = 'ground';
    tank.x = 300;
    tank.y = a.room.world.terrain.groundBelow(300, 0);
    a.room.handle('session-aaaa', { t: 'fire', angle: 60, power: 50 });
    for (let i = 0; i < 3; i++) mgr.stepAll();
    const fires = b.conn.sent
      .filter((m): m is Extract<ServerMessage, { t: 'events' }> => m.t === 'events')
      .flatMap((m) => m.events)
      .filter((e) => e.type === 'fire' && e.tank === tank.id);
    expect(fires).toHaveLength(1);
    expect(log.events.some((e) => e.type === 'shot' && e.tank === tank.id && e.controller === 'human')).toBe(true);
  });
});

describe('messages from a hostile client', () => {
  it('ignores input for tanks it does not own', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    const bTank = a.room.world.tanks.get(b.tankId)!;
    const angle = bTank.angle;
    // There is no tank id in any client message; the server only ever applies input to
    // the sender's own tank, so the best a client can do is aim its own.
    a.room.handle('session-aaaa', { t: 'aim', angle: 3, power: 90 });
    expect(bTank.angle).toBe(angle);
    // Unknown sessions are ignored entirely.
    a.room.handle('session-zzzz', { t: 'fire', angle: 45, power: 50 });
    expect(a.room.world.shells).toHaveLength(0);
  });

  it('a disconnected player cannot keep sending input', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const tank = a.room.world.tanks.get(a.tankId)!;
    tank.phase = 'ground';
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    const shells = a.room.world.shells.length;
    a.room.handle('session-aaaa', { t: 'fire', angle: 45, power: 50 });
    expect(a.room.world.shells.length).toBe(shells);
  });

  it('survives thousands of random messages while the game runs (fuzz)', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    const rng = new Rng(99);
    const weird = [NaN, Infinity, -Infinity, -1e308, 1e308, -0, 0.5, 179.999, 180.0001];
    for (let i = 0; i < 20_000; i++) {
      const n = (): number => (rng.chance(0.3) ? rng.pick(weird) : rng.range(-500, 500));
      const msgs: ClientMessage[] = [
        { t: 'aim', angle: n(), power: n() },
        { t: 'fire', angle: n(), power: n() },
        { t: 'move', dir: rng.pick([-1, 0, 1] as const) },
        { t: 'drop' },
        { t: 'ping', at: n() },
        { t: 'chat', text: String.fromCodePoint(rng.int(0, 0x10ffff - 1) & 0xfffff) },
        { t: 'name', name: 'x'.repeat(rng.int(0, 64)) },
      ];
      expect(() => a.room.handle('session-aaaa', rng.pick(msgs))).not.toThrow();
      if (i % 5 === 0) mgr.stepAll();
      clock.now += 7;
    }
    for (const t of a.room.world.tanks.values()) {
      expect(Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.angle) && Number.isFinite(t.power)).toBe(true);
      expect(t.angle).toBeGreaterThanOrEqual(0);
      expect(t.angle).toBeLessThanOrEqual(180);
    }
    expect(mgr.rooms.size).toBe(1);
  });
});

describe('guards', () => {
  it('token bucket allows a burst, then the steady rate', () => {
    const b = new TokenBucket(10, 20, 0);
    let ok = 0;
    for (let i = 0; i < 100; i++) if (b.take(0)) ok++;
    expect(ok).toBe(20);
    expect(b.take(50)).toBe(false);
    expect(b.take(100)).toBe(true);
  });

  it('window counter forgets old events', () => {
    const c = new WindowCounter(1000);
    c.add('ip', 0);
    c.add('ip', 500);
    expect(c.count('ip', 900)).toBe(2);
    expect(c.count('ip', 1200)).toBe(1);
    c.sweep(5000);
    expect(c.count('ip', 5000)).toBe(0);
  });

  it('session credentials cannot be forged or tampered with', () => {
    const s = new SessionSigner('secret-a');
    const token = s.issue();
    expect(s.verify(token)).toBe(true);
    expect(new SessionSigner('secret-b').verify(token)).toBe(false);
    const [id, mac] = token.split('.');
    expect(s.verify(`${id}.${mac.replace(/.$/, (c) => (c === '0' ? '1' : '0'))}`)).toBe(false);
    expect(s.verify(`${id.replace(/^./, 'f')}.${mac}`)).toBe(id.startsWith('f'));
    expect(s.verify('session-aaaa')).toBe(false);
    expect(s.verify(null)).toBe(false);
    expect(s.verify({})).toBe(false);
  });
});
