/**
 * The fleet tool: runs a deploy across game server boxes. deploy.sh runs it (in CodeBuild, with
 * the deploy project's role), and so can you, from the repo, with the games-drawer AWS profile:
 *
 *   npx tsx deploy/fleet.ts launch <release>             a new box with this release (staging shows it)
 *   npx tsx deploy/fleet.ts canary <release> <percent>   send it that share of new tables
 *   npx tsx deploy/fleet.ts check <release>              is it healthy? (exit 1 if not)
 *   npx tsx deploy/fleet.ts promote <release>            it takes every new table and the front
 *                                                        door; the old box finishes its games and
 *                                                        shuts down
 *   npx tsx deploy/fleet.ts rollback <release>           remove the new box; the current one keeps everything
 *   npx tsx deploy/fleet.ts status                       the live boxes, and where the front door points
 *
 * Needs AWS_REGION, SITE_DOMAIN and LAUNCH_TEMPLATE (the stack's LaunchTemplateName output) in
 * the environment, and FRONT_DOOR (cloudfront, the default, or direct); the deploy project sets
 * them all. Needs the AWS CLI too. Boxes are EC2 instances tagged project=games-drawer; their
 * gd:role tag says what each one is doing:
 *   candidate  the new release, on trial (staging, then maybe a canary share of new tables)
 *   current    takes new tables; the front door points at it: CloudFront's origin
 *              (origin.<domain>), or with FRONT_DOOR=direct the domain and www themselves (and
 *              staging.<domain> then points at the newest box)
 *   retiring   finishing its games, then it shuts itself down (and AWS terminates it)
 * See deploy/README.md.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLOTS, type FleetMap, type Slot } from './fleetMap';

export type Role = 'candidate' | 'current' | 'retiring';

export interface Box {
  id: string;
  slot: Slot;
  release: string;
  role: Role;
  privateIp: string;
  publicIp: string;
  launchedAt: string;
}

/** Minutes a retired box keeps passing players on before it may shut down (the front door's DNS settles well within this). */
export const RETIRE_GRACE_MINUTES = 15;

/**
 * What players come in through. cloudfront: CloudFront, which follows origin.<domain> to the
 * current box. direct (while CloudFront isn't available to the account): the domain's own DNS
 * records point at the boxes, and Caddy on each box does HTTPS (deploy/Caddyfile.direct).
 */
export type FrontDoor = 'cloudfront' | 'direct';

export function isFrontDoor(v: unknown): v is FrontDoor {
  return v === 'cloudfront' || v === 'direct';
}

/** A slot no live box uses; if all are taken, the oldest retiring box gives up its own. */
export function chooseSlot(boxes: Box[]): { slot: Slot; evict: Box | null } {
  const used = new Set(boxes.map((b) => b.slot));
  const free = SLOTS.find((s) => !used.has(s));
  if (free) return { slot: free, evict: null };
  const oldest = boxes.filter((b) => b.role === 'retiring').sort((a, b) => a.launchedAt.localeCompare(b.launchedAt))[0];
  if (!oldest) throw new Error('Every slot is taken and no box is retiring.');
  return { slot: oldest.slot, evict: oldest };
}

/** The map every box routes by. */
export function fleetMap(boxes: Box[], newTables: [Slot, number][], staging: Slot | null): FleetMap {
  const map: FleetMap = { boxes: {}, newTables, staging };
  for (const b of boxes) map.boxes[b.slot] = b.privateIp;
  return map;
}

/** The box taking new tables now (the newest, if somehow there are two). */
export function currentBox(boxes: Box[]): Box | null {
  return boxes.filter((b) => b.role === 'current').sort((a, b) => b.launchedAt.localeCompare(a.launchedAt))[0] ?? null;
}

export function candidateBox(boxes: Box[], release: string): Box {
  const c = boxes.find((b) => b.role === 'candidate' && b.release === release);
  if (!c) throw new Error(`No new box with release ${release.slice(0, 7)} (run launch first).`);
  return c;
}

const encode = (map: FleetMap) => Buffer.from(JSON.stringify(map)).toString('base64');

// ---------------------------------------------------------------- side effects

/** Everything that talks to AWS, so tests can swap it out. */
export interface Cloud {
  /** Live boxes (pending or running). */
  boxes(): Box[];
  /** Launch a box from the launch template; returns once it runs and Systems Manager can reach it. */
  launch(release: string, slot: Slot): Promise<Box>;
  /** Run a shell command on a box through Systems Manager; throws if it fails. */
  run(box: Box, command: string): Promise<string>;
  setRole(box: Box, role: Role): void;
  terminate(box: Box): void;
  /** Point DNS names (A records in the domain's zone) at a box's public address. */
  pointAt(names: string[], ip: string): Promise<void>;
  /** Where a DNS name in the zone points, or null. */
  pointsTo(name: string): string | null;
  /** Wait until https://staging.<domain> answers with this release (the box is up, and so is its HTTPS). */
  waitForStaging(release: string): Promise<void>;
  log(msg: string): void;
}

