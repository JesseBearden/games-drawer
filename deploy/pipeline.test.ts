import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_WAIT_MS, productionOf, takeTurn, type PipelineCloud, type PipelineState, type Production } from './pipeline';

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** A pretend pipeline whose Production stage goes through `states`, one a look. */
function fake(states: (Production | null)[], canClose = true) {
  let at = 0;
  let now = 0;
  const closed: { token: string; why: string }[] = [];
  const cloud: PipelineCloud = {
    production: () => states[Math.min(at++, states.length - 1)],
    closeApproval(token, why) {
      closed.push({ token, why });
      return canClose;
    },
    async sleep(ms) {
      now += ms;
    },
    now: () => now,
    log() {},
  };
  return { cloud, closed, looks: () => at };
}

const nothing: Production = { doing: 'nothing' };
const asking: Production = { doing: 'waiting for approval', token: 't1' };
const live: Production = { doing: 'going live' };

describe('staging’s turn in the pipeline', () => {
  it('goes straight ahead with no pipeline, or nothing going on in it', async () => {
    for (const state of [null, nothing]) {
      const f = fake([state]);
      await takeTurn(f.cloud, 'bbbbbbb2');
      expect(f.looks()).toBe(1);
      expect(f.closed).toEqual([]);
    }
  });

  it('waits while a release goes live', async () => {
    const f = fake([live, live, live, nothing]);
    await takeTurn(f.cloud, 'bbbbbbb2');
    expect(f.looks()).toBe(4);
    expect(f.closed).toEqual([]);
  });

  it('closes an older release’s approval request, then makes sure it closed', async () => {
    const f = fake([asking, nothing]);
    await takeTurn(f.cloud, 'bbbbbbb2');
    expect(f.closed).toEqual([{ token: 't1', why: expect.stringContaining('bbbbbbb') }]);
    expect(f.looks()).toBe(2);
  });

  it('approved just before it could close it: waits for that release to go live', async () => {
    const f = fake([asking, live, live, nothing], false);
    await takeTurn(f.cloud, 'bbbbbbb2');
    expect(f.looks()).toBe(4);
  });

  it('closes the next one too, if another was queued behind it', async () => {
    const f = fake([asking, { doing: 'waiting for approval', token: 't2' }, nothing]);
    await takeTurn(f.cloud, 'bbbbbbb2');
    expect(f.closed.map((c) => c.token)).toEqual(['t1', 't2']);
  });

  it('gives up, rather than cross a go-live that never finishes', async () => {
    const f = fake([live]);
    await expect(takeTurn(f.cloud, 'bbbbbbb2')).rejects.toThrow('left as it is');
    expect(MAX_WAIT_MS).toBeGreaterThan(60 * 60_000); // longer than a go-live build can run
  });

  it('stops if it can’t find out', async () => {
    const f = fake([nothing]);
    f.cloud.production = () => {
      throw new Error('AccessDenied');
    };
    await expect(takeTurn(f.cloud, 'bbbbbbb2')).rejects.toThrow('AccessDenied');
  });
});

describe('reading the pipeline', () => {
  const state = (stage?: string, approve?: string, goLive?: string, token?: string): PipelineState => ({
    stageStates: [
      { stageName: 'Staging', latestExecution: { status: 'InProgress' } },
      {
        stageName: 'Production',
        latestExecution: stage ? { status: stage } : undefined,
        actionStates: [
          { actionName: 'Approve', latestExecution: approve ? { status: approve, token } : undefined },
          { actionName: 'GoLive', latestExecution: goLive ? { status: goLive } : undefined },
        ],
      },
    ],
  });

  it('knows an approval that’s waiting', () => {
    expect(productionOf(state('InProgress', 'InProgress', undefined, 't9'))).toEqual({ doing: 'waiting for approval', token: 't9' });
  });

  it('counts approved, deploying and in between as going live', () => {
    expect(productionOf(state('InProgress', 'Succeeded', 'InProgress'))).toEqual(live);
    // The actions still show the last release's until this one's start.
    expect(productionOf(state('InProgress', 'Succeeded', 'Succeeded'))).toEqual(live);
    expect(productionOf(state('InProgress', 'InProgress'))).toEqual(live); // no token yet
    expect(productionOf(state('Stopping', 'Succeeded', 'InProgress'))).toEqual(live);
  });

  it('knows nothing is going on, whatever happened last', () => {
    for (const s of [undefined, 'Succeeded', 'Failed', 'Stopped', 'Cancelled']) expect(productionOf(state(s, 'Failed', undefined, 'old'))).toEqual(nothing);
  });

  it('never guesses at a pipeline it doesn’t recognise', () => {
    expect(() => productionOf({ stageStates: [] })).toThrow('Production');
  });
});

describe('the build steps', () => {
  const test = read('buildspec.yml');
  const staging = read('buildspec.staging.yml');
  const goLive = read('buildspec.go-live.yml');
  const deploy = read('deploy.sh');
  const steps = (spec: string) => spec.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('tests everything, in an order where the tested build is the one handed on', () => {
    const order = ['npm ci', 'npm run typecheck', 'npm test', 'npm run release -- --tar', 'npx playwright test', 'artifacts:', 'release.tar.gz'];
    let from = 0;
    for (const step of order) {
      const i = test.indexOf(step, from);
      expect(i, step).toBeGreaterThanOrEqual(0);
      from = i + step.length;
    }
    expect(test).not.toMatch(/npx playwright test[^\n]*--grep/); // all of them
  });

  it('never deploys from the step that runs the tests', () => {
    expect(steps(test)).not.toMatch(/deploy\.sh|fleet\.ts|aws /);
  });

  it('deploys only the tested build, and goes live only from the approved step', () => {
    for (const spec of [staging, goLive]) {
      expect(steps(spec)).toContain('$CODEBUILD_SRC_DIR_Release/release.tar.gz');
      expect(steps(spec)).not.toMatch(/npm run release|npm test/);
      // These run with permission to deploy, so no package's install script runs in them.
      expect(steps(spec)).toContain('npm ci --ignore-scripts');
    }
    expect(steps(staging)).not.toContain('GO_LIVE');
    expect(steps(goLive)).toContain('GO_LIVE=1 bash deploy/deploy.sh "$COMMIT"');
  });

  it('checks before it can remove anything: staging’s turn, or that this is what’s on staging', () => {
    for (const step of ['deploy/pipeline.ts turn "$rel"', 'fleet on-staging "$rel"']) {
      const i = deploy.indexOf(step);
      expect(i, step).toBeGreaterThanOrEqual(0);
      // Before the rollback trap too: failing a check mustn't take down what's on staging.
      expect(i, step).toBeLessThan(deploy.indexOf('trap ended EXIT'));
      expect(i, step).toBeLessThan(deploy.indexOf('fleet launch "$rel"'));
    }
  });

  it('means staging unless told to go live', () => {
    expect(deploy).toContain('go_live="${GO_LIVE:-}"');
    expect(deploy.indexOf('exit 0', deploy.indexOf('== Smoke tests against staging'))).toBeLessThan(deploy.indexOf('fleet canary'));
  });
});
