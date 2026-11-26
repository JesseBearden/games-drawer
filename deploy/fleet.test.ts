import { describe, expect, it } from 'vitest';
import {
  chooseSlot,
  Fleet,
  fleetMap,
  olderThanOldest,
  OldBoxNotRetired,
  OLDEST_RELEASE,
  RETIRE_GRACE_MINUTES,
  RETIRE_TRIES,
  siteSettings,
  type Box,
  type Cloud,
  type FrontDoor,
  type Role,
} from './fleet';
import type { FleetMap, Slot } from './fleetMap';

/** A pretend AWS: boxes, the commands run on them, and where the front door points. */
function fakeCloud(opts: { failOn?: RegExp; runFails?: (box: Box, command: string) => boolean; whileBooting?: () => void } = {}) {
  let boxes: Box[] = [];
  const records: Record<string, string> = {};
  const waited: string[] = [];
  const slept: number[] = [];
  let n = 0;
  const ran: { slot: Slot; command: string }[] = [];
  const logs: string[] = [];
  const cloud: Cloud = {
    boxes: () => boxes.map((b) => ({ ...b })),
    async launch(release, slot) {
      n++;
      const box: Box = { id: `i-${n}`, slot, release, role: 'candidate', privateIp: `10.0.0.${n}`, publicIp: `3.0.0.${n}`, launchedAt: `2026-11-20T10:0${n}:00Z` };
      boxes.push(box);
      opts.whileBooting?.();
      return { ...box };
    },
    async run(box, command) {
      ran.push({ slot: box.slot, command });
      // As Systems Manager does for a box that has shut down.
      if (!boxes.some((b) => b.id === box.id)) throw new Error('InvalidInstanceId');
      if (opts.runFails?.(box, command)) throw new Error('timed out');
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
    async sleep(ms) {
      slept.push(ms);
    },
    log: (m) => logs.push(m),
  };
  const lastMap = (slot: Slot): FleetMap | null => {
    const r = ran.filter((x) => x.slot === slot && x.command.includes(' route ')).at(-1);
    return r ? JSON.parse(Buffer.from(r.command.split(' ').at(-1)!, 'base64').toString()) : null;
  };
  return { cloud, ran, logs, lastMap, records, waited, slept, boxes: () => boxes, origin: () => records['origin.games.example'] ?? null };
}

const fleetOf = (f: ReturnType<typeof fakeCloud>, frontDoor: FrontDoor = 'cloudfront') => new Fleet(f.cloud, { domain: 'games.example', frontDoor });

describe('the fleet tool', () => {
  it('lets only what’s on staging go live', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f);
    // Nothing is live: any release may bring the site up.
    fleet.onStaging('aaaaaaa1');
    await fleet.launch('aaaaaaa1');
    await fleet.promote('aaaaaaa1');
    expect(() => fleet.onStaging('aaaaaaa1')).toThrow('nothing new is on staging');

    await fleet.launch('bbbbbbb2');
    fleet.onStaging('bbbbbbb2');
    // Approved, but staging moved on since.
    await fleet.launch('ccccccc3');
    expect(() => fleet.onStaging('bbbbbbb2')).toThrow('staging shows ccccccc');
    fleet.onStaging('ccccccc3');
    await fleet.rollback('ccccccc3');
    expect(() => fleet.onStaging('ccccccc3')).toThrow('nothing new is on staging');
  });

  it('first deploy: one box takes everything once promoted, and the front door points at it', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f);
    await fleet.launch('aaaaaaa1');
    // It waits for the box's first boot to finish, then starts the release.
    expect(f.ran[0].command).toContain('cloud-init status --wait');
    expect(f.ran[1]).toEqual({ slot: 'a', command: 'games-drawer-deploy aaaaaaa1 start a none' });
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

describe('a box that has gone, or won’t answer', () => {
  /** a is retiring, b is current. */
  async function twoBoxes(opts: Parameters<typeof fakeCloud>[0]) {
    const f = fakeCloud(opts);
    const fleet = fleetOf(f, 'direct');
    for (const rel of ['aaaaaaa1', 'bbbbbbb2']) {
      await fleet.launch(rel);
      await fleet.promote(rel);
    }
    return { f, fleet };
  }

  it('a retiring box that shuts down while the new one boots is left out of the routes', async () => {
    let booting = () => {};
    const { f, fleet } = await twoBoxes({ whileBooting: () => booting() });
    booting = () => f.cloud.terminate(f.boxes().find((b) => b.role === 'retiring')!);
    const before = f.ran.length;
    await fleet.launch('ccccccc3');
    expect(f.ran.slice(before).filter((r) => r.slot === 'a')).toEqual([]);
    expect(Object.keys(f.lastMap('b')!.boxes).sort()).toEqual(['b', 'c']);
    expect(f.logs).toContain('CANARY_SLOT=c');
  });

  it('a retiring box that won’t answer doesn’t stop a deploy', async () => {
    let wedged = false;
    const { f, fleet } = await twoBoxes({ runFails: (box) => wedged && box.slot === 'a' });
    wedged = true;
    await fleet.launch('ccccccc3');
    await fleet.canary('ccccccc3', 10);
    expect(f.lastMap('b')!.newTables).toEqual([['b', 90], ['c', 10]]);
    await fleet.promote('ccccccc3');
    expect(f.origin()).toBe('3.0.0.3');
  });

  it('…or a rollback', async () => {
    let wedged = false;
    const { f, fleet } = await twoBoxes({ runFails: (box) => wedged && box.slot === 'a' });
    await fleet.launch('ccccccc3');
    wedged = true;
    await fleet.rollback('ccccccc3');
    expect(f.boxes().map((b) => b.slot)).toEqual(['a', 'b']);
    expect(f.lastMap('b')!.newTables).toEqual([['b', 100]]);
  });

  it('the current box not answering still fails a deploy', async () => {
    let wedged = false;
    const { f, fleet } = await twoBoxes({ runFails: (box) => wedged && box.slot === 'b' });
    await fleet.launch('ccccccc3');
    wedged = true;
    await expect(fleet.canary('ccccccc3', 10)).rejects.toThrow('timed out');
    expect(f.origin()).toBe('3.0.0.2');
  });

  it('a rollback that can’t route still removes the new box, and says it failed', async () => {
    let wedged = false;
    const { f, fleet } = await twoBoxes({ runFails: (box) => wedged && box.slot === 'b' });
    await fleet.launch('ccccccc3');
    wedged = true;
    await expect(fleet.rollback('ccccccc3')).rejects.toThrow('timed out');
    expect(f.boxes().map((b) => b.slot)).toEqual(['a', 'b']);
  });

  it('but never a box the site may still point at', async () => {
    const { f, fleet } = await twoBoxes({});
    await fleet.launch('ccccccc3');
    f.cloud.pointsTo = () => {
      throw new Error('lookup failed');
    };
    await expect(fleet.rollback('ccccccc3')).rejects.toThrow('lookup failed');
    expect(f.boxes().map((b) => b.slot)).toContain('c');
  });
});

describe('retiring the old box once the new one has taken over', () => {
  /** b is current, c is on staging; telling b to retire fails `failures` times. */
  async function goingLive(failures: number) {
    let left = 0;
    const f = fakeCloud({ runFails: (_, command) => command.includes(' retire ') && left-- > 0 });
    const fleet = fleetOf(f, 'direct');
    for (const rel of ['bbbbbbb2', 'ccccccc3']) {
      await fleet.launch(rel);
      if (rel === 'bbbbbbb2') await fleet.promote(rel);
    }
    left = failures;
    return { f, fleet };
  }

  it('tries again when it doesn’t take the first time', async () => {
    const { f, fleet } = await goingLive(RETIRE_TRIES - 1);
    await fleet.promote('ccccccc3');
    expect(f.ran.filter((r) => r.command.includes(' retire '))).toHaveLength(RETIRE_TRIES);
    expect(f.slept).toHaveLength(RETIRE_TRIES - 1);
    expect(Object.fromEntries(f.boxes().map((b) => [b.slot, b.role]))).toEqual({ a: 'retiring', b: 'current' });
  });

  it('if it never takes, the new release is still live, and it says what is left to do', async () => {
    const { f, fleet } = await goingLive(99);
    const promoting = fleet.promote('ccccccc3');
    await expect(promoting).rejects.toBeInstanceOf(OldBoxNotRetired);
    await expect(promoting).rejects.toThrow(/ccccccc is live; old box a \(i-1\) still needs to retire: npx tsx deploy\/fleet\.ts retire/);
    // Nothing to roll back: the site is on the new box, and the old one is marked as on its way out.
    expect(f.records['games.example']).toBe('3.0.0.2');
    expect(Object.fromEntries(f.boxes().map((b) => [b.slot, b.role]))).toEqual({ a: 'retiring', b: 'current' });
    await fleet.rollback('ccccccc3');
    expect(f.boxes()).toHaveLength(2);
    expect(f.records['games.example']).toBe('3.0.0.2');

    // Once the old box answers again, `retire` finishes the job.
    const before = f.ran.length;
    f.cloud.run = async (box, command) => {
      f.ran.push({ slot: box.slot, command });
      return 'ok';
    };
    await fleet.retireOld();
    expect(f.ran.slice(before)).toEqual([{ slot: 'a', command: `games-drawer-deploy bbbbbbb2 retire ${RETIRE_GRACE_MINUTES}` }]);
  });

  it('`retire` also catches an old box a stopped promote left marked current', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f);
    await fleet.launch('aaaaaaa1');
    await fleet.promote('aaaaaaa1');
    await fleet.launch('bbbbbbb2');
    // A promote that stopped right after marking the new box current.
    f.cloud.setRole(f.boxes().find((b) => b.slot === 'b')!, 'current');
    await fleet.retireOld();
    expect(Object.fromEntries(f.boxes().map((b) => [b.slot, b.role]))).toEqual({ a: 'retiring', b: 'current' });
    expect(f.ran.at(-1)).toEqual({ slot: 'a', command: `games-drawer-deploy aaaaaaa1 retire ${RETIRE_GRACE_MINUTES}` });
  });
});

