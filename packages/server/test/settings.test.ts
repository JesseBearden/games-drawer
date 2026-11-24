import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IDLE_ROOM_MS } from '../src/room';
import { readSettings } from '../src/settings';

describe('settings from the environment', () => {
  const defaults = readSettings({});

  it('have defaults, and a blank one means the default rather than 0', () => {
    expect(defaults).toMatchObject({ port: 8787, emptyRoomMs: 60_000, idleRoomMs: IDLE_ROOM_MS, maxPrivateRooms: 50, turnTtlSeconds: 86_400, limits: {} });
    const blank = Object.fromEntries(['GAME_PORT', 'EMPTY_ROOM_MS', 'IDLE_ROOM_MS', 'MAX_PRIVATE_ROOMS', 'TURN_TTL_SECONDS', 'DRAIN_MAX_MS', 'LIMITS', 'VOICE_ICE_SERVERS'].map((n) => [n, ' ']));
    expect(readSettings(blank)).toEqual(defaults);
  });

  it('stop the start, saying which, when one makes no sense', () => {
    const bad: [string, string][] = [
      ['GAME_PORT', '99999'],
      ['EMPTY_ROOM_MS', 'soon'],
      ['MAX_PRIVATE_ROOMS', '-1'],
      ['TURN_TTL_SECONDS', 'a day'],
      ['DRAIN_MAX_MS', '1e99'],
      ['IDLE_ROOM_MS', '0'],
      ['LIMITS', '{'],
      ['LIMITS', '{"noSuchLimit":3}'],
      ['LIMITS', '{"messageRate":"lots"}'],
      ['VOICE_ICE_SERVERS', '{"urls":"stun:x"}'],
      ['VOICE_ICE_SERVERS', '[null]'],
    ];
    for (const [name, value] of bad) expect(() => readSettings({ [name]: value }), `${name}=${value}`).toThrow(name);
  });

  it('accept what the boxes set (deploy/setup.sh)', () => {
    const setup = fs.readFileSync(new URL('../../../deploy/setup.sh', import.meta.url), 'utf8');
    const limits = /^LIMITS='(.*)'$/m.exec(setup)![1];
    expect(readSettings({ LIMITS: limits }).limits).toEqual({ privateRoomsPer10Min: 30 });
  });
});
