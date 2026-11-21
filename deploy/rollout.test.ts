import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_PORT, HOP_HEADER, isFleetMap, routesSnippet, soloMap, type FleetMap } from './fleetMap';
import { decodeMap, EMPTY_STATE, ROUTES_FILE, Rollout, serverProblems, shareAssets, slotEnv, type Health, type State, type System } from './rollout';

/** A pretend game server box: remembers files and commands, and whether its server runs. */
function fakeBox(opts: { failToStart?: boolean; failFetch?: boolean } = {}) {
  let state: State = structuredClone(EMPTY_STATE);
  const files = new Map<string, string>();
  const commands: string[] = [];
  let running: string | null = null;
  let clock = 1_000_000;
  const sys: System = {
    readState: () => structuredClone(state),
    writeState: (s) => {
      state = structuredClone(s);
    },
    writeFile: (f, t) => {
      files.set(f, t);
    },
    sh: (cmd, args) => {
      commands.push([cmd, ...args].join(' '));
      if (opts.failFetch && args[1] === 'fetch') throw new Error('download failed: 404');
      const unit = args.at(-1) ?? '';
      if (cmd === 'systemctl' && args[0] === 'restart' && !opts.failToStart) {
        running = /RELEASE=(\w+)/.exec(files.get(`/etc/games-drawer/slot-${unit.replace('games-drawer@', '')}.env`) ?? '')![1];
      }
      if (cmd === 'systemctl' && args[0] === 'stop') running = null;
      if (cmd === 'systemctl' && args[0] === 'is-active') return running ? 'active\n' : 'inactive\n';
      if (cmd === 'systemctl' && args[0] === 'show') return 'NRestarts=0\n';
      return '';
    },
    health: async (): Promise<Health | null> => (running ? { ok: true, release: running, slot: state.slot, draining: false } : null),
    stats: async () => ({ handlerErrors: 0, roomErrors: 0, players: 3, roomCount: 1 }),
    privateIp: () => '10.0.0.11',
    domain: () => 'games.example',
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
  };
  return {
    sys,
    files,
    commands,
    state: () => state,
    stopServer: () => {
      running = null;
    },
    clock: () => clock,
  };
}

function releaseDir(name: string) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gd-rel-')), name);
  fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deploy', 'setup.sh'), 'echo setup');
  return dir;
}

const two: FleetMap = { boxes: { a: '10.0.0.11', b: '10.0.0.22' }, newTables: [['b', 100]], staging: 'b' };

