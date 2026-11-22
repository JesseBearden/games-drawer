/**
 * Staging's turn in the pipeline (infra/lib/stack.ts): deploy.sh runs it before a release replaces
 * what's on staging, in the pipeline or by hand.
 *
 *   npx tsx deploy/pipeline.ts turn <release>
 *
 * Going live and updating staging both launch a box and remove the one being tried, so they can't
 * overlap: while a release is going live, this waits. And an approval is for what's on staging:
 * if one is still waiting, this closes it, so that nobody approves one release while looking at
 * another (the release replacing it asks again, once it's on staging).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pipeline's names, which stack.ts builds it with. */
export const PIPELINE = { name: 'games-drawer', production: 'Production', approve: 'Approve' } as const;

const POLL_MS = 15_000;
/** Going live takes about 25 minutes, and its build stops at 60. */
export const MAX_WAIT_MS = 65 * 60_000;

/** What the Production stage is doing. */
export type Production = { doing: 'nothing' } | { doing: 'waiting for approval'; token: string } | { doing: 'going live' };

interface Latest {
  status?: string;
  token?: string;
}

export interface PipelineState {
  stageStates?: { stageName?: string; latestExecution?: Latest; actionStates?: { actionName?: string; latestExecution?: Latest }[] }[];
}

/** Read `aws codepipeline get-pipeline-state`. */
export function productionOf(state: PipelineState): Production {
  const stage = state.stageStates?.find((s) => s.stageName === PIPELINE.production);
  if (!stage) throw new Error(`The pipeline has no ${PIPELINE.production} stage.`);
  const status = stage.latestExecution?.status;
  if (status !== 'InProgress' && status !== 'Stopping') return { doing: 'nothing' };
  const approval = stage.actionStates?.find((a) => a.actionName === PIPELINE.approve)?.latestExecution;
  if (approval?.status === 'InProgress' && approval.token) return { doing: 'waiting for approval', token: approval.token };
  // Approved and deploying, or between the two (which counts: better to wait than to cross).
  return { doing: 'going live' };
}

/** Everything that talks to AWS, so tests can swap it out. */
export interface PipelineCloud {
  /** Null if there's no pipeline. */
  production(): Production | null;
  /** False if it was too late: someone had answered it. */
  closeApproval(token: string, why: string): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(msg: string): void;
}

export async function takeTurn(cloud: PipelineCloud, release: string) {
  const started = cloud.now();
  let said = false;
  for (;;) {
    const p = cloud.production();
    if (!p || p.doing === 'nothing') return;
    if (cloud.now() - started > MAX_WAIT_MS) throw new Error('The pipeline never finished going live, so staging was left as it is. Look at it in CodePipeline, then retry.');
    if (p.doing === 'waiting for approval') {
      const closed = cloud.closeApproval(p.token, `Staging is moving on to ${release.slice(0, 7)}, which will ask for its own approval.`);
      cloud.log(closed ? 'Closed the older release’s approval request: staging is moving on.' : 'The older release was answered just now.');
    } else if (!said) {
      said = true;
      cloud.log('A release is going live: staging waits until it has finished (up to about 25 minutes).');
    }
    await cloud.sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------- AWS, through the AWS CLI

function aws(args: string[]): unknown {
  try {
    const out = execFileSync('aws', ['codepipeline', ...args, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    throw new Error(String((err as { stderr?: string }).stderr || err).trim(), { cause: err });
  }
}

/** The result, or null for the errors named; any other error stops the deploy. */
function unless(errors: RegExp, args: string[]): { value: unknown } | null {
  try {
    return { value: aws(args) };
  } catch (err) {
    if (errors.test(String(err))) return null;
    throw err;
  }
}

export const awsPipeline = (): PipelineCloud => ({
  production() {
    const state = unless(/PipelineNotFoundException/, ['get-pipeline-state', '--name', PIPELINE.name]);
    return state && productionOf(state.value as PipelineState);
  },
  closeApproval(token, why) {
    return !!unless(/ApprovalAlreadyCompletedException|InvalidApprovalTokenException/, [
      'put-approval-result',
      '--pipeline-name',
      PIPELINE.name,
      '--stage-name',
      PIPELINE.production,
      '--action-name',
      PIPELINE.approve,
      '--token',
      token,
      '--result',
      JSON.stringify({ summary: why, status: 'Rejected' }),
    ]);
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  log: (msg) => console.log(msg),
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, release] = process.argv.slice(2);
  if (cmd !== 'turn' || !/^[0-9a-f]{7,40}$/.test(release ?? '')) {
    console.error('usage: pipeline.ts turn <release>');
    process.exitCode = 2;
  } else {
    takeTurn(awsPipeline(), release).catch((err) => {
      console.error(String(err instanceof Error ? err.message : err));
      process.exitCode = 1;
    });
  }
}
