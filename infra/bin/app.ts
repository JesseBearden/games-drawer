/**
 * The AWS side of Games Drawer. See infra/README.md.
 *
 *   ALERT_EMAIL=you@example.com npm run infra -- deploy --profile games-drawer
 *
 * The domain comes from config.json; SITE_DOMAIN overrides it (e.g. for a test stack).
 */
import * as cdk from 'aws-cdk-lib';
import config from '../config.json' with { type: 'json' };
import { GamesDrawerStack } from '../lib/stack';

const app = new cdk.App();
const domain = process.env.SITE_DOMAIN || config.domain;
// Never committed: the repository is public.
const alertEmail = process.env.ALERT_EMAIL || undefined;
if (!domain || !alertEmail) {
  throw new Error('Set SITE_DOMAIN (or "domain" in infra/config.json) and ALERT_EMAIL. See infra/README.md.');
}

new GamesDrawerStack(app, 'GamesDrawer', {
  // Account-agnostic on purpose: nothing about the account ends up in the (public) repo.
  env: { region: config.region },
  description: 'Games Drawer: the game server, its deploy access and spending guardrails',
  domain,
  alertEmail,
  githubRepo: config.githubRepo,
  monthlyBudgetUsd: config.monthlyBudgetUsd,
  killSwitchUsd: config.killSwitchUsd,
  instanceType: config.instanceType,
  amiId: config.amiId ?? undefined,
  githubOidcProviderArn: process.env.GITHUB_OIDC_PROVIDER_ARN,
  anomalyAlerts: config.anomalyAlerts,
});