export class Fleet {
  constructor(
    private cloud: Cloud,
    private opts: { domain: string; frontDoor: FrontDoor },
  ) {}

  /** The names that follow the box taking players. */
  frontNames(): string[] {
    const d = this.opts.domain;
    return this.opts.frontDoor === 'direct' ? [d, `www.${d}`, `origin.${d}`] : [`origin.${d}`];
  }

  /** The names that follow the newest box (behind CloudFront, staging comes through the front door instead). */
  stagingNames(): string[] {
    return this.opts.frontDoor === 'direct' ? [`staging.${this.opts.domain}`] : [];
  }

  /**
   * Before removing new boxes: if the site's own names point at one of them (a promote that moved
   * DNS but stopped before marking the box current), point them back at the current box first, so
   * removing it can't take the site down. (With no current box, as on the very first deploy,
   * there's nothing to fall back on, and nothing more to lose.)
   */
  private async keepFrontDoorOff(doomed: Box[], current: Box | null) {
    const ips = new Set(doomed.map((b) => b.publicIp).filter(Boolean));
    const stuck = this.frontNames().filter((n) => {
      const ip = this.cloud.pointsTo(n);
      return ip !== null && ips.has(ip);
    });
    if (!stuck.length || !current) return;
    this.cloud.log(`${stuck.join(', ')} point at a new box (an unfinished promote?): moving them back to box ${current.slot} first.`);
    await this.cloud.pointAt(this.frontNames(), current.publicIp);
  }

  /**
   * Tell every live box the map. A retiring box that has shut down or won't answer is noted and
   * passed over: it's on its way out, and mustn't stop a deploy or a rollback.
   */
  private async route(boxes: Box[], map: FleetMap) {
    for (const b of boxes) {
      try {
        this.cloud.log((await this.cloud.run(b, `games-drawer-deploy ${b.release} route ${encode(map)}`)).trim());
      } catch (err) {
        if (b.role !== 'retiring') throw err;
        this.cloud.log(`Couldn't give retiring box ${b.slot} the new routes (${err instanceof Error ? err.message : err}); carrying on.`);
      }
    }
  }

  async launch(release: string): Promise<Box> {
    let boxes = this.cloud.boxes();
    // A new box left over from a deploy that didn't finish.
    await this.keepFrontDoorOff(
      boxes.filter((x) => x.role === 'candidate'),
      currentBox(boxes),
    );
    for (const b of boxes.filter((x) => x.role === 'candidate')) {
      this.cloud.log(`Removing box ${b.slot} (${b.release.slice(0, 7)}), left from an unfinished deploy.`);
      this.cloud.terminate(b);
    }
    boxes = boxes.filter((b) => b.role !== 'candidate');
    const { slot, evict } = chooseSlot(boxes);
    if (evict) {
      this.cloud.log(`Every slot is taken: box ${evict.slot} (${evict.release.slice(0, 7)}) stops now, ending any games still on it.`);
      this.cloud.terminate(evict);
      boxes = boxes.filter((b) => b !== evict);
    }
    const current = currentBox(boxes);
    this.cloud.log(`Launching box ${slot} with ${release.slice(0, 7)}…`);
    const box = await this.cloud.launch(release, slot);
    // Systems Manager can reach a new box before its first-boot script (which installs the deploy
    // command) has finished: wait for it.
    await this.cloud.run(box, 'cloud-init status --wait >/dev/null 2>&1 || true; test -x /usr/local/bin/games-drawer-deploy');
    this.cloud.log((await this.cloud.run(box, `games-drawer-deploy ${release} start ${slot} ${current?.release ?? 'none'}`)).trim());
    // Booting takes minutes, and a retiring box may have finished and shut itself down meanwhile.
    const live = new Set(this.cloud.boxes().map((b) => b.id));
    const all = [...boxes.filter((b) => b.role !== 'retiring' || live.has(b.id)), box];
    // Staging's own name (direct) points here, and with no box taking players, so does the front
    // door (otherwise not even staging could be reached). Before the routes, so the reload they
    // cause finds the names in place when Caddy asks for certificates (direct).
    const names = [...this.stagingNames(), ...(current ? [] : this.frontNames())];
    if (names.length) await this.cloud.pointAt(names, box.publicIp);
    // Staging shows the new box at once; new tables stay where they were (or come here, on the very first deploy).
    await this.route(all, fleetMap(all, current ? [[current.slot, 100]] : [[slot, 100]], slot));
    await this.cloud.waitForStaging(release);
    this.cloud.log(`CANARY_SLOT=${slot}`);
    return box;
  }

