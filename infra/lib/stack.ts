import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as route53 from 'aws-cdk-lib/aws-route53';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { FrontDoor } from './edge';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Canonical's current Ubuntu 24.04 image for ARM (Graviton) machines. */
export const UBUNTU_AMI_PARAMETER = '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id';
/** The launch template the fleet tool starts boxes from (LAUNCH_TEMPLATE in GitHub). */
export const LAUNCH_TEMPLATE_NAME = 'games-drawer-box';

export interface GamesDrawerProps extends cdk.StackProps {
  /** The site's domain, and its DNS zone (the GamesDrawerDns stack, edge.ts). */
  domain: string;
  zone: route53.IHostedZone;
  /** Where budget alerts go. Passed in at deploy time, never committed (the repo is public). */
  alertEmail: string;
  /** owner/name of the GitHub repository allowed to deploy. */
  githubRepo: string;
  /** Email alerts at 50% and 80% of this, and when the month is forecast to go over. */
  monthlyBudgetUsd: number;
  /** At this much actual spend in a month, AWS stops every game server box by itself. */
  killSwitchUsd: number;
  instanceType?: string;
  /** Pin the machine image (see infra/README.md); otherwise each stack update takes Ubuntu's latest for the boxes launched after it. */
  amiId?: string;
  /** An account can hold only one GitHub sign-in provider; reuse it if one exists. */
  githubOidcProviderArn?: string;
  /** Extra cost-spike alerts. New AWS accounts usually have AWS's own default monitor already. */
  anomalyAlerts?: boolean;
}

