import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canaryProblems, EMPTY_STATE, PORTS, Rollout, shareAssets, slotEnv, upstreams, type Health, type State, type System, type Unit } from './rollout';

/** A pretend game server machine: remembers files, commands, and which release each slot runs. */
function fakeMachine(opts: { failToStart?: boolean } = {}) {
  let state: State = structuredClone(EMPTY_STATE);
  const files = new Map<string, string>();
  const commands: string[] = [];
  const running = new Map<Unit, string>();
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
      const unit = args.at(-1)?.replace('games-drawer@', '') as Unit;
      if (cmd === 'systemctl' && args[0] === 'restart' && !opts.failToStart) {
        running.set(unit, /RELEASE=(\w+)/.exec(files.get(`/etc/games-drawer/slot-${unit}.env`) ?? '')![1]);
      }
      if (cmd === 'systemctl' && args[0] === 'stop') running.delete(unit);
      if (cmd === 'systemctl' && args[0] === 'is-active') return running.has(unit) ? 'active\n' : 'inactive\n';
      if (cmd === 'systemctl' && args[0] === 'show') return 'NRestarts=0\n';
      return '';
    },
    health: async (u): Promise<Health | null> => (running.has(u) ? { ok: true, release: running.get(u)!, slot: u === 'staging' ? null : u, draining: false } : null),
    stats: async () => ({ handlerErrors: 0, roomErrors: 0, players: 3, roomCount: 1 }),
    sleep: async () => {},
    log: () => {},
  };
  return { sys, files, commands, running, state: () => state };
}

function releaseDir(name: string) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gd-rel-')), name);
  fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deploy', 'setup.sh'), 'echo setup');
  return dir;
}

const upstreamFile = (m: ReturnType<typeof fakeMachine>) => m.files.get('/etc/caddy/games-drawer-upstreams.caddy') ?? '';

