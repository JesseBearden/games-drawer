import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// deploy.sh with a pretend npx: no AWS, no browser, no network. (On Windows it needs Git Bash:
// plain "bash" there can be WSL's.)
const windows = process.platform === 'win32';
const bash = windows ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const script = new URL('./deploy.sh', import.meta.url);
/** A Windows path as Git Bash writes it. */
const sh = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

/** Run it with `npx` answering as `fake` says. */
function deploy(fake: string, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-deploy-'));
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(dir, 'npx'), `#!/usr/bin/env bash\necho "$*" >> "${sh(calls)}"\n${fake}\n`, { mode: 0o755 });
  const copy = path.join(dir, 'deploy.sh');
  fs.writeFileSync(copy, fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n'));
  const run = spawnSync(bash, ['-c', `PATH="${sh(dir)}:$PATH"; source "${sh(copy)}" abcdef1`], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, AWS_REGION: 'none', SITE_DOMAIN: 'games.example', LAUNCH_TEMPLATE: 'none', SKIP_BROWSER_INSTALL: '1', STAGING_ONLY: '', CANARY_MINUTES: '0', ...env },
  });
  const called = fs.readFileSync(calls, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: run.status, out: run.stdout, rollbacks: called.match(/ rollback abcdef1/g)?.length ?? 0, called };
}

const LAUNCHES = 'case "$*" in *" launch "*) echo "Launching box b"; echo CANARY_SLOT=b;; esac';

describe.skipIf(windows && !fs.existsSync(bash))('deploy.sh', () => {
  it('a failed launch leaves its log to read, then rolls back', () => {
    const r = deploy('case "$*" in *" launch "*) echo "Started i-1; waiting for it to boot"; echo "then it broke"; exit 1;; esac');
    expect(r.out).toContain('Started i-1; waiting for it to boot');
    expect(r.out).toContain('then it broke');
    expect(r.status).not.toBe(0);
    expect(r.rollbacks).toBe(1);
  }, 20_000);

  for (const [signal, status] of [['INT', 130], ['TERM', 143]] as const) {
    it(`stopped with ${signal}, it removes the new box`, () => {
      const r = deploy(`${LAUNCHES}\ncase "$*" in *playwright*) kill -${signal} $PPID;; esac`);
      expect(r.out).toContain('The deploy was stopped.');
      expect(r.status).toBe(status);
      expect(r.rollbacks).toBe(1);
      expect(r.called).not.toContain(' promote ');
    }, 20_000);
  }

  it('one that works reads the slot from the launch, and rolls nothing back', () => {
    const r = deploy(LAUNCHES);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Canary: box b');
    expect(r.called).toContain(' promote abcdef1');
    expect(r.rollbacks).toBe(0);
  }, 20_000);

  it('staging only stops after the smoke tests', () => {
    const r = deploy(LAUNCHES, { STAGING_ONLY: '1' });
    expect(r.status).toBe(0);
    expect(r.called).not.toContain(' promote ');
    expect(r.rollbacks).toBe(0);
  }, 20_000);
});
