import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Canonical's current Ubuntu 24.04 image for ARM (Graviton) machines. */
export const UBUNTU_AMI_PARAMETER = '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id';

export interface GamesDrawerProps extends cdk.StackProps {
  /** The site's domain; staging lives at staging.<domain>. */
  domain: string;
  /** Where budget alerts go. Passed in at deploy time, never committed (the repo is public). */
  alertEmail: string;
  /** owner/name of the GitHub repository allowed to deploy. */
  githubRepo: string;
  /** Email alerts at 50% and 80% of this, and when the month is forecast to go over. */
  monthlyBudgetUsd: number;
  /** At this much actual spend in a month, AWS stops the game server by itself. */
  killSwitchUsd: number;
  instanceType?: string;
  /**
   * The machine image. Pin it after the first deploy (see infra/README.md): an unpinned image
   * follows Ubuntu's latest, and a new image replaces the machine.
   */
  amiId?: string;
  /** An account can hold only one GitHub sign-in provider; reuse it if one exists. */
  githubOidcProviderArn?: string;
  /** Extra cost-spike alerts. New AWS accounts usually have AWS's own default monitor already. */
  anomalyAlerts?: boolean;
}

/**
 * Everything Games Drawer runs on in AWS: one small server, its address and firewall, a bucket
 * for release bundles, the role GitHub Actions deploys with, and the spending guardrails.
 * Deliberately no load balancer, NAT gateway or Lambda functions: they cost more than the server.
 */