describe('a launch never leaves the site, or staging, pointing at a box it removes', () => {
  it('moves staging to the current box before removing the box it showed', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f, 'direct');
    await fleet.launch('aaaaaaa1');
    await fleet.promote('aaaaaaa1');
    await fleet.launch('bbbbbbb2');
    const terminate = f.cloud.terminate;
    const stagingWhenRemoved: (string | undefined)[] = [];
    f.cloud.terminate = (box) => {
      stagingWhenRemoved.push(f.records['staging.games.example']);
      terminate(box);
    };
    await fleet.launch('ccccccc3');
    // b (3.0.0.2) went while staging pointed at the current box, a, not at b's released address.
    expect(stagingWhenRemoved).toEqual(['3.0.0.1']);
    expect(f.records['staging.games.example']).toBe('3.0.0.3');
    expect(f.records['games.example']).toBe('3.0.0.1');
  });

  it('with nothing taking players, keeps the new box the site points at, as the current box', async () => {
    for (const frontDoor of ['direct', 'cloudfront'] as const) {
      const f = fakeCloud();
      const fleet = fleetOf(f, frontDoor);
      // The first deploy's staging step: with no site yet, the front door points at the new box.
      await fleet.launch('aaaaaaa1');
      // Another push before anyone went live.
      await fleet.launch('bbbbbbb2');
      expect(f.boxes().map((b) => `${b.slot}:${b.release.slice(0, 1)}:${b.role}`)).toEqual(['a:a:current', 'b:b:candidate']);
      expect(f.origin()).toBe('3.0.0.1');
      // From here it's an ordinary go-live, and nobody on the site is cut off.
      await fleet.canary('bbbbbbb2', 10);
      expect(f.lastMap('a')!.newTables).toEqual([['a', 90], ['b', 10]]);
      await fleet.promote('bbbbbbb2');
      expect(f.origin()).toBe('3.0.0.2');
      expect(f.ran).toContainEqual({ slot: 'a', command: `games-drawer-deploy aaaaaaa1 retire ${RETIRE_GRACE_MINUTES}` });
    }
  });

  it('a leftover box the site doesn’t point at still goes, even with nothing taking players', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f, 'direct');
    await fleet.launch('aaaaaaa1');
    // Say the site's names were moved off it by hand.
    await f.cloud.pointAt(fleet.frontNames(), '3.9.9.9');
    await fleet.launch('bbbbbbb2');
    expect(f.boxes().map((b) => `${b.release.slice(0, 1)}:${b.role}`)).toEqual(['b:candidate']);
  });
});

