import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { GamesDrawerDnsStack } from '../lib/edge';
import { GamesDrawerGitHubStack } from '../lib/github';
import { bootScript, GamesDrawerStack, LAUNCH_TEMPLATE_NAME, type GamesDrawerProps } from '../lib/stack';

function synth(over: Partial<GamesDrawerProps> = {}) {
  const app = new cdk.App();
  const env = { region: 'us-east-2' };
  const dns = new GamesDrawerDnsStack(app, 'Dns', { env, domain: 'games.example.com' });
  const stack = new GamesDrawerStack(app, 'Test', {
    env,
    domain: 'games.example.com',
    zone: dns.zone,
    alertEmail: 'alerts@example.com',
    githubRepo: 'owner/games-drawer',
    githubConnectionArn: 'arn:aws:codeconnections:us-east-2:123456789012:connection/abc',
    monthlyBudgetUsd: 30,
    killSwitchUsd: 75,
    ...over,
  });
  return Template.fromStack(stack);
}

type Ingress = { FromPort: number; ToPort: number; IpProtocol: string; CidrIp?: string; SourcePrefixListId?: unknown; SourceSecurityGroupId?: unknown };

describe('Games Drawer AWS stack (the boxes)', () => {
  const t = synth();

  it('launches boxes from a template: small, unable to bill extra for CPU, and gone once shut down', () => {
    t.resourceCountIs('AWS::EC2::Instance', 0);
    t.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: LAUNCH_TEMPLATE_NAME,
      LaunchTemplateData: {
        InstanceType: 't4g.micro',
        CreditSpecification: { CpuCredits: 'standard' },
        InstanceInitiatedShutdownBehavior: 'terminate',
        MetadataOptions: { HttpTokens: 'required', InstanceMetadataTags: 'enabled' },
        BlockDeviceMappings: [{ Ebs: { Encrypted: true, VolumeType: 'gp3', DeleteOnTermination: true } }],
        NetworkInterfaces: [Match.objectLike({ AssociatePublicIpAddress: true, DeviceIndex: 0 })],
      },
    });
  });

  it('keeps what matters off the boxes: a shared disk that survives them, reachable only from them', () => {
    t.hasResource('AWS::EFS::FileSystem', { DeletionPolicy: 'Retain', Properties: Match.objectLike({ Encrypted: true }) });
    t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { IpProtocol: 'tcp', FromPort: 2049, ToPort: 2049, SourceSecurityGroupId: Match.anyValue() });
  });

  it('has none of the pricey extras: no NAT gateway, load balancer or fixed address', () => {
    for (const type of ['AWS::EC2::NatGateway', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::EC2::EIP']) t.resourceCountIs(type, 0);
  });

  it('opens the voice relay to everyone, web only to CloudFront, port 80 between boxes, and no SSH', () => {
    const groups = Object.values(t.findResources('AWS::EC2::SecurityGroup')) as { Properties: { SecurityGroupIngress?: Ingress[] } }[];
    const inline = groups.flatMap((g) => g.Properties.SecurityGroupIngress ?? []);
    const separate = (Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')) as { Properties: Ingress }[]).map((r) => r.Properties);
    const rules = [...inline, ...separate];
    const open = rules.filter((r) => r.CidrIp === '0.0.0.0/0').map((r) => `${r.IpProtocol}:${r.FromPort}-${r.ToPort}`).sort();
    expect(open).toEqual(['tcp:3478-3478', 'udp:3478-3478', 'udp:49152-49352']);
    expect(rules.some((r) => r.FromPort === 80 && r.SourcePrefixListId)).toBe(true);
    expect(rules.some((r) => r.FromPort === 80 && r.SourceSecurityGroupId)).toBe(true);
    expect(rules.some((r) => r.FromPort === 22 || r.FromPort === 443)).toBe(false);
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

  it('stops every box by itself when real spend reaches the kill-switch amount', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetName: 'games-drawer-kill-switch', BudgetLimit: { Amount: 75 } },
      NotificationsWithSubscribers: [
        {
          Notification: { NotificationType: 'ACTUAL', Threshold: 100 },
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'alerts@example.com' }, { SubscriptionType: 'SNS', Address: { Ref: Match.stringLikeRegexp('KillSwitchTopic') } }],
        },
      ],
    });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'lambda' });
    t.hasResourceProperties('AWS::Lambda::Function', { Description: Match.stringLikeRegexp('kill switch'), Code: { ZipFile: Match.stringLikeRegexp('StopInstancesCommand') } });
    // It can stop only our boxes.
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toMatch(/"ec2:StopInstances","Condition":\{"StringEquals":\{"aws:ResourceTag\/project":"games-drawer"\}\}/);
  });

  it('deploys from inside the account: CodeBuild, on each push to main, reading the repo through the GitHub connection', () => {
    t.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'games-drawer-deploy',
      Source: Match.objectLike({
        Type: 'GITHUB',
        Location: 'https://github.com/owner/games-drawer.git',
        BuildSpec: 'deploy/buildspec.yml',
        Auth: { Type: 'CODECONNECTIONS', Resource: 'arn:aws:codeconnections:us-east-2:123456789012:connection/abc' },
      }),
      Triggers: { Webhook: true, FilterGroups: [[{ Type: 'EVENT', Pattern: 'PUSH' }, { Type: 'HEAD_REF', Pattern: 'refs/heads/main' }]] },
      ConcurrentBuildLimit: 1,
      Environment: Match.objectLike({ ComputeType: 'BUILD_GENERAL1_SMALL' }),
    });
    // Its role belongs to CodeBuild alone: no GitHub sign-in link (the organization doesn't allow one).
    t.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    t.hasResourceProperties('AWS::IAM::Role', {
      Description: Match.stringLikeRegexp('CodeBuild'),
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Action: 'sts:AssumeRole', Principal: { Service: 'codebuild.amazonaws.com' } })] },
    });
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('"codeconnections:UseConnection"');
    // The boxes may read the admin password hash and their shared secrets, and no other parameter.
    expect(policies).toContain('parameter/games-drawer/admin-password-hash');
    expect(policies).toContain('parameter/games-drawer/secrets');
    // Deploys may only move the front door's origin record, and only end our own boxes.
    expect(policies).toContain('"route53:ChangeResourceRecordSetsNormalizedRecordNames":["origin.games.example.com"]');
    expect(policies).toMatch(/"ec2:TerminateInstances"\],"Condition":\{"StringEquals":\{"aws:ResourceTag\/project":"games-drawer"\}\}/);
    // Nothing broad: no wildcard actions anywhere.
    expect(policies).not.toMatch(/"Action":"\*"|"[a-z0-9-]+:\*"/);
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