describe('the rollout tool on a box', () => {
  it('starts a new box: sets it up, starts its server, and serves everything itself until told otherwise', async () => {
    const m = fakeBox();
    await new Rollout(m.sys, 'aaaaaaa1', releaseDir('aaaaaaa1')).start('c');
    expect(m.state()).toEqual({ slot: 'c', release: 'aaaaaaa1', retiring: false });
    expect(m.files.get('/etc/games-drawer/slot-c.env')).toContain('SLOT=c');
    expect(m.commands).toContain('systemctl enable games-drawer@c');
    // Machine setup ran once, with its templates folder.
    expect(m.commands.some((c) => c.startsWith('bash ') && c.endsWith('deploy'))).toBe(true);
    const routes = m.files.get(ROUTES_FILE)!;
    expect(routes).toContain(`reverse_proxy 127.0.0.1:${GAME_PORT}`);
    expect(routes).not.toContain(':8080');
  });

  it('fetches the release it replaces, so pages from the old box still find their build files', async () => {
    const m = fakeBox();
    await new Rollout(m.sys, 'bbbbbbb2', releaseDir('bbbbbbb2')).start('b', 'aaaaaaa1');
    expect(m.commands).toContain('/usr/local/bin/games-drawer-deploy aaaaaaa1 fetch');
  });

  it('still starts when the release it replaces has expired from storage (after 60 quiet days)', async () => {
    const m = fakeBox({ failFetch: true });
    await new Rollout(m.sys, 'bbbbbbb2', releaseDir('bbbbbbb2')).start('b', 'aaaaaaa1');
    expect(m.state().slot).toBe('b');
    expect(m.state().release).toBe('bbbbbbb2');
  });

  it('a server that never comes up is stopped, and the box is left unclaimed', async () => {
    const m = fakeBox({ failToStart: true });
    await expect(new Rollout(m.sys, 'bbbbbbb2', releaseDir('bbbbbbb2')).start('b')).rejects.toThrow(/didn't come up/);
    expect(m.commands).toContain('systemctl stop games-drawer@b');
    expect(m.state().slot).toBeNull();
    expect(m.files.has(ROUTES_FILE)).toBe(false);
  });

  it('reroutes from the fleet map', async () => {
    const m = fakeBox();
    const r = new Rollout(m.sys, 'aaaaaaa1', releaseDir('aaaaaaa1'));
    await r.start('a');
    r.route(two);
    const routes = m.files.get(ROUTES_FILE)!;
    // Tables on box a stay here; new tables go to box b.
    expect(routes).toMatch(/handle @slot_a \{\n\treverse_proxy 127\.0\.0\.1:8801 \{\n\t\tstream_close_delay 4h\n\t\}\n\}/);
    expect(routes).toMatch(/handle \{\n\treverse_proxy 10\.0\.0\.22:8080 \{/);
    expect(m.commands).toContain('systemctl reload caddy');
    // A map that leaves this box out is refused.
    expect(() => r.route({ boxes: { b: '10.0.0.22' }, newTables: [['b', 100]], staging: 'b' })).toThrow(/doesn't include this box/);
  });

  it('retires: the server finishes its games, and the box powers off once they are done and the grace time has passed', async () => {
    const m = fakeBox();
    const rel = releaseDir('aaaaaaa1');
    const r = new Rollout(m.sys, 'aaaaaaa1', rel);
    await r.start('a');
    r.retire(15);
    expect(m.commands).toContain('systemctl kill --signal=SIGUSR2 --kill-whom=main games-drawer@a');
    expect(m.commands).toContain('systemctl disable games-drawer@a');
    const job = m.commands.find((c) => c.startsWith('systemd-run'))!;
    expect(job).toContain('--unit=games-drawer-retire');
    const notBefore = Number(job.split(' ').at(-1));
    expect(notBefore).toBe(m.clock() + 15 * 60_000);
    expect(m.state().retiring).toBe(true);
    // Retiring twice is harmless.
    r.retire(15);
    expect(m.commands.filter((c) => c.startsWith('systemd-run'))).toHaveLength(1);

    // The background job: games still going, so it waits; then they end, and it waits out the grace time.
    m.stopServer();
    await r.finish(notBefore);
    expect(m.clock()).toBeGreaterThanOrEqual(notBefore);
    expect(m.commands.at(-1)).toBe('systemctl poweroff');
  });

  it('checks the server: healthy, or why not', async () => {
    const m = fakeBox();
    const r = new Rollout(m.sys, 'aaaaaaa1', releaseDir('aaaaaaa1'));
    await r.start('a');
    expect(await r.check()).toBe(true);
    m.stopServer();
    expect(await r.check()).toBe(false);
  });
});

describe('rollout pieces', () => {
  it('fails a server on any restart, crash or handler error', () => {
    expect(serverProblems({ running: true, restarts: 0, roomErrors: 0, handlerErrors: 0 })).toEqual([]);
    expect(serverProblems({ running: false, restarts: 0, roomErrors: 0, handlerErrors: 0 })).toHaveLength(1);
    expect(serverProblems({ running: true, restarts: 1, roomErrors: 2, handlerErrors: 3 })).toHaveLength(3);
  });

  it('writes a complete env file for the box’s server', () => {
    expect(slotEnv('b', 'abc1234', '/opt/games-drawer/releases/abc1234')).toBe('GAME_PORT=8801\nSLOT=b\nRELEASE=abc1234\nRELEASE_DIR=/opt/games-drawer/releases/abc1234\n');
  });

  it('reads the fleet map the fleet tool sends, and refuses anything else', () => {
    expect(decodeMap(Buffer.from(JSON.stringify(two)).toString('base64'))).toEqual(two);
    expect(() => decodeMap('not base64 json')).toThrow();
    expect(() => decodeMap(Buffer.from('{"boxes":{}}').toString('base64'))).toThrow(/not a fleet map/);
  });

  it('shares build assets between two releases in both directions', () => {
    const a = releaseDir('a1');
    const b = releaseDir('b2');
    for (const [dir, f] of [
      [a, 'index-OLD.js'],
      [b, 'index-NEW.js'],
    ]) {
      fs.mkdirSync(path.join(dir, 'client', 'assets'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'client', 'assets', f), f);
    }
    shareAssets(a, b);
    for (const dir of [a, b]) expect(fs.readdirSync(path.join(dir, 'client', 'assets')).sort()).toEqual(['index-NEW.js', 'index-OLD.js']);
  });
});

describe('routes from the fleet map', () => {
  const canary: FleetMap = { boxes: { a: '10.0.0.11', b: '10.0.0.22' }, newTables: [['a', 90], ['b', 10]], staging: 'b' };

  it('on the current box: its own tables here, the canary’s there, new tables split by weight', () => {
    const r = routesSnippet(canary, 'a', 'games.example');
    expect(r).toContain('redir https://games.example{uri} permanent');
    expect(r).toMatch(/handle @slot_a \{\n\treverse_proxy 127\.0\.0\.1:8801 \{\n\t\tstream_close_delay 4h\n\t\}\n\}/);
    expect(r).toMatch(/handle @slot_b \{\n\treverse_proxy 10\.0\.0\.22:8080 \{\n\t\theader_up X-Gd-Hop 1\n\t\tstream_close_delay 4h\n\t\}\n\}/);
    expect(r).toContain('reverse_proxy 127.0.0.1:8801 10.0.0.22:8080 {\n\t\tlb_policy weighted_round_robin 90 10');
    // A reload (every route change) never drops anyone: every proxy keeps its open connections.
    const proxies = r.match(/reverse_proxy [^\n]*\{[^}]*\}/g)!;
    expect(proxies).toHaveLength(r.split('reverse_proxy').length - 1);
    for (const p of proxies) expect(p).toContain('stream_close_delay 4h');
    // Staging is the newest box.
    expect(r).toMatch(/@staging host staging\.games\.example\nhandle @staging \{\n\treverse_proxy 10\.0\.0\.22:8080/);
  });

  it('passed-on requests are always served by the box they reach (no loops between boxes)', () => {
    for (const self of ['a', 'b'] as const) {
      const r = routesSnippet(canary, self, 'games.example');
      expect(r).toMatch(new RegExp(`@hop header ${HOP_HEADER} 1\\nhandle @hop \\{\\n\\treverse_proxy 127\\.0\\.0\\.1:8801 \\{`));
      // The hop rule comes before every rule that could pass the request on again.
      expect(r.indexOf('handle @hop')).toBeLessThan(r.indexOf('handle @staging'));
      expect(r.indexOf('handle @hop')).toBeLessThan(r.indexOf('handle @slot_'));
      expect(r.indexOf('handle @hop')).toBeLessThan(r.indexOf('handle {'));
    }
  });

  it('on a retiring box: its own tables still here, everything new goes to the current box', () => {
    const r = routesSnippet(two, 'a', 'games.example');
    expect(r).toMatch(/handle @slot_a \{\n\treverse_proxy 127\.0\.0\.1:8801/);
    expect(r).toMatch(/handle \{\n\treverse_proxy 10\.0\.0\.22:8080 \{\n\t\theader_up X-Gd-Hop 1/);
    expect(r).not.toContain('weighted');
  });

  it('checks a map before trusting it', () => {
    expect(isFleetMap(two)).toBe(true);
    expect(isFleetMap(soloMap('c', '10.0.0.5'))).toBe(true);
    expect(isFleetMap({ ...two, newTables: [['c', 100]] })).toBe(false);
    expect(isFleetMap({ ...two, staging: 'd' })).toBe(false);
    expect(isFleetMap({ ...two, boxes: { a: 'not-an-ip' } })).toBe(false);
    expect(isFleetMap({ ...two, boxes: { e: '10.0.0.1' } })).toBe(false);
    expect(isFleetMap({ ...two, newTables: [] })).toBe(false);
  });
});