/**
 * Where the game servers run: disposable boxes, launched one per deploy from a launch template
 * (the old box finishes its games and shuts itself down; deploy/README.md), and what outlives
 * them: the shared disk for Jigsaw saves and logs (EFS), release bundles (S3), secrets
 * (Parameter Store, made by the first box). Plus the role GitHub Actions deploys with, and the
 * spending guardrails, and the front door (CloudFront and its certificate, edge.ts).
 *
 * Deliberately no load balancer or NAT gateway: either costs more than the server. The only
 * Lambda functions are the kill switch and two that run at deploy time (a lookup, and the
 * certificate); all are free at this use.
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
    const subnet = vpc.publicSubnets[0];

    // The voice relay is reached directly; boxes also pass requests to each other on port 80.
    const boxFirewall = new ec2.SecurityGroup(this, 'Firewall', { vpc, description: 'Games Drawer boxes: voice relay, and each other', allowAllOutbound: true });
    boxFirewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3478), 'Voice relay (TURN over TCP)');
    boxFirewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(3478), 'Voice relay (TURN over UDP)');
    boxFirewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udpRange(49152, 49352), 'Relayed voice audio');
    boxFirewall.addIngressRule(boxFirewall, ec2.Port.tcp(80), 'Another box passing on a request for one of its tables');
    // No SSH: shell access and deploys go through AWS Systems Manager.

    // Web traffic only from CloudFront. AWS keeps a list of CloudFront's addresses; this looks up
    // its id in this region when the stack deploys. (It counts as 55 rules, so it has a group to itself.)
    const cloudFrontList = new cr.AwsCustomResource(this, 'CloudFrontAddresses', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: { Filters: [{ Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }] },
        physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing'),
        outputPaths: ['PrefixLists.0.PrefixListId'],
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({ actions: ['ec2:DescribeManagedPrefixLists'], resources: ['*'] })]),
      installLatestAwsSdk: false,
    });
    const webFirewall = new ec2.SecurityGroup(this, 'FromCloudFront', { vpc, description: 'Games Drawer boxes: web traffic from CloudFront only', allowAllOutbound: false });
    webFirewall.addIngressRule(ec2.Peer.prefixList(cloudFrontList.getResponseField('PrefixLists.0.PrefixListId')), ec2.Port.tcp(80), 'CloudFront (HTTPS ends there)');

    // ------------------------------------------------------------ what outlives a box
    const releases = new s3.Bucket(this, 'Releases', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(60) }],
    });

    // Jigsaw saves and logs, shared by every box (mounted at /mnt/games-drawer by deploy/setup.sh).
    // A few megabytes: pennies a month. Reached over NFS from the boxes only (the firewall), so
    // it doesn't use EFS's IAM sign-in, which plain NFS clients can't do.
    const sharedDisk = new efs.FileSystem(this, 'SharedDisk', {
      vpc,
      vpcSubnets: { subnets: [subnet] },
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      allowAnonymousAccess: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    sharedDisk.connections.allowDefaultPortFrom(boxFirewall, 'Game server boxes');

    // ------------------------------------------------------------ the boxes
    const role = new iam.Role(this, 'ServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    releases.grantRead(role, 'releases/*');
    const param = (name: string) => `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/games-drawer/${name}`;
    // The admin page's password hash, which you put in Parameter Store yourself (CloudFormation
    // can't create encrypted parameters, and the hash must stay out of the public repo), and the
    // boxes' shared secrets, which the first box makes.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [param('admin-password-hash'), param('secrets')] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:PutParameter'], resources: [param('secrets')] }));
    const profile = new iam.CfnInstanceProfile(this, 'ServerProfile', { roles: [role.roleName] });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(...bootScript({ domain: props.domain, bucket: releases.bucketName, region: this.region, fileSystem: sharedDisk.fileSystemId }));
    const image = (props.amiId ? ec2.MachineImage.genericLinux({ [this.region]: props.amiId }) : ec2.MachineImage.fromSsmParameter(UBUNTU_AMI_PARAMETER)).getImage(this);
    const projectTag = [{ key: 'project', value: 'games-drawer' }];
    const template = new ec2.CfnLaunchTemplate(this, 'Box', {
      launchTemplateName: LAUNCH_TEMPLATE_NAME,
      launchTemplateData: {
        imageId: image.imageId,
        instanceType: props.instanceType ?? 't4g.micro',
        iamInstanceProfile: { arn: profile.attrArn },
        userData: cdk.Fn.base64(userData.render()),
        // The box reads its slot and release from its own tags.
        metadataOptions: { httpTokens: 'required', httpEndpoint: 'enabled', instanceMetadataTags: 'enabled' },
        // A retired box powers itself off once its games are done; AWS then removes it.
        instanceInitiatedShutdownBehavior: 'terminate',
        // Burstable machines can bill extra for sustained CPU in "unlimited" mode; standard can't.
        creditSpecification: { cpuCredits: 'standard' },
        blockDeviceMappings: [{ deviceName: '/dev/sda1', ebs: { volumeSize: 12, volumeType: 'gp3', encrypted: true, deleteOnTermination: true } }],
        networkInterfaces: [
          { deviceIndex: 0, subnetId: subnet.subnetId, groups: [boxFirewall.securityGroupId, webFirewall.securityGroupId], associatePublicIpAddress: true, deleteOnTermination: true },
        ],
        tagSpecifications: [
          { resourceType: 'instance', tags: projectTag },
          { resourceType: 'volume', tags: projectTag },
        ],
      },
    });

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
      maxSessionDuration: cdk.Duration.hours(2),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': [`repo:${props.githubRepo}:environment:staging`, `repo:${props.githubRepo}:environment:production`],
        },
      }),
    });
    releases.grantPut(deployRole, 'releases/*');
    const ec2Arn = (what: string) => `arn:${this.partition}:ec2:${this.region}:${this.account}:${what}`;
    const ours = { StringEquals: { 'aws:ResourceTag/project': 'games-drawer' } };
    // Launch boxes from our template, tagged as ours.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:RunInstances'],
        resources: [
          ec2Arn(`launch-template/${template.ref}`),
          ec2Arn('instance/*'),
          ec2Arn('volume/*'),
          ec2Arn('network-interface/*'),
          ec2Arn(`subnet/${subnet.subnetId}`),
          ec2Arn(`security-group/${boxFirewall.securityGroupId}`),
          ec2Arn(`security-group/${webFirewall.securityGroupId}`),
          `arn:${this.partition}:ec2:${this.region}::image/*`,
        ],
      }),
    );
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:CreateTags'], resources: [ec2Arn('instance/*'), ec2Arn('volume/*')], conditions: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } } }));
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [role.roleArn], conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } } }));
    // Change and remove only our own boxes.
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:CreateTags', 'ec2:TerminateInstances'], resources: [ec2Arn('instance/*')], conditions: ours }));
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances', 'ssm:DescribeInstanceInformation', 'ssm:GetCommandInvocation'], resources: ['*'] }));
    // Run the deploy command on our boxes only.
    deployRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['ssm:SendCommand'], resources: [ec2Arn('instance/*')], conditions: { StringEquals: { 'ssm:resourceTag/project': 'games-drawer' } } }),
    );
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:SendCommand'], resources: [`arn:${this.partition}:ssm:${this.region}::document/AWS-RunShellScript`] }));
    // Point the front door at the new box: the origin record, and nothing else in the zone.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:${this.partition}:route53:::hostedzone/*`],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': [`origin.${props.domain}`],
            'route53:ChangeResourceRecordSetsRecordTypes': ['A'],
            'route53:ChangeResourceRecordSetsActions': ['UPSERT'],
          },
        },
      }),
    );
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['route53:ListResourceRecordSets'], resources: [`arn:${this.partition}:route53:::hostedzone/*`] }));
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['route53:GetChange'], resources: [`arn:${this.partition}:route53:::change/*`] }));
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['route53:ListHostedZonesByName'], resources: ['*'] }));

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

    // The kill switch: at this much real spend in a month, Budgets tells a small function, which
    // stops every game server box (boxes come and go with deploys, so it finds them by tag).
    // Billing data lags by hours, so this is a backstop, not an instant cut-off.
    const killTopic = new sns.Topic(this, 'KillSwitchTopic', { displayName: 'Games Drawer kill switch' });
    killTopic.addToResourcePolicy(
      new iam.PolicyStatement({ actions: ['sns:Publish'], principals: [new iam.ServicePrincipal('budgets.amazonaws.com')], resources: [killTopic.topicArn] }),
    );
    const stopBoxes = new lambda.Function(this, 'KillSwitch', {
      description: 'Games Drawer kill switch: stops every game server box',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(KILL_SWITCH_CODE),
      logGroup: new logs.LogGroup(this, 'KillSwitchLogs', { retention: logs.RetentionDays.ONE_YEAR, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    stopBoxes.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));
    stopBoxes.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:StopInstances'], resources: [ec2Arn('instance/*')], conditions: ours }));
    killTopic.addSubscription(new subs.LambdaSubscription(stopBoxes));
    new budgets.CfnBudget(this, 'KillSwitchBudget', {
      budget: { budgetName: 'games-drawer-kill-switch', budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: props.killSwitchUsd, unit: 'USD' } },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers: [...email, { subscriptionType: 'SNS', address: killTopic.topicArn }],
        },
      ],
    });

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

    // ------------------------------------------------------------ the front door
    const frontDoor = new FrontDoor(this, 'FrontDoor', { domain: props.domain, zone: props.zone });

    // ------------------------------------------------------------ what the deploy workflow needs
    new cdk.CfnOutput(this, 'DistributionId', { value: frontDoor.distribution.distributionId });
    new cdk.CfnOutput(this, 'LaunchTemplateName', { value: LAUNCH_TEMPLATE_NAME });
    new cdk.CfnOutput(this, 'ReleaseBucket', { value: releases.bucketName });
    new cdk.CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
    new cdk.CfnOutput(this, 'SharedDiskId', { value: sharedDisk.fileSystemId });
  }
}

/** The kill switch's function (AWS's Node runtime includes the SDK). */
export const KILL_SWITCH_CODE = `
const { EC2Client, DescribeInstancesCommand, StopInstancesCommand } = require('@aws-sdk/client-ec2');
exports.handler = async () => {
  const ec2 = new EC2Client({});
  const found = await ec2.send(new DescribeInstancesCommand({
    Filters: [{ Name: 'tag:project', Values: ['games-drawer'] }, { Name: 'instance-state-name', Values: ['pending', 'running'] }],
  }));
  const ids = (found.Reservations || []).flatMap((r) => (r.Instances || []).map((i) => i.InstanceId));
  if (ids.length) await ec2.send(new StopInstancesCommand({ InstanceIds: ids }));
  console.log('Stopped', ids);
  return { stopped: ids };
};
`;

/**
 * Commands run once when a box first boots: record where things are and install the deploy
 * command. The fleet tool then starts its release on it (deploy/setup.sh installs the rest).
 */
export function bootScript(o: { domain: string; bucket: string; region: string; fileSystem: string }): string[] {
  const deployCmd = fs.readFileSync(path.join(repoRoot, 'deploy', 'games-drawer-deploy'), 'utf8').replace(/\r\n/g, '\n');
  if (deployCmd.includes('GAMES_DRAWER_EOF')) throw new Error('deploy script contains the heredoc marker');
  return [
    'set -euo pipefail',
    'install -d -m 755 /etc/games-drawer',
    `printf 'DOMAIN=%s\\nBUCKET=%s\\nREGION=%s\\nFILE_SYSTEM=%s\\n' '${o.domain}' '${o.bucket}' '${o.region}' '${o.fileSystem}' > /etc/games-drawer/deploy.env`,
    "cat > /usr/local/bin/games-drawer-deploy <<'GAMES_DRAWER_EOF'",
    deployCmd.trimEnd(),
    'GAMES_DRAWER_EOF',
    'chmod 755 /usr/local/bin/games-drawer-deploy',
  ];
}
