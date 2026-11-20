import { describe, expect, it } from 'vitest';
import { chooseSlot, Fleet, fleetMap, RETIRE_GRACE_MINUTES, type Box, type Cloud, type FrontDoor, type Role } from './fleet';
import type { FleetMap, Slot } from './fleetMap';

/** A pretend AWS: boxes, the commands run on them, and where the front door points. */
function fakeCloud(opts: { failOn?: RegExp } = {}) {
  let boxes: Box[] = [];
  const records: Record<string, string> = {};
  const waited: string[] = [];
  let n = 0;
  const ran: { slot: Slot; command: string }[] = [];
  const logs: string[] = [];
  const cloud: Cloud = {
    boxes: () => boxes.map((b) => ({ ...b })),
    async launch(release, slot) {
      n++;
      const box: Box = { id: `i-${n}`, slot, release, role: 'candidate', privateIp: `10.0.0.${n}`, publicIp: `3.0.0.${n}`, launchedAt: `2026-11-20T10:0${n}:00Z` };
      boxes.push(box);
      return { ...box };
    },
    async run(box, command) {
      ran.push({ slot: box.slot, command });
      if (opts.failOn?.test(command)) throw new Error('failed');
      return `ran ${command.split(' ')[2]}`;
    },
    setRole(box, role: Role) {
      boxes = boxes.map((b) => (b.id === box.id ? { ...b, role } : b));
    },
    terminate(box) {
      boxes = boxes.filter((b) => b.id !== box.id);
    },
    async pointAt(names, ip) {
      for (const name of names) records[name] = ip;
    },
    pointsTo: (name) => records[name] ?? null,
    async waitForStaging(release) {
      waited.push(release);
    },
    log: (m) => logs.push(m),
  };
  const lastMap = (slot: Slot): FleetMap | null => {
    const r = ran.filter((x) => x.slot === slot && x.command.includes(' route ')).at(-1);
    return r ? JSON.parse(Buffer.from(r.command.split(' ').at(-1)!, 'base64').toString()) : null;
  };
  return { cloud, ran, logs, lastMap, records, waited, boxes: () => boxes, origin: () => records['origin.games.example'] ?? null };
}

const fleetOf = (f: ReturnType<typeof fakeCloud>, frontDoor: FrontDoor = 'cloudfront') => new Fleet(f.cloud, { domain: 'games.example', frontDoor });