  async canary(release: string, percent: number) {
    const boxes = this.cloud.boxes();
    const candidate = candidateBox(boxes, release);
    const current = currentBox(boxes);
    if (!current) {
      this.cloud.log('No current box: the new box already takes every new table.');
      return;
    }
    const pct = Math.max(1, Math.min(99, Math.round(percent)));
    // Pages from either box load build files through whichever box a request reaches.
    this.cloud.log((await this.cloud.run(current, `games-drawer-deploy ${release} share ${current.release}`)).trim());
    await this.route(boxes, fleetMap(boxes, [[current.slot, 100 - pct], [candidate.slot, pct]], candidate.slot));
  }

  async check(release: string): Promise<boolean> {
    const candidate = candidateBox(this.cloud.boxes(), release);
    try {
      this.cloud.log((await this.cloud.run(candidate, `games-drawer-deploy ${release} check`)).trim());
      return true;
    } catch (err) {
      this.cloud.log(String(err instanceof Error ? err.message : err));
      return false;
    }
  }

  async promote(release: string) {
    const boxes = this.cloud.boxes();
    const candidate = candidateBox(boxes, release);
    const current = currentBox(boxes);
    await this.route(boxes, fleetMap(boxes, [[candidate.slot, 100]], candidate.slot));
    await this.cloud.pointAt(this.frontNames(), candidate.publicIp);
    this.cloud.setRole(candidate, 'current');
    this.cloud.log(`Box ${candidate.slot} (${release.slice(0, 7)}) now takes every new table, and the front door points at it.`);
    if (current) {
      this.cloud.setRole(current, 'retiring');
      this.cloud.log((await this.cloud.run(current, `games-drawer-deploy ${current.release} retire ${RETIRE_GRACE_MINUTES}`)).trim());
    }
  }

  async rollback(release: string) {
    const boxes = this.cloud.boxes();
    const candidate = boxes.find((b) => b.role === 'candidate' && b.release === release);
    const rest = boxes.filter((b) => b !== candidate);
    const current = currentBox(rest);
    try {
      if (current) {
        await this.route(rest, fleetMap(rest, [[current.slot, 100]], current.slot));
        if (this.stagingNames().length) await this.cloud.pointAt(this.stagingNames(), current.publicIp);
      }
    } finally {
      // Whatever else failed, the new box goes (never while the site's names still point at it:
      // if that can't be checked or moved, this throws before removing it).
      if (candidate) {
        await this.keepFrontDoorOff([candidate], current);
        this.cloud.terminate(candidate);
        this.cloud.log(`Rolled back: box ${candidate.slot} (${release.slice(0, 7)}) removed${current ? `; box ${current.slot} keeps everything` : ''}.`);
      } else this.cloud.log('No new box to roll back.');
    }
  }

  status() {
    const boxes = this.cloud.boxes().sort((a, b) => a.launchedAt.localeCompare(b.launchedAt));
    if (!boxes.length) this.cloud.log('No boxes running.');
    for (const b of boxes) this.cloud.log(`${b.slot}  ${b.role.padEnd(9)} ${b.release.slice(0, 7)}  ${b.id}  ${b.publicIp || '-'} / ${b.privateIp || '-'}  since ${b.launchedAt}`);
    for (const name of [...this.frontNames(), ...this.stagingNames()]) {
      let to: string | null;
      try {
        to = this.cloud.pointsTo(name) ?? 'not set';
      } catch {
        to = "couldn't look it up";
      }
      this.cloud.log(`${name} → ${to}`);
    }
  }
}

// ---------------------------------------------------------------- AWS, through the AWS CLI

// UTF-8 output: on Windows the AWS CLI otherwise can't print what a box says (it uses → and …).
const awsEnv = { ...process.env, PYTHONUTF8: '1' };

function aws(args: string[]): unknown {
  const out = execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: awsEnv });
  return out.trim() ? JSON.parse(out) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Tagged = { Key: string; Value: string }[] | undefined;
const tag = (tags: Tagged, key: string) => tags?.find((t) => t.Key === key)?.Value ?? '';