export class GamesDrawerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GamesDrawerProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('project', 'games-drawer');

    // ------------------------------------------------------------ network
    // One public subnet, no NAT gateway (that alone would cost more than the server).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      restrictDefaultSecurityGroup: false,
    });

    const firewall = new ec2.SecurityGroup(this, 'Firewall', { vpc, description: 'Games Drawer: web and voice relay only', allowAllOutbound: true });
    firewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (certificate checks, redirect to HTTPS)');
    firewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS and game WebSockets');
    firewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(443), 'HTTP/3');
    firewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3478), 'Voice relay (TURN over TCP)');
    firewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(3478), 'Voice relay (TURN over UDP)');
    firewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udpRange(49152, 49352), 'Relayed voice audio');
    // No SSH: shell access and deploys go through AWS Systems Manager.

    // ------------------------------------------------------------ release bundles
    const releases = new s3.Bucket(this, 'Releases', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(60) }],
    });

    // ------------------------------------------------------------ the server
    const role = new iam.Role(this, 'ServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    releases.grantRead(role, 'releases/*');
    // The admin page's password hash, which you put in Parameter Store yourself (CloudFormation
    // can't create encrypted parameters, and the hash must stay out of the public repo).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/games-drawer/admin-password-hash`],
      }),
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(...bootScript({ domain: props.domain, bucket: releases.bucketName, region: this.region }));

    const server = new ec2.Instance(this, 'Server', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(props.instanceType ?? 't4g.micro'),
      machineImage: props.amiId ? ec2.MachineImage.genericLinux({ [this.region]: props.amiId }) : ec2.MachineImage.fromSsmParameter(UBUNTU_AMI_PARAMETER),
      securityGroup: firewall,
      role,
      userData,
      requireImdsv2: true,
      // Burstable machines can bill extra for sustained CPU in "unlimited" mode; standard can't.
      creditSpecification: ec2.CpuCredits.STANDARD,
      blockDevices: [{ deviceName: '/dev/sda1', volume: ec2.BlockDeviceVolume.ebs(12, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }) }],
    });

    // A fixed address, so DNS keeps working if the machine is replaced.
    const ip = new ec2.CfnEIP(this, 'Address', { domain: 'vpc', instanceId: server.instanceId, tags: [{ key: 'Name', value: 'games-drawer' }] });

    // ------------------------------------------------------------ deploys from GitHub Actions
    // GitHub signs each workflow run in with a short-lived token; no AWS keys are stored anywhere.
    const providerArn =
      props.githubOidcProviderArn ??
      new iam.CfnOIDCProvider(this, 'GitHubSignIn', {
        url: 'https://token.actions.githubusercontent.com',
        clientIdList: ['sts.amazonaws.com'],
      }).attrArn;
    const deployRole = new iam.Role(this, 'DeployRole', {
      description: 'GitHub Actions deploys of Games Drawer (staging and production environments only)',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': [`repo:${props.githubRepo}:environment:staging`, `repo:${props.githubRepo}:environment:production`],
        },
      }),
    });
    releases.grantPut(deployRole, 'releases/*');
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          `arn:${this.partition}:ec2:${this.region}:${this.account}:instance/${server.instanceId}`,
          `arn:${this.partition}:ssm:${this.region}::document/AWS-RunShellScript`,
        ],
      }),
    );
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations'], resources: ['*'] }));

    // ------------------------------------------------------------ spending guardrails
    const email = [{ subscriptionType: 'EMAIL', address: props.alertEmail }];
    const alert = (type: 'ACTUAL' | 'FORECASTED', percent: number) => ({
      notification: { notificationType: type, comparisonOperator: 'GREATER_THAN', threshold: percent, thresholdType: 'PERCENTAGE' },
      subscribers: email,
    });
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: { budgetName: 'games-drawer-monthly', budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: props.monthlyBudgetUsd, unit: 'USD' } },
      notificationsWithSubscribers: [alert('ACTUAL', 50), alert('ACTUAL', 80), alert('FORECASTED', 100)],
    });

    // The kill switch: at this much real spend in a month, AWS Budgets stops the server.
    // Billing data lags by hours, so this is a backstop, not an instant cut-off.
    const killBudgetName = 'games-drawer-kill-switch';
    const killBudget = new budgets.CfnBudget(this, 'KillSwitchBudget', {
      budget: { budgetName: killBudgetName, budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: props.killSwitchUsd, unit: 'USD' } },
    });
    const budgetsRole = new iam.Role(this, 'KillSwitchRole', {
      assumedBy: new iam.ServicePrincipal('budgets.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AWSBudgetsActions_RolePolicyForResourceAdministrationWithSSM')],
    });
    const killSwitch = new budgets.CfnBudgetsAction(this, 'KillSwitch', {
      budgetName: killBudgetName,
      notificationType: 'ACTUAL',
      actionType: 'RUN_SSM_DOCUMENTS',
      actionThreshold: { type: 'PERCENTAGE', value: 100 },
      executionRoleArn: budgetsRole.roleArn,
      approvalModel: 'AUTOMATIC',
      definition: { ssmActionDefinition: { subtype: 'STOP_EC2_INSTANCES', region: this.region, instanceIds: [server.instanceId] } },
      subscribers: [{ type: 'EMAIL', address: props.alertEmail }],
    });
    killSwitch.addResourceDependency(killBudget);

    if (props.anomalyAlerts) {
      const monitor = new ce.CfnAnomalyMonitor(this, 'SpendMonitor', { monitorName: 'games-drawer', monitorType: 'DIMENSIONAL', monitorDimension: 'SERVICE' });
      new ce.CfnAnomalySubscription(this, 'SpendAlerts', {
        subscriptionName: 'games-drawer',
        frequency: 'DAILY',
        monitorArnList: [monitor.attrMonitorArn],
        subscribers: [{ type: 'EMAIL', address: props.alertEmail }],
        thresholdExpression: JSON.stringify({ Dimensions: { Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE', MatchOptions: ['GREATER_THAN_OR_EQUAL'], Values: ['5'] } }),
      });
    }

    // ------------------------------------------------------------ what the deploy workflow needs
    new cdk.CfnOutput(this, 'PublicIp', { value: ip.ref, description: 'Point the domain and staging.<domain> here (DNS A records)' });
    new cdk.CfnOutput(this, 'InstanceId', { value: server.instanceId });
    new cdk.CfnOutput(this, 'ReleaseBucket', { value: releases.bucketName });
    new cdk.CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
  }
}

/**
 * Commands run once when the machine first boots: record where things are and install the
 * deploy command. The first deploy then installs Node, Caddy and coturn (deploy/setup.sh).
 */
export function bootScript(o: { domain: string; bucket: string; region: string }): string[] {
  const deployCmd = fs.readFileSync(path.join(repoRoot, 'deploy', 'games-drawer-deploy'), 'utf8').replace(/\r\n/g, '\n');
  if (deployCmd.includes('GAMES_DRAWER_EOF')) throw new Error('deploy script contains the heredoc marker');
  return [
    'set -euo pipefail',
    'install -d -m 755 /etc/games-drawer',
    `printf 'DOMAIN=%s\\nBUCKET=%s\\nREGION=%s\\n' '${o.domain}' '${o.bucket}' '${o.region}' > /etc/games-drawer/deploy.env`,
    "cat > /usr/local/bin/games-drawer-deploy <<'GAMES_DRAWER_EOF'",
    deployCmd.trimEnd(),
    'GAMES_DRAWER_EOF',
    'chmod 755 /usr/local/bin/games-drawer-deploy',
  ];
}
