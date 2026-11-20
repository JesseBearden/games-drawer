/**
 * The AWS side of Games Drawer. See infra/README.md.
 *
 *   npm run infra -- deploy GamesDrawerDns --profile games-drawer       (once, first)
 *   npm run infra -- deploy GamesDrawerGitHub --profile games-drawer    (once; then approve it)
 *   ALERT_EMAIL=you@example.com npm run infra -- deploy GamesDrawer --profile games-drawer
 *
 * Three stacks, all in the region from config.json. The first two each need you once, so they
 * come first, on their own: the domain's DNS zone (the registrar must point the domain at it
 * before the certificate can be issued) and the link to GitHub (approved on GitHub before the
 * deploy project can watch the repo). Then everything else. The account's organization keeps stacks to that region; the front door's
 * certificate, which CloudFront needs in us-east-1, is requested there from the main stack.
 * The domain comes from config.json; SITE_DOMAIN overrides it (e.g. for a test stack).
 */
import * as cdk from 'aws-cdk-lib';
import config from '../config.json' with { type: 'json' };
import { GamesDrawerDnsStack } from '../lib/edge';
import { GamesDrawerGitHubStack } from '../lib/github';
import { GamesDrawerStack } from '../lib/stack';

const app = new cdk.App();
const domain = process.env.SITE_DOMAIN || config.domain;
// Never committed: the repository is public. Only the main stack needs it (budget alerts).
const alertEmail = process.env.ALERT_EMAIL || undefined;
if (!domain) throw new Error('Set SITE_DOMAIN (or "domain" in infra/config.json). See infra/README.md.');

// Account-agnostic on purpose: nothing about the account ends up in the (public) repo.
const env = { region: config.region };
const dns = new GamesDrawerDnsStack(app, 'GamesDrawerDns', { env, description: 'Games Drawer: the domain’s DNS zone', domain });
const github = new GamesDrawerGitHubStack(app, 'GamesDrawerGitHub', { env, description: 'Games Drawer: the link to the GitHub repo that deploys read from' });

if (alertEmail) {
  new GamesDrawerStack(app, 'GamesDrawer', {
    env,
    description: 'Games Drawer: the front door, the game server boxes, what outlives them, deploy access and spending guardrails',
    domain,
    zone: dns.zone,
    alertEmail,
    githubRepo: config.githubRepo,
    githubConnectionArn: github.connectionArn,
    deployRoleArn: github.deployRoleArn,
    monthlyBudgetUsd: config.monthlyBudgetUsd,
    killSwitchUsd: config.killSwitchUsd,
    instanceType: config.instanceType,
    frontDoor: config.frontDoor === 'direct' ? 'direct' : 'cloudfront',
    amiId: config.amiId ?? undefined,
    anomalyAlerts: config.anomalyAlerts,
  });
} else {
  console.warn('ALERT_EMAIL is not set: only the GamesDrawerDns and GamesDrawerGitHub stacks are available. See infra/README.md.');
}
