import { describe, expect, it } from 'vitest';
import { cleanName, cleanText, MAX_NAME_LENGTH } from '../src/names';
import { parseClientMessage } from '../src/protocol';
import { Rng } from '../src/rng';
import { addPlaced, dropShellAt, flatWorld, runTicks } from './helpers';

/** Anti-cheat rules live in the authoritative simulation; these prove a client can't bend them. */
describe('shot limits', () => {
  it('only one shell in flight per tank, however fast fire is sent', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    let accepted = 0;
    for (let i = 0; i < 500; i++) if (w.fire(a.id, 60, 50)) accepted++;
    expect(accepted).toBe(1);
    expect(w.shells.filter((s) => s.owner === a.id)).toHaveLength(1);
    // Keep spamming every tick while the shell flies: still only one.
    for (let t = 0; t < 30; t++) {
      for (let i = 0; i < 20; i++) w.fire(a.id, 60, 50);
      w.step();
      expect(w.shells.filter((s) => s.owner === a.id).length).toBeLessThanOrEqual(1);
    }
    runTicks(w, 300);
    expect(w.fire(a.id, 60, 50)).toBe(true);
  });

  for (const [level, shells] of [
    [5, 3],
    [9, 5],
  ] as const) {
    it(`a ${shells}-shell spread (level ${level}) holds the shot slot until every shell lands`, () => {
      const w = flatWorld(800);
      const a = addPlaced(w, 'A', 300);
      a.level = level;
      a.shotsUntilSpread = 0;
      expect(w.fire(a.id, 70, 60)).toBe(true);
      expect(w.shells).toHaveLength(shells);
      let blockedWhileInFlight = true;
      while (w.shells.length > 0) {
        if (w.fire(a.id, 70, 60)) blockedWhileInFlight = false;
        w.step();
      }
      expect(blockedWhileInFlight).toBe(true);
      expect(a.shellsInFlight).toBe(0);
      expect(a.shotsFired).toBe(1);
      expect(w.fire(a.id, 70, 60)).toBe(true);
    });
  }

  it('cannot fire while carried, parachuting, falling, dead, or after a win', () => {
    const w = flatWorld(800);
    const t = w.addTank({ name: 'A', controller: 'human' });
    w.step();
    expect(t.phase).toBe('carried');
    expect(w.fire(t.id, 60, 50)).toBe(false);
    w.requestDrop(t.id);
    expect(t.phase).toBe('chute');
    expect(w.fire(t.id, 60, 50)).toBe(false);
    t.phase = 'air';
    expect(w.fire(t.id, 60, 50)).toBe(false);
    t.phase = 'dead';
    expect(w.fire(t.id, 60, 50)).toBe(false);
    const b = addPlaced(w, 'B', 900);
    w.match = { state: 'won', winner: b.id, nukeAt: w.tick + 999 };
    expect(w.fire(b.id, 60, 50)).toBe(false);
    expect(w.shells).toHaveLength(0);
  });

  it('cannot fire for a tank that does not exist', () => {
    const w = flatWorld(800);
    expect(w.fire(99, 60, 50)).toBe(false);
    expect(w.fire(-1, 60, 50)).toBe(false);
  });
});

describe('events caused by input between ticks', () => {
  it('a human shot and a helicopter drop are reported by the next step', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const b = w.addTank({ name: 'B', controller: 'human' });
    w.step();
    expect(w.fire(a.id, 60, 50)).toBe(true);
    expect(w.requestDrop(b.id)).toBe(true);
    const events = w.step();
    const fire = events.find((e) => e.type === 'fire');
    expect(fire).toBeDefined();
    expect(fire!.tick).toBe(w.tick - 1);
    expect(events.some((e) => e.type === 'drop' && e.tank === b.id)).toBe(true);
    // Reported once, not again.
    expect(w.step().some((e) => e.type === 'fire')).toBe(false);
  });
});

describe('slot reuse', () => {
  it('a shell from a removed tank is not credited to whoever takes its slot', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const victim = addPlaced(w, 'V', 900);
    dropShellAt(w, a.id, 900, 700);
    const slot = a.id;
    w.removeTank(slot);
    const newcomer = w.addTank({ id: slot, name: 'New', controller: 'human' });
    const events = runTicks(w, 120);
    const death = events.find((e) => e.type === 'death' && e.tank === victim.id);
    expect(death).toBeDefined();
    expect(death!.type === 'death' && death!.killer).toBeNull();
    expect(newcomer.kills).toBe(0);
    expect(newcomer.level).toBe(0);
  });
});