describe('rollout', () => {
  it('first deploy: the new copy takes everything, then is promoted', async () => {
    const m = fakeMachine();
    const r = new Rollout(m.sys, 'aaaaaaa1', releaseDir('aaaaaaa1'));
    await r.canary(10);
    expect(m.state().canary).toBe('a');
    expect(upstreamFile(m)).toContain(`reverse_proxy 127.0.0.1:${PORTS.a}`);
    expect(upstreamFile(m)).not.toContain('weighted');
    // Machine setup ran once, with its templates folder.
    expect(m.commands.some((c) => c.startsWith('bash ') && c.endsWith('deploy'))).toBe(true);

    await r.promote();
    expect(m.state()).toMatchObject({ active: 'a', canary: null });
    expect(m.commands).toContain('systemctl enable games-drawer@a');
    expect(m.commands.some((c) => c.includes('SIGUSR2'))).toBe(false);
  });

  it('next deploy: a canary share, a health check, then the old copy drains', async () => {
    const m = fakeMachine();
    await new Rollout(m.sys, 'aaaaaaa1', releaseDir('aaaaaaa1')).canary(10);
    await new Rollout(m.sys, 'aaaaaaa1', releaseDir('aaaaaaa1')).promote();

    const r = new Rollout(m.sys, 'bbbbbbb2', releaseDir('bbbbbbb2'));
    await r.canary(10);
    expect(m.state()).toMatchObject({ active: 'a', canary: 'b', releases: { a: 'aaaaaaa1', b: 'bbbbbbb2' } });
    expect(upstreamFile(m)).toContain(`reverse_proxy 127.0.0.1:${PORTS.a} 127.0.0.1:${PORTS.b}`);
    expect(upstreamFile(m)).toContain('lb_policy weighted_round_robin 90 10');
    expect(m.files.get('/etc/games-drawer/slot-b.env')).toContain('SLOT=b');
    expect(m.commands).toContain('systemctl reload caddy');

    expect(await r.check()).toBe(true);

    await r.promote();
    expect(m.state()).toMatchObject({ active: 'b', canary: null });
    expect(upstreamFile(m)).toContain(`reverse_proxy 127.0.0.1:${PORTS.b}`);
    expect(upstreamFile(m)).not.toContain(`${PORTS.a}`);
    expect(m.commands).toContain('systemctl disable games-drawer@a');
    expect(m.commands).toContain('systemctl kill --signal=SIGUSR2 --kill-whom=main games-drawer@a');

    // The deploy after that goes back into slot a.
    await new Rollout(m.sys, 'ccccccc3', releaseDir('ccccccc3')).canary(25);
    expect(m.state()).toMatchObject({ active: 'b', canary: 'a' });
    expect(upstreamFile(m)).toContain('weighted_round_robin 75 25');
  });

  it('rolls back: everything returns to the old copy and the canary stops', async () => {
    const m = fakeMachine();
    await new Rollout(m.sys, 'aaaaaaa1', releaseDir('aaaaaaa1')).canary(10);
    await new Rollout(m.sys, 'aaaaaaa1', releaseDir('aaaaaaa1')).promote();
    const r = new Rollout(m.sys, 'bbbbbbb2', releaseDir('bbbbbbb2'));
    await r.canary(10);
    await r.rollback();
    expect(m.state()).toMatchObject({ active: 'a', canary: null });
    expect(m.state().releases.b).toBeUndefined();
    expect(upstreamFile(m)).toContain(`reverse_proxy 127.0.0.1:${PORTS.a}`);
    expect(upstreamFile(m)).not.toContain(`${PORTS.b}`);
    expect(m.commands).toContain('systemctl stop games-drawer@b');
    expect(m.running.has('a')).toBe(true);
  });

  it('a canary that never comes up is stopped and nothing is rerouted', async () => {
    const m = fakeMachine({ failToStart: true });
    const r = new Rollout(m.sys, 'bbbbbbb2', releaseDir('bbbbbbb2'));
    await expect(r.canary(10)).rejects.toThrow(/didn't come up/);
    expect(m.commands).toContain('systemctl stop games-drawer@a');
    expect(m.commands).not.toContain('systemctl reload caddy');
    expect(m.state().canary).toBeNull();
  });

  it('staging runs in its own unit on its own port, without a slot', async () => {
    const m = fakeMachine();
    await new Rollout(m.sys, 'bbbbbbb2', releaseDir('bbbbbbb2')).staging();
    const env = m.files.get('/etc/games-drawer/slot-staging.env')!;
    expect(env).toContain(`GAME_PORT=${PORTS.staging}`);
    expect(env).not.toContain('SLOT=');
    expect(m.state().releases.staging).toBe('bbbbbbb2');
    expect(m.state().active).toBeNull();
  });
});

describe('rollout pieces', () => {
  it('fails a canary on any restart, crash or handler error', () => {
    expect(canaryProblems({ running: true, restarts: 0, roomErrors: 0, handlerErrors: 0 })).toEqual([]);
    expect(canaryProblems({ running: false, restarts: 0, roomErrors: 0, handlerErrors: 0 })).toHaveLength(1);
    expect(canaryProblems({ running: true, restarts: 1, roomErrors: 2, handlerErrors: 3 })).toHaveLength(3);
  });

  it('writes a complete env file for each slot', () => {
    expect(slotEnv('b', 'abc1234', '/opt/games-drawer/releases/abc1234')).toBe(
      'GAME_PORT=8802\nSLOT=b\nRELEASE=abc1234\nRELEASE_DIR=/opt/games-drawer/releases/abc1234\nLOG_DIR=/var/log/games-drawer/b\nADMIN_LOG_DIRS=/var/log/games-drawer/a,/var/log/games-drawer/b\n',
    );
  });

  it('answers "starting up" before anything is deployed', () => {
    expect(upstreams(structuredClone(EMPTY_STATE), 10)).toContain('503');
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