export function awsCloud(env: NodeJS.ProcessEnv = process.env): Cloud {
  const domain = env.SITE_DOMAIN;
  const template = env.LAUNCH_TEMPLATE;
  if (!domain || !template || !env.AWS_REGION) throw new Error('Set AWS_REGION, SITE_DOMAIN and LAUNCH_TEMPLATE (see infra/README.md).');
  let zoneId: string | null = null;
  const zone = () => {
    if (zoneId) return zoneId;
    const res = aws(['route53', 'list-hosted-zones-by-name', '--dns-name', domain, '--max-items', '1']) as { HostedZones: { Id: string; Name: string }[] };
    const z = res.HostedZones.find((h) => h.Name === `${domain}.`);
    if (!z) throw new Error(`No Route 53 hosted zone for ${domain}.`);
    return (zoneId = z.Id.replace('/hostedzone/', ''));
  };
  const toBox = (i: { InstanceId: string; PrivateIpAddress?: string; PublicIpAddress?: string; LaunchTime: string; Tags?: Tagged }): Box => ({
    id: i.InstanceId,
    slot: tag(i.Tags, 'gd:slot') as Slot,
    release: tag(i.Tags, 'gd:release'),
    role: tag(i.Tags, 'gd:role') as Role,
    privateIp: i.PrivateIpAddress ?? '',
    publicIp: i.PublicIpAddress ?? '',
    launchedAt: i.LaunchTime,
  });
  const describe = (filters: string[]) => {
    const res = aws(['ec2', 'describe-instances', '--filters', ...filters]) as { Reservations: { Instances: Parameters<typeof toBox>[0][] }[] };
    return res.Reservations.flatMap((r) => r.Instances).map(toBox);
  };
  const cloud: Cloud = {
    boxes: () =>
      describe(['Name=tag:project,Values=games-drawer', 'Name=instance-state-name,Values=pending,running', 'Name=tag-key,Values=gd:role']).filter((b) =>
        (SLOTS as readonly string[]).includes(b.slot),
      ),
    async launch(release, slot) {
      const tags = [
        { Key: 'project', Value: 'games-drawer' },
        { Key: 'Name', Value: `games-drawer-${slot}-${release.slice(0, 7)}` },
        { Key: 'gd:slot', Value: slot },
        { Key: 'gd:release', Value: release },
        { Key: 'gd:role', Value: 'candidate' },
      ];
      const res = aws([
        'ec2',
        'run-instances',
        '--launch-template',
        `LaunchTemplateName=${template},Version=$Latest`,
        '--tag-specifications',
        JSON.stringify([
          { ResourceType: 'instance', Tags: tags },
          { ResourceType: 'volume', Tags: tags.slice(0, 2) },
        ]),
      ]) as { Instances: { InstanceId: string }[] };
      const id = res.Instances[0].InstanceId;
      this.log(`Started ${id}; waiting for it to boot…`);
      execFileSync('aws', ['ec2', 'wait', 'instance-running', '--instance-ids', id], { stdio: 'inherit', env: awsEnv });
      for (let i = 0; i < 72; i++) {
        const info = aws(['ssm', 'describe-instance-information', '--filters', `Key=InstanceIds,Values=${id}`]) as { InstanceInformationList: { PingStatus: string }[] };
        if (info.InstanceInformationList[0]?.PingStatus === 'Online') return describe([`Name=instance-id,Values=${id}`])[0];
        await sleep(5000);
      }
      throw new Error(`Box ${id} never came online in Systems Manager.`);
    },
    async run(box, command) {
      const params = JSON.stringify({ commands: [command], executionTimeout: ['1800'] });
      const sent = aws(['ssm', 'send-command', '--instance-ids', box.id, '--document-name', 'AWS-RunShellScript', '--comment', 'games-drawer deploy', '--parameters', params]) as {
        Command: { CommandId: string };
      };
      const id = sent.Command.CommandId;
      for (let i = 0; i < 400; i++) {
        await sleep(3000);
        let inv: { Status: string; StandardOutputContent: string; StandardErrorContent: string };
        try {
          inv = aws(['ssm', 'get-command-invocation', '--command-id', id, '--instance-id', box.id]) as typeof inv;
        } catch {
          continue; // not registered yet
        }
        if (['Pending', 'InProgress', 'Delayed'].includes(inv.Status)) continue;
        if (inv.Status !== 'Success') throw new Error(`On box ${box.slot}: ${command.split(' ').slice(0, 3).join(' ')} … ended ${inv.Status}.\n${inv.StandardOutputContent}\n${inv.StandardErrorContent}`.trim());
        return inv.StandardOutputContent;
      }
      throw new Error(`On box ${box.slot}: timed out waiting for ${command}.`);
    },
    setRole(box, role) {
      aws(['ec2', 'create-tags', '--resources', box.id, '--tags', `Key=gd:role,Value=${role}`]);
    },
    terminate(box) {
      aws(['ec2', 'terminate-instances', '--instance-ids', box.id]);
    },
    async pointAt(names, ip) {
      // A one-minute TTL, so a new box takes over within a minute or two.
      const batch = { Changes: names.map((Name) => ({ Action: 'UPSERT', ResourceRecordSet: { Name, Type: 'A', TTL: 60, ResourceRecords: [{ Value: ip }] } })) };
      const res = aws(['route53', 'change-resource-record-sets', '--hosted-zone-id', zone(), '--change-batch', JSON.stringify(batch)]) as { ChangeInfo: { Id: string } };
      execFileSync('aws', ['route53', 'wait', 'resource-record-sets-changed', '--id', res.ChangeInfo.Id], { stdio: 'inherit', env: awsEnv });
      this.log(`${names.join(', ')} → ${ip}`);
    },
    // A failed lookup throws: "couldn't find out" must never read as "points nowhere", or the
    // guard that keeps the box the site points at would let it be removed.
    pointsTo(name) {
      const res = aws(['route53', 'list-resource-record-sets', '--hosted-zone-id', zone(), '--start-record-name', name, '--start-record-type', 'A', '--max-items', '1']) as {
        ResourceRecordSets: { Name: string; ResourceRecords?: { Value: string }[]; AliasTarget?: { DNSName: string } }[];
      };
      const r = res.ResourceRecordSets.find((s) => s.Name === `${name}.`);
      return r?.ResourceRecords?.[0]?.Value ?? r?.AliasTarget?.DNSName ?? null;
    },
    async waitForStaging(release) {
      const url = `https://staging.${domain}/healthz`;
      this.log(`Waiting for ${url} to answer with ${release.slice(0, 7)}…`);
      // Up to 15 minutes: a brand-new site's first HTTPS certificate can take a few.
      for (let i = 0; i < 90; i++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
          if (res.ok && ((await res.json()) as { release?: string }).release === release) return;
        } catch {
          /* not yet */
        }
        await sleep(10_000);
      }
      throw new Error(`${url} never answered with ${release.slice(0, 7)}.`);
    },
    log: (msg) => console.log(msg),
  };
  return cloud;
}