describe('the fleet tool', () => {
  it('first deploy: one box takes everything once promoted, and the front door points at it', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f);
    await fleet.launch('aaaaaaa1');
    expect(f.ran[0]).toEqual({ slot: 'a', command: 'games-drawer-deploy aaaaaaa1 start a none' });
    expect(f.lastMap('a')).toEqual({ boxes: { a: '10.0.0.1' }, newTables: [['a', 100]], staging: 'a' });
    expect(f.logs).toContain('CANARY_SLOT=a');
    // Nobody is playing anywhere, so the front door points here at once (staging comes in through it).
    expect(f.origin()).toBe('3.0.0.1');
    await fleet.promote('aaaaaaa1');
    expect(f.origin()).toBe('3.0.0.1');
    expect(f.boxes()[0].role).toBe('current');
    expect(f.ran.some((r) => r.command.includes('retire'))).toBe(false);
  });

  it('a deploy: new box on staging, a canary share, then it takes over and the old box retires', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f);
    await fleet.launch('aaaaaaa1');
    await fleet.promote('aaaaaaa1');

    await fleet.launch('bbbbbbb2');
    // Players keep coming in through the current box until the new one is promoted.
    expect(f.origin()).toBe('3.0.0.1');
    // The new box starts knowing which release it replaces, and staging shows it; new tables stay put.
    expect(f.ran.find((r) => r.command.startsWith('games-drawer-deploy bbbbbbb2 start'))!.command).toBe('games-drawer-deploy bbbbbbb2 start b aaaaaaa1');
    for (const slot of ['a', 'b'] as const) expect(f.lastMap(slot)).toEqual({ boxes: { a: '10.0.0.1', b: '10.0.0.2' }, newTables: [['a', 100]], staging: 'b' });
    // Each box is told by its own release's tool.
    expect(f.ran.some((r) => r.slot === 'a' && r.command.startsWith('games-drawer-deploy aaaaaaa1 route '))).toBe(true);

    await fleet.canary('bbbbbbb2', 10);
    expect(f.ran).toContainEqual({ slot: 'a', command: 'games-drawer-deploy bbbbbbb2 share aaaaaaa1' });
    expect(f.lastMap('a')!.newTables).toEqual([['a', 90], ['b', 10]]);

    expect(await fleet.check('bbbbbbb2')).toBe(true);

    await fleet.promote('bbbbbbb2');
    expect(f.lastMap('a')!.newTables).toEqual([['b', 100]]);
    expect(f.origin()).toBe('3.0.0.2');
    expect(Object.fromEntries(f.boxes().map((b) => [b.slot, b.role]))).toEqual({ a: 'retiring', b: 'current' });
    expect(f.ran).toContainEqual({ slot: 'a', command: `games-drawer-deploy aaaaaaa1 retire ${RETIRE_GRACE_MINUTES}` });
  });

  it('rolls back: the new box goes, and the current box takes everything again', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f);
    await fleet.launch('aaaaaaa1');
    await fleet.promote('aaaaaaa1');
    await fleet.launch('bbbbbbb2');
    await fleet.canary('bbbbbbb2', 10);
    await fleet.rollback('bbbbbbb2');
    expect(f.boxes().map((b) => b.slot)).toEqual(['a']);
    expect(f.lastMap('a')).toEqual({ boxes: { a: '10.0.0.1' }, newTables: [['a', 100]], staging: 'a' });
    expect(f.origin()).toBe('3.0.0.1');
  });

  it('a failing check fails the deploy (and says why)', async () => {
    const f = fakeCloud({ failOn: / check$/ });
    const fleet = fleetOf(f);
    await fleet.launch('aaaaaaa1');
    expect(await fleet.check('aaaaaaa1')).toBe(false);
    expect(f.logs.at(-1)).toContain('failed');
  });

  it('removes a new box left from an unfinished deploy, and reuses its slot', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f);
    await fleet.launch('aaaaaaa1');
    await fleet.promote('aaaaaaa1');
    await fleet.launch('bbbbbbb2'); // …and the deploy stops here
    await fleet.launch('ccccccc3');
    expect(f.boxes().map((b) => `${b.slot}:${b.release.slice(0, 1)}:${b.role}`)).toEqual(['a:a:current', 'b:c:candidate']);
  });

  it('with old boxes still finishing their games, a new box takes a free slot', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f);
    for (const rel of ['aaaaaaa1', 'bbbbbbb2', 'ccccccc3']) {
      await fleet.launch(rel);
      await fleet.promote(rel);
    }
    expect(f.boxes().map((b) => `${b.slot}:${b.role}`)).toEqual(['a:retiring', 'b:retiring', 'c:current']);
    // Every box can reach every other box's tables.
    expect(Object.keys(f.lastMap('a')!.boxes).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('the fleet tool without CloudFront (FRONT_DOOR=direct)', () => {
  it('points the domain itself at the box taking players, and staging at the newest box', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f, 'direct');
    await fleet.launch('aaaaaaa1');
    // The first box: everything points at it, and staging answered over HTTPS before the smoke tests.
    expect(f.records).toEqual({ 'games.example': '3.0.0.1', 'www.games.example': '3.0.0.1', 'origin.games.example': '3.0.0.1', 'staging.games.example': '3.0.0.1' });
    expect(f.waited).toEqual(['aaaaaaa1']);
    // The names point at it before its routes are written (that reload is when Caddy asks for certificates).
    await fleet.promote('aaaaaaa1');

    await fleet.launch('bbbbbbb2');
    expect(f.records['staging.games.example']).toBe('3.0.0.2');
    expect(f.records['games.example']).toBe('3.0.0.1');
    await fleet.promote('bbbbbbb2');
    expect(f.records).toMatchObject({ 'games.example': '3.0.0.2', 'www.games.example': '3.0.0.2', 'staging.games.example': '3.0.0.2' });
  });

  it('rolling back points staging back at the current box', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f, 'direct');
    await fleet.launch('aaaaaaa1');
    await fleet.promote('aaaaaaa1');
    await fleet.launch('bbbbbbb2');
    await fleet.rollback('bbbbbbb2');
    expect(f.records['staging.games.example']).toBe('3.0.0.1');
    expect(f.records['games.example']).toBe('3.0.0.1');
  });

  it('behind CloudFront, only origin. moves, and staging comes through the front door', () => {
    expect(fleetOf(fakeCloud()).frontNames()).toEqual(['origin.games.example']);
    expect(fleetOf(fakeCloud()).stagingNames()).toEqual([]);
    expect(fleetOf(fakeCloud(), 'direct').frontNames()).toEqual(['games.example', 'www.games.example', 'origin.games.example']);
  });
});

describe('fleet pieces', () => {
  const box = (slot: Slot, role: Role, launchedAt: string): Box => ({ id: `i-${slot}`, slot, release: 'r', role, privateIp: '10.0.0.1', publicIp: '', launchedAt });

  it('picks the first free slot, or takes the oldest retiring box’s', () => {
    expect(chooseSlot([])).toEqual({ slot: 'a', evict: null });
    expect(chooseSlot([box('a', 'current', '1')])).toEqual({ slot: 'b', evict: null });
    const full = [box('a', 'retiring', '2'), box('b', 'retiring', '1'), box('c', 'retiring', '3'), box('d', 'current', '4')];
    expect(chooseSlot(full)).toMatchObject({ slot: 'b', evict: { slot: 'b' } });
    expect(() => chooseSlot(full.map((b) => ({ ...b, role: 'current' as Role })))).toThrow();
  });

  it('builds the map every box routes by', () => {
    expect(fleetMap([box('a', 'current', '1'), { ...box('c', 'candidate', '2'), privateIp: '10.0.0.9' }], [['a', 100]], 'c')).toEqual({
      boxes: { a: '10.0.0.1', c: '10.0.0.9' },
      newTables: [['a', 100]],
      staging: 'c',
    });
  });
});