describe('aim and movement limits', () => {
  it('clamps angle and power, and ignores non-finite values', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    w.setAim(a.id, 1e9, 1e9);
    expect(a.angle).toBe(180);
    expect(a.power).toBe(w.cfg.maxPower);
    w.setAim(a.id, -50, -50);
    expect(a.angle).toBe(0);
    expect(a.power).toBe(w.cfg.minPower);
    w.setAim(a.id, NaN, Infinity);
    expect(a.angle).toBe(0);
    expect(a.power).toBe(w.cfg.minPower);
  });

  it('an over-powered fire request launches at max power, not faster', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    w.fire(a.id, 45, 10_000);
    const s = w.shells[0];
    const speed = Math.hypot(s.vx, s.vy);
    expect(speed).toBeLessThanOrEqual(w.cfg.maxShellSpeed + 1e-6);
  });

  it('movement does nothing before level 4, is slow until 8, then faster, and always capped', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 900);
    w.setMove(a.id, 1);
    runTicks(w, 120);
    expect(a.x).toBe(900);
    a.level = 4;
    w.setMove(a.id, 99);
    runTicks(w, 60);
    // One second at slow speed, whatever "dir" value was sent.
    expect(a.x - 900).toBeCloseTo(w.cfg.moveSpeedSlow, 0);
    a.level = 8;
    const x = a.x;
    runTicks(w, 60);
    expect(a.x - x).toBeCloseTo(w.cfg.moveSpeedFast, 0);
  });

  it('a drop request only works while on the helicopter, once', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    expect(w.requestDrop(a.id)).toBe(false);
    expect(a.phase).toBe('ground');
  });

  it('spawn protection always ends when you fire', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    a.protectedUntil = w.tick + 10_000;
    w.fire(a.id, 60, 50);
    expect(w.isProtected(a)).toBe(false);
  });
});

describe('protocol parsing', () => {
  it('rejects malformed messages', () => {
    const bad = [
      '',
      'null',
      '[]',
      '"hi"',
      '{',
      '{"t":"fire"}',
      '{"t":"fire","angle":"1","power":2}',
      '{"t":"fire","angle":1e999,"power":2}',
      '{"t":"move","dir":2}',
      '{"t":"move","dir":"1"}',
      '{"t":"chat","text":5}',
      `{"t":"chat","text":"${'x'.repeat(1001)}"}`,
      '{"t":"name","name":null}',
      '{"t":"hello","v":1,"session":null,"name":"a","device":"fridge","room":{"kind":"public"}}',
      '{"t":"hello","v":1,"session":null,"name":"a","device":"phone","room":{"kind":"secret"}}',
      '{"t":"hello","v":1,"session":null,"name":"a","device":"phone","room":{"kind":"private","code":7}}',
      '{"t":"nuke"}',
      // Top-level game input is no longer accepted; it travels inside {"t":"g"}.
      '{"t":"fire","angle":1,"power":2}',
      '{"t":"g"}',
      '{"t":"g","m":{"t":"nuke"}}',
      '{"t":"g","m":{"t":"play","card":"1S"}}',
      '{"t":"g","m":{"t":"play","card":"QSX"}}',
      '{"t":"g","m":{"t":"pass","cards":["2C","3C"]}}',
      '{"t":"g","m":{"t":"pass","cards":["2C","3C",4]}}',
      '{"t":"pick","game":"chess"}',
      'x'.repeat(5000),
    ];
    for (const raw of bad) expect(parseClientMessage(raw), raw.slice(0, 60)).toBeNull();
  });

  it('strips unknown fields and never passes the client object through', () => {
    const raw = '{"t":"g","x":1,"m":{"t":"fire","angle":45,"power":50,"__proto__":{"admin":true},"level":50,"extra":{"deep":[1,2,3]}}}';
    const m = parseClientMessage(raw)!;
    expect(m).toEqual({ t: 'g', m: { t: 'fire', angle: 45, power: 50 } });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    const hello = parseClientMessage(
      '{"t":"hello","v":1,"session":null,"name":"a","device":"phone","room":{"kind":"public","code":"ZZZZZ","admin":1}}',
    )!;
    expect(hello).toEqual({ t: 'hello', v: 1, session: null, name: 'a', device: 'phone', room: { kind: 'public' } });
  });

  it('keeps a device number only if it looks like one of ours', () => {
    const hello = (deviceId: unknown) => parseClientMessage(JSON.stringify({ t: 'hello', v: 1, session: null, name: 'a', device: 'phone', room: { kind: 'public' }, deviceId }));
    const id = '0123456789abcdef0123456789abcdef';
    expect(hello(id)).toMatchObject({ t: 'hello', deviceId: id });
    // Anything else is just left off; the player still gets in.
    for (const bad of ['Jesse', id + '0', id.toUpperCase(), 42, null]) expect(hello(bad)).not.toHaveProperty('deviceId');
    expect(hello('Jesse')).toMatchObject({ t: 'hello', name: 'a' });
  });

  it('survives random garbage (fuzz)', () => {
    const rng = new Rng(1234);
    const pieces = ['{', '}', '[', ']', '"t"', ':', ',', '"fire"', '"hello"', '"g"', '"m"', '"play"', '"QS"', '1e308', '-0', 'null', 'true', '"\\u0000"', '"angle"', '"power"', '"room"', '{"kind":"private"}'];
    for (let i = 0; i < 20_000; i++) {
      let s = '';
      const n = rng.int(0, 12);
      for (let k = 0; k < n; k++) s += rng.pick(pieces);
      expect(() => parseClientMessage(s)).not.toThrow();
    }
  });
});

