// Runs the real deploy.sh, with pretend npx and sleep in front of it, and fails each step in turn.
// (A failed step inside a shell function never reached the script's ERR trap, so a failed check
// used to leave the new box up with its share of new tables. Reading the script didn't show it.)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** On Windows, Git's bash: a plain "bash" can be WSL's, which may not be installed. */
function findBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const git = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(); // <Git>/mingw64/libexec/git-core
  return path.resolve(git, '../../../bin/bash.exe');
}

const script = fileURLToPath(new URL('./deploy.sh', import.meta.url)).replaceAll('\\', '/');
const release = 'c0ffee0000000000000000000000000000000000';
let bash = '';
let dir = '';

beforeAll(() => {
  bash = findBash();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-deploy-'));
  const fake = (name: string, lines: string[]) => fs.writeFileSync(path.join(dir, name), ['#!/usr/bin/env bash', ...lines, ''].join('\n'), { mode: 0o755 });
  fake('npx', [
    'echo "$*" >> "$CALLS"',
    'if [[ "$*" == *"fleet.ts launch"* ]]; then echo "Started i-1; waiting for it to boot"; fi',
    'if [ -n "$FAIL" ] && [[ "$*" == *"$FAIL"* ]]; then exit 1; fi',
    'if [ -n "$KILL_AT" ] && [[ "$*" == *"$KILL_AT"* ]]; then kill -"$SIGNAL" "$PPID"; exit 0; fi',
    'if [[ "$*" == *"fleet.ts launch"* ]]; then echo CANARY_SLOT=b; fi',
    'exit 0',
  ]);
  fake('sleep', ['exit 0']);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function deploy(env: Record<string, string>) {
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(calls, '');
  // Windows may spell it Path; two spellings in one environment would hide the pretend npx.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|go_live)$/i.test(k)));
  const res = spawnSync(bash, ['-c', 'export PATH="$(cd "$FAKES" && pwd):$PATH"; exec bash "$0" "$1"', script, release], {
    encoding: 'utf8',
    env: {
      ...base,
      PATH: process.env.PATH ?? process.env.Path ?? '',
      FAKES: dir.replaceAll('\\', '/'),
      CALLS: calls.replaceAll('\\', '/'),
      AWS_REGION: 'nowhere',
      SITE_DOMAIN: 'games.invalid',
      LAUNCH_TEMPLATE: 'none',
      CANARY_MINUTES: '2',
      SKIP_BROWSER_INSTALL: '1',
      FAIL: '',
      KILL_AT: '',
      SIGNAL: 'TERM',
      ...env,
    },
  });
  const ran = fs.readFileSync(calls, 'utf8');
  return { code: res.status, out: res.stdout, rollbacks: ran.split('fleet.ts rollback').length - 1, ran };
}

describe('deploy.sh', { timeout: 120_000 }, () => {
  it('staging: puts it there and changes nothing on the site', () => {
    const r = deploy({});
    expect(r.code, r.ran).toBe(0);
    expect(r.rollbacks).toBe(0);
    expect(r.ran).not.toMatch(/fleet\.ts (canary|promote)/);
  });

  it('going live: canary, checks, promote', () => {
    const r = deploy({ GO_LIVE: '1' });
    expect(r.code, r.ran).toBe(0);
    expect(r.rollbacks).toBe(0);
    expect(r.ran).toMatch(/on-staging[\s\S]*launch[\s\S]*canary[\s\S]*check[\s\S]*check[\s\S]*promote/);
  });

  it('a failed first check touches nothing, not even to roll back', () => {
    for (const env of [{ FAIL: 'pipeline.ts turn' }, { GO_LIVE: '1', FAIL: 'on-staging' }] as Record<string, string>[]) {
      const r = deploy(env);
      expect(r.code, r.ran).not.toBe(0);
      expect(r.ran, r.ran).not.toMatch(/fleet\.ts (launch|rollback)/);
    }
  });

  it.each([
    ['launch', {}, 'fleet.ts launch'],
    ['staging’s smoke tests', {}, 'playwright test'],
    ['launch, going live', { GO_LIVE: '1' }, 'fleet.ts launch'],
    ['canary', { GO_LIVE: '1' }, 'fleet.ts canary'],
    ['health check', { GO_LIVE: '1' }, 'fleet.ts check'],
    ['promote', { GO_LIVE: '1' }, 'fleet.ts promote'],
  ])('a failed %s removes the new box', (_, env, fail) => {
    const r = deploy({ ...env, FAIL: fail });
    expect(r.code, r.ran).not.toBe(0);
    expect(r.rollbacks, r.ran).toBe(1);
  });

  it('a failed launch leaves its log to read', () => {
    expect(deploy({ FAIL: 'fleet.ts launch' }).out).toContain('Started i-1; waiting for it to boot');
  });

  it.each([
    ['INT', 130],
    ['TERM', 143],
  ])('stopped with %s, it removes the new box', (SIGNAL, status) => {
    for (const env of [{ GO_LIVE: '1', KILL_AT: 'fleet.ts canary' }, { KILL_AT: 'playwright test' }] as Record<string, string>[]) {
      const r = deploy({ ...env, SIGNAL });
      expect(r.out).toContain('The deploy was stopped.');
      expect(r.code, r.ran).toBe(status);
      expect(r.rollbacks, r.ran).toBe(1);
      expect(r.ran).not.toContain('promote');
    }
  });
});