describe('the front door and the DNS zone', () => {
  const t = synth();

  it('answers for the domain, www and staging over HTTPS, and passes everything to the box uncached', () => {
    // The certificate is asked for in us-east-1 (CloudFront's region) from this stack: the organization allows no stacks there.
    t.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      DomainName: 'games.example.com',
      SubjectAlternativeNames: ['www.games.example.com', 'staging.games.example.com'],
      Region: 'us-east-1',
    });
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['games.example.com', 'www.games.example.com', 'staging.games.example.com'],
        Origins: [Match.objectLike({ DomainName: 'origin.games.example.com', CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'http-only', HTTPPort: 80 }) })],
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          // CachingDisabled, and every header (with CloudFront's) to the box.
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          OriginRequestPolicyId: '33f36d7e-f396-46d9-90e0-52428a34d9dc',
        }),
        CacheBehaviors: [Match.objectLike({ PathPattern: '/assets/*', CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6' })],
      }),
    });
    // The site, www and staging all point at CloudFront (IPv4 and IPv6). origin. is left to deploys.
    t.resourceCountIs('AWS::Route53::RecordSet', 6);
  });

  it('keeps the domain’s DNS zone on its own, even if the stack goes', () => {
    const app = new cdk.App();
    const dns = Template.fromStack(new GamesDrawerDnsStack(app, 'Dns', { env: { region: 'us-east-2' }, domain: 'games.example.com' }));
    dns.hasResource('AWS::Route53::HostedZone', { DeletionPolicy: 'Retain', Properties: { Name: 'games.example.com.' } });
    // It says the domain sends no email, so forged mail "from" it is rejected.
    dns.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'TXT', Name: 'games.example.com.', ResourceRecords: ['"v=spf1 -all"'] });
    dns.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'TXT', Name: '_dmarc.games.example.com.', ResourceRecords: ['"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s"'] });
    dns.resourceCountIs('AWS::Route53::RecordSet', 3);
  });
});

describe('the link to GitHub', () => {
  it('is a GitHub connection on its own, waiting to be approved', () => {
    const app = new cdk.App();
    const t = Template.fromStack(new GamesDrawerGitHubStack(app, 'GitHub', { env: { region: 'us-east-2' } }));
    t.hasResourceProperties('AWS::CodeConnections::Connection', { ConnectionName: 'games-drawer-github', ProviderType: 'GitHub' });
  });
});

describe('first-boot script', () => {
  it('records the domain, bucket, region and shared disk, and installs the deploy command intact', () => {
    const lines = bootScript({ domain: 'games.example.com', bucket: 'bucket-1', region: 'us-east-2', fileSystem: 'fs-123' });
    const script = lines.join('\n');
    expect(script).toContain("'games.example.com' 'bucket-1' 'us-east-2' 'fs-123' > /etc/games-drawer/deploy.env");
    expect(script).toContain('exec /usr/local/bin/node "$dir/deploy/rollout.mjs"');
    expect(script).not.toContain('\r');
    // The heredoc is quoted, so $variables reach the file unexpanded.
    expect(script).toContain("<<'GAMES_DRAWER_EOF'");
  });
});