describe('text cleaning', () => {
  it('removes invisible and direction-flipping characters', () => {
    const rlo = String.fromCodePoint(0x202e);
    const zw = String.fromCodePoint(0x200b);
    expect(cleanText(`hi${rlo}dlrow${zw}`, 50)).toBe('hidlrow');
    expect(cleanText('line1\nline2\r\n\tend', 50)).toBe('line1 line2 end');
  });

  it('caps stacked accents (zalgo) at two per letter', () => {
    const zalgo = 'a' + String.fromCodePoint(0x0301).repeat(40) + 'b';
    expect([...cleanText(zalgo, 50)].length).toBe(4);
  });

  it('caps length without splitting emoji', () => {
    const s = '🙂'.repeat(30);
    const out = cleanName(s);
    expect([...out].length).toBe(MAX_NAME_LENGTH);
    expect(out).toBe('🙂'.repeat(MAX_NAME_LENGTH));
  });
});

describe('voice message parsing', () => {
  const rtc = (data: unknown) => parseClientMessage(JSON.stringify({ t: 'rtc', to: 'abcd1234', data }));
  it('accepts well-formed offers, answers and candidates', () => {
    expect(rtc({ sdp: { type: 'offer', sdp: 'v=0' } })).not.toBeNull();
    expect(rtc({ sdp: { type: 'answer', sdp: 'v=0' } })).not.toBeNull();
    expect(rtc({ candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } })).not.toBeNull();
    expect(parseClientMessage('{"t":"voice","join":true}')).toEqual({ t: 'voice', join: true });
  });
  it('rejects malformed or oversized ones', () => {
    expect(rtc({ sdp: { type: 'pranswer', sdp: 'v=0' } })).toBeNull();
    expect(rtc({ sdp: { type: 'offer', sdp: 'x'.repeat(12_001) } })).toBeNull();
    expect(rtc({ candidate: { candidate: 5 } })).toBeNull();
    expect(rtc({ candidate: { candidate: 'x', sdpMLineIndex: -1 } })).toBeNull();
    expect(rtc({ candidate: { candidate: 'x'.repeat(1001) } })).toBeNull();
    expect(rtc(null)).toBeNull();
    expect(parseClientMessage('{"t":"voice","join":"yes"}')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'rtc', to: 'x'.repeat(40), data: { sdp: { type: 'offer', sdp: 'v=0' } } }))).toBeNull();
  });
  it('strips extra fields from relayed signals', () => {
    const m = rtc({ sdp: { type: 'offer', sdp: 'v=0', evil: 1 }, extra: { a: 1 } })!;
    expect(m).toEqual({ t: 'rtc', to: 'abcd1234', data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  });
});