/** infra/config.json: what the site's infrastructure was built with (the CDK app reads it too). */
function readSiteConfig(): SiteConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

export interface SiteConfig {
  domain?: string;
  frontDoor?: string;
}

/**
 * The domain and front door to deploy with: infra/config.json's, which the environment may repeat
 * but never contradict. A hand deploy that forgot FRONT_DOOR=direct used to mean "cloudfront", and
 * promoting would then have moved only origin.<domain>, leaving the site on a box about to retire.
 */
export function siteSettings(env: NodeJS.ProcessEnv, config: SiteConfig): { domain: string; frontDoor: FrontDoor } {
  const pick = (name: string, fromEnv: string | undefined, fromConfig: string | undefined) => {
    if (fromEnv && fromConfig && fromEnv !== fromConfig) {
      throw new Error(`${name}=${fromEnv}, but infra/config.json says ${fromConfig}. Fix whichever is wrong before deploying.`);
    }
    const v = fromEnv || fromConfig;
    if (!v) throw new Error(`Set ${name} (or fill it in infra/config.json).`);
    return v;
  };
  const domain = pick('SITE_DOMAIN', env.SITE_DOMAIN, config.domain);
  const frontDoor = pick('FRONT_DOOR', env.FRONT_DOOR, config.frontDoor);
  if (!isFrontDoor(frontDoor)) throw new Error('FRONT_DOOR must be cloudfront or direct.');
  return { domain, frontDoor };
}

async function main() {
  const [cmd, release, arg] = process.argv.slice(2);
  const needRelease = () => {
    if (!release || !/^[0-9a-f]{7,40}$/.test(release)) throw new Error('Give the release (a git commit).');
    return release;
  };
  const { domain, frontDoor } = siteSettings(process.env, readSiteConfig());
  const fleet = new Fleet(awsCloud(), { domain, frontDoor });
  switch (cmd) {
    case 'launch':
      await fleet.launch(needRelease());
      return;
    case 'canary':
      return fleet.canary(needRelease(), Number(arg ?? 10));
    case 'check':
      if (!(await fleet.check(needRelease()))) process.exitCode = 1;
      return;
    case 'promote':
      return fleet.promote(needRelease());
    case 'rollback':
      return fleet.rollback(needRelease());
    case 'status':
      return fleet.status();
    default:
      console.error('usage: fleet.ts launch|canary|check|promote|rollback <release> [percent] | status');
      process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  });
}