describe('releases older than the oldest a deploy may use', () => {
  const git = (status: number | null) => () => {
    if (status !== null) throw Object.assign(new Error('git'), { status });
  };
  it('are refused when git says so, and let through quietly when it can’t tell', () => {
    expect(OLDEST_RELEASE).toMatch(/^a85fbc8[0-9a-f]{33}$/);
    expect(olderThanOldest('1234567', git(1))).toBe(true);
    expect(olderThanOldest('1234567', git(null))).toBe(false);
    // 128: not a repository (the pipeline's copy has no .git) or a commit this checkout lacks.
    expect(olderThanOldest('1234567', git(128))).toBe(false);
    // No git at all.
    expect(olderThanOldest('1234567', git(undefined as unknown as number))).toBe(false);
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

  it('a promote that moved the site but stopped before marking the new box current: rollback moves the site back first', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f, 'direct');
    await fleet.launch('aaaaaaa1');
    await fleet.promote('aaaaaaa1');
    await fleet.launch('bbbbbbb2');
    // Promote got as far as DNS, then the laptop slept.
    await f.cloud.pointAt(fleet.frontNames(), '3.0.0.2');
    await fleet.rollback('bbbbbbb2');
    expect(f.boxes().map((b) => b.release)).toEqual(['aaaaaaa1']);
    expect(f.records).toMatchObject({ 'games.example': '3.0.0.1', 'www.games.example': '3.0.0.1', 'origin.games.example': '3.0.0.1', 'staging.games.example': '3.0.0.1' });
  });

  it('…and so does the next launch, before it clears away the half-promoted box', async () => {
    const f = fakeCloud();
    const fleet = fleetOf(f, 'direct');
    await fleet.launch('aaaaaaa1');
    await fleet.promote('aaaaaaa1');
    await fleet.launch('bbbbbbb2');
    await f.cloud.pointAt(fleet.frontNames(), '3.0.0.2');
    await fleet.launch('ccccccc3');
    expect(f.records['games.example']).toBe('3.0.0.1');
    expect(f.boxes().map((b) => b.release).sort()).toEqual(['aaaaaaa1', 'ccccccc3']);
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

describe('deploy settings', () => {
  const config = { domain: 'gamesdrawer.com', frontDoor: 'direct' };
  it('come from infra/config.json, so a forgotten FRONT_DOOR can no longer mean CloudFront', () => {
    expect(siteSettings({}, config)).toEqual({ domain: 'gamesdrawer.com', frontDoor: 'direct' });
    expect(siteSettings({ FRONT_DOOR: 'direct', SITE_DOMAIN: 'gamesdrawer.com' }, config)).toEqual({ domain: 'gamesdrawer.com', frontDoor: 'direct' });
  });
  it('refuse an environment that contradicts the config', () => {
    expect(() => siteSettings({ FRONT_DOOR: 'cloudfront' }, config)).toThrow(/infra\/config.json says direct/);
    expect(() => siteSettings({ SITE_DOMAIN: 'example.com' }, config)).toThrow(/SITE_DOMAIN/);
  });
  it('need a domain and a valid front door from somewhere', () => {
    expect(() => siteSettings({}, {})).toThrow(/SITE_DOMAIN/);
    expect(() => siteSettings({ SITE_DOMAIN: 'x.example', FRONT_DOOR: 'satellite' }, {})).toThrow(/cloudfront or direct/);
  });
});
