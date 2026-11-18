import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { bootScript, GamesDrawerStack, type GamesDrawerProps } from '../lib/stack';

function synth(over: Partial<GamesDrawerProps> = {}) {
  const app = new cdk.App();
  const stack = new GamesDrawerStack(app, 'Test', {
    env: { region: 'us-east-2' },
    domain: 'games.example.com',
    alertEmail: 'alerts@example.com',
    githubRepo: 'owner/games-drawer',
    monthlyBudgetUsd: 30,
    killSwitchUsd: 75,
    ...over,
  });
  return Template.fromStack(stack);
}

describe('Games Drawer AWS stack', () => {
  const t = synth();

  it('runs one small server that cannot bill extra for CPU', () => {
    t.resourceCountIs('AWS::EC2::Instance', 1);
    t.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.micro', CreditSpecification: { CPUCredits: 'standard' } });
    t.hasResourceProperties('AWS::EC2::LaunchTemplate', { LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } } });
    t.hasResourceProperties('AWS::EC2::Instance', { BlockDeviceMappings: [{ Ebs: { Encrypted: true, VolumeType: 'gp3' } }] });
  });

  it('has none of the pricey extras: no NAT gateway, load balancer or Lambda', () => {
    for (const type of ['AWS::EC2::NatGateway', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::Lambda::Function']) t.resourceCountIs(type, 0);
  });

  it('opens only web and voice-relay ports (no SSH)', () => {
    const groups = t.findResources('AWS::EC2::SecurityGroup');
    const rules = Object.values(groups).flatMap((g) => (g as { Properties: { SecurityGroupIngress?: { FromPort: number; ToPort: number; IpProtocol: string }[] } }).Properties.SecurityGroupIngress ?? []);
    const ports = rules.map((r) => `${r.IpProtocol}:${r.FromPort}-${r.ToPort}`).sort();
    expect(ports).toEqual(['tcp:3478-3478', 'tcp:443-443', 'tcp:80-80', 'udp:3478-3478', 'udp:443-443', 'udp:49152-49352'].sort());
  });

  it('keeps release bundles private', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
  });

  it('emails at 50% and 80% of the monthly budget and when it is forecast to go over', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetName: 'games-drawer-monthly', BudgetLimit: { Amount: 30, Unit: 'USD' } },
      NotificationsWithSubscribers: [
        { Notification: { NotificationType: 'ACTUAL', Threshold: 50 }, Subscribers: [{ Address: 'alerts@example.com' }] },
        { Notification: { NotificationType: 'ACTUAL', Threshold: 80 } },
        { Notification: { NotificationType: 'FORECASTED', Threshold: 100 } },
      ],
    });
  });

  it('stops the server by itself when real spend reaches the kill-switch amount', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', { Budget: { BudgetName: 'games-drawer-kill-switch', BudgetLimit: { Amount: 75 } } });
    t.hasResourceProperties('AWS::Budgets::BudgetsAction', {
      BudgetName: 'games-drawer-kill-switch',
      ApprovalModel: 'AUTOMATIC',
      ActionType: 'RUN_SSM_DOCUMENTS',
      NotificationType: 'ACTUAL',
      ActionThreshold: { Type: 'PERCENTAGE', Value: 100 },
      Definition: { SsmActionDefinition: { Subtype: 'STOP_EC2_INSTANCES', Region: 'us-east-2', InstanceIds: [{ Ref: Match.stringLikeRegexp('Server') }] } },
    });
  });

  it('lets only this repo’s staging and production deploy jobs sign in, and only to deploy', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              StringLike: { 'token.actions.githubusercontent.com:sub': ['repo:owner/games-drawer:environment:staging', 'repo:owner/games-drawer:environment:production'] },
            },
          }),
        ],
      },
      MaxSessionDuration: 3600,
    });
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    // The server may read the admin password hash, and no other parameter.
    expect(policies).toContain('parameter/games-drawer/admin-password-hash');
    // Nothing broad: no wildcard actions anywhere.
    expect(policies).not.toMatch(/"Action":"\*"|"[a-z0-9]+:\*"/);
  });

  it('can reuse an existing GitHub sign-in provider', () => {
    const t2 = synth({ githubOidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com' });
    t2.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    t.resourceCountIs('AWS::IAM::OIDCProvider', 1);
  });

  it('pins the machine image once one is chosen', () => {
    const pinned = synth({ amiId: 'ami-0123456789abcdef0' });
    expect(JSON.stringify(pinned.toJSON())).toContain('ami-0123456789abcdef0');
    expect(JSON.stringify(t.toJSON())).toContain('canonical/ubuntu/server/24.04');
  });

  it('adds cost-spike alerts only when asked', () => {
    t.resourceCountIs('AWS::CE::AnomalyMonitor', 0);
    synth({ anomalyAlerts: true }).resourceCountIs('AWS::CE::AnomalySubscription', 1);
  });
});

describe('first-boot script', () => {
  it('records the domain, bucket and region and installs the deploy command intact', () => {
    const lines = bootScript({ domain: 'games.example.com', bucket: 'bucket-1', region: 'us-east-2' });
    const script = lines.join('\n');
    expect(script).toContain("'games.example.com' 'bucket-1' 'us-east-2' > /etc/games-drawer/deploy.env");
    expect(script).toContain('exec /usr/local/bin/node "$dir/deploy/rollout.mjs"');
    expect(script).not.toContain('\r');
    // The heredoc is quoted, so $variables reach the file unexpanded.
    expect(script).toContain("<<'GAMES_DRAWER_EOF'");
  });
});
