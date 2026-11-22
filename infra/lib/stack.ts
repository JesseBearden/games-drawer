import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
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
import { PIPELINE } from '../../deploy/pipeline';
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
  /** owner/name of the GitHub repository whose pushes to main go through the pipeline. */
  githubRepo: string;
  /** The link to GitHub the pipeline reads the repo through, and the role of its two deploy steps (both the GamesDrawerGitHub stack, github.ts). */
  githubConnectionArn: string;
  deployRoleArn: string;
  /** Email alerts at 50% and 80% of this, and when the month is forecast to go over. */
  monthlyBudgetUsd: number;
  /** At this much actual spend in a month, AWS stops every game server box by itself. */
  killSwitchUsd: number;
  instanceType?: string;
  /**
   * What players come in through. cloudfront: CloudFront (edge.ts), with HTTPS there. direct:
   * the domain's own DNS records point at the boxes (deploys move them) and Caddy on each box
   * does HTTPS; for while CloudFront isn't available to the account (deploy/README.md).
   */
  frontDoor: 'cloudfront' | 'direct';
  /** Pin the machine image (see infra/README.md); otherwise each stack update takes Ubuntu's latest for the boxes launched after it. */
  amiId?: string;
  /** Extra cost-spike alerts. New AWS accounts usually have AWS's own default monitor already. */
  anomalyAlerts?: boolean;
}

/**
 * Where the game servers run: disposable boxes, launched one per deploy from a launch template
 * (the old box finishes its games and shuts itself down; deploy/README.md), and what outlives
 * them: the shared disk for Jigsaw saves and logs (EFS), release bundles (S3), secrets
 * (Parameter Store, made by the first box). Plus the pipeline (CodePipeline and CodeBuild, inside
 * the account: each push to main is tested and put on staging, and goes live once approved), the
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
    boxFirewall.addIngressRule(boxFirewall, ec2.Port.tcp(8080), 'Another box passing on a request for one of its tables');
    // No SSH: shell access and deploys go through AWS Systems Manager.

    // Web traffic. (Its own group, the same either way, so switching front doors only changes its rules.)
    const webFirewall = new ec2.SecurityGroup(this, 'WebFirewall', { vpc, description: 'Games Drawer boxes: web traffic', allowAllOutbound: false });
    if (props.frontDoor === 'cloudfront') {
      // Only from CloudFront. AWS keeps a list of CloudFront's addresses; this looks up its id in
      // this region when the stack deploys. (It counts as 55 rules, hence a group of its own.)
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
      webFirewall.addIngressRule(ec2.Peer.prefixList(cloudFrontList.getResponseField('PrefixLists.0.PrefixListId')), ec2.Port.tcp(80), 'CloudFront (HTTPS ends there)');
    } else {
      // Straight from players: Caddy on the box does HTTPS (and gets its certificates over port 80).
      webFirewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (certificate checks, and the redirect to HTTPS)');
      webFirewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS and game connections');
      webFirewall.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(443), 'HTTP/3');
    }

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
    // Making the secrets, never replacing them.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:PutParameter'], resources: [param('secrets')], conditions: { StringEquals: { 'ssm:Overwrite': 'false' } } }));
    // The automatic check for photos people add to a jigsaw (Rekognition's moderation labels; the
    // photo goes in the request, nothing is stored in S3). The action has no resource to name.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['rekognition:DetectModerationLabels'], resources: ['*'] }));
    const profile = new iam.CfnInstanceProfile(this, 'ServerProfile', { roles: [role.roleName] });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(...bootScript({ domain: props.domain, bucket: releases.bucketName, region: this.region, fileSystem: sharedDisk.fileSystemId, frontDoor: props.frontDoor }));
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

    // ------------------------------------------------------------ deploys, run by the account itself
    // The pipeline (deploy/README.md): each push to main gets every test, then goes to staging; a
    // person approves it before it goes live. Each stage does one release at a time, and a push
    // during one waits its turn (if several do, only the newest goes on). It reads the repo through
    // the GitHub connection, which you approve once; GitHub never signs in to AWS, and nothing
    // secret is stored anywhere. (The account's organization doesn't allow GitHub sign-in links
    // anyway.)
    //
    // The tests run with a role of their own that can't deploy. Staging and going live share the
    // deploy role, which comes from the GitHub stack; this adds the permissions to deploy. So the
    // approval is a guard against mistakes, not against whoever can push to main.
    const deployRole = iam.Role.fromRoleArn(this, 'DeployRole', props.deployRoleArn, { mutable: true });
    const buildLogs = new logs.LogGroup(this, 'DeployLogs', { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY });
    // No limit on builds at once: CodeBuild refuses a build over it rather than queueing it. The
    // pipeline's stages do the taking of turns.
    const step = (id: string, name: string, spec: string, minutes: number, role?: iam.IRole, env: Record<string, string> = {}) =>
      new codebuild.PipelineProject(this, id, {
        projectName: `games-drawer-${name}`,
        description: `Games Drawer pipeline: ${name} (deploy/README.md)`,
        role,
        buildSpec: codebuild.BuildSpec.fromSourceFilename(`deploy/${spec}`),
        // The small Ubuntu machine: the one CodeBuild's free monthly minutes cover.
        environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.SMALL },
        environmentVariables: Object.fromEntries(Object.entries(env).map(([k, value]) => [k, { value }])),
        timeout: cdk.Duration.minutes(minutes),
        logging: { cloudWatch: { logGroup: buildLogs } },
      });
    const deployEnv = { SITE_DOMAIN: props.domain, LAUNCH_TEMPLATE: LAUNCH_TEMPLATE_NAME, RELEASE_BUCKET: releases.bucketName, FRONT_DOOR: props.frontDoor };
    const testProject = step('TestProject', 'test', 'buildspec.yml', 45);
    // Long enough to wait out a release going live (pipeline.ts), then deploy.
    const stagingProject = step('StagingProject', 'staging', 'buildspec.staging.yml', 100, deployRole, deployEnv);
    const goLiveProject = step('GoLiveProject', 'go-live', 'buildspec.go-live.yml', 60, deployRole, { ...deployEnv, CANARY_PERCENT: '10', CANARY_MINUTES: '10' });

    // What the stages hand each other. Not the releases bucket: the Test step writes here, and
    // mustn't be able to write what the boxes run.
    const handOver = new s3.Bucket(this, 'PipelineFiles', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(60) }],
    });
    const [owner, repo] = props.githubRepo.split('/');
    const source = new codepipeline.Artifact('Source');
    const tested = new codepipeline.Artifact('Release');
    const fromGitHub = new actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      variablesNamespace: 'Source',
      connectionArn: props.githubConnectionArn,
      owner,
      repo,
      branch: 'main',
      triggerOnPush: true,
      output: source,
    });
    const deployStep = (actionName: string, project: codebuild.IProject, runOrder?: number) =>
      new actions.CodeBuildAction({
        actionName,
        runOrder,
        project,
        input: source,
        extraInputs: [tested],
        environmentVariables: { COMMIT: { value: fromGitHub.variables.commitId } },
      });
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: PIPELINE.name,
      pipelineType: codepipeline.PipelineType.V2,
      executionMode: codepipeline.ExecutionMode.SUPERSEDED,
      artifactBucket: handOver,
      crossAccountKeys: false,
      usePipelineRoleForActions: true,
      stages: [
        { stageName: 'Source', actions: [fromGitHub] },
        { stageName: 'Test', actions: [new actions.CodeBuildAction({ actionName: 'EveryTest', project: testProject, input: source, outputs: [tested] })] },
        { stageName: 'Staging', actions: [deployStep('DeployToStaging', stagingProject)] },
        {
          // One stage, so nothing else can be going live between the approval and the deploy.
          stageName: PIPELINE.production,
          actions: [
            new actions.ManualApprovalAction({
              actionName: PIPELINE.approve,
              runOrder: 1,
              externalEntityLink: `https://staging.${props.domain}`,
              additionalInformation: `Approve to put commit ${fromGitHub.variables.commitId} live: it's what is on staging. A newer push closes this and asks again.`,
              timeout: cdk.Duration.days(30),
            }),
            deployStep('GoLive', goLiveProject, 2),
          ],
        },
      ],
    });
    // As in github.ts, under both of the connection service's names (CDK grants only the older).
    pipeline.addToRolePolicy(new iam.PolicyStatement({ actions: ['codeconnections:UseConnection'], resources: [props.githubConnectionArn] }));
    // Staging sees what Production is doing, and closes the approval request of a release it
    // replaces. (The ARN is spelled out: the pipeline itself depends on this role's policy.)
    const pipelineArn = `arn:${this.partition}:codepipeline:${this.region}:${this.account}:${PIPELINE.name}`;
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['codepipeline:GetPipelineState'], resources: [pipelineArn] }));
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['codepipeline:PutApprovalResult'], resources: [`${pipelineArn}/${PIPELINE.production}/${PIPELINE.approve}`] }));
    releases.grantPut(deployRole, 'releases/*');
    const ec2Arn = (what: string) => `arn:${this.partition}:ec2:${this.region}:${this.account}:${what}`;
    const ours = { StringEquals: { 'aws:ResourceTag/project': 'games-drawer' } };
    // Launch boxes from our template, tagged as ours.
    deployRole.addToPrincipalPolicy(
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
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['ec2:CreateTags'], resources: [ec2Arn('instance/*'), ec2Arn('volume/*')], conditions: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } } }));
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [role.roleArn], conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } } }));
    // Change and remove only our own boxes.
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['ec2:CreateTags', 'ec2:TerminateInstances'], resources: [ec2Arn('instance/*')], conditions: ours }));
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances', 'ssm:DescribeInstanceInformation', 'ssm:GetCommandInvocation'], resources: ['*'] }));
    // Run the deploy command on our boxes only.
    deployRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['ssm:SendCommand'], resources: [ec2Arn('instance/*')], conditions: { StringEquals: { 'ssm:resourceTag/project': 'games-drawer' } } }),
    );
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['ssm:SendCommand'], resources: [`arn:${this.partition}:ssm:${this.region}::document/AWS-RunShellScript`] }));
    // Point the front door at the new box: the origin record (and, with no CloudFront, the site's
    // own names and staging), and nothing else in the zone.
    deployRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:${this.partition}:route53:::hostedzone/*`],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames':
              props.frontDoor === 'direct' ? [`origin.${props.domain}`, props.domain, `www.${props.domain}`, `staging.${props.domain}`] : [`origin.${props.domain}`],
            'route53:ChangeResourceRecordSetsRecordTypes': ['A'],
            'route53:ChangeResourceRecordSetsActions': ['UPSERT'],
          },
        },
      }),
    );
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['route53:ListResourceRecordSets'], resources: [`arn:${this.partition}:route53:::hostedzone/*`] }));
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['route53:GetChange'], resources: [`arn:${this.partition}:route53:::change/*`] }));
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['route53:ListHostedZonesByName'], resources: ['*'] }));

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
    const frontDoor = props.frontDoor === 'cloudfront' ? new FrontDoor(this, 'FrontDoor', { domain: props.domain, zone: props.zone }) : null;

    // ------------------------------------------------------------ what the deploy workflow needs
    if (frontDoor) new cdk.CfnOutput(this, 'DistributionId', { value: frontDoor.distribution.distributionId });
    new cdk.CfnOutput(this, 'LaunchTemplateName', { value: LAUNCH_TEMPLATE_NAME });
    new cdk.CfnOutput(this, 'ReleaseBucket', { value: releases.bucketName });
    new cdk.CfnOutput(this, 'PipelinePage', {
      value: `https://${this.region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${PIPELINE.name}/view?region=${this.region}`,
      description: 'Where you approve a release to go live',
    });
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
export function bootScript(o: { domain: string; bucket: string; region: string; fileSystem: string; frontDoor: 'cloudfront' | 'direct' }): string[] {
  const deployCmd = fs.readFileSync(path.join(repoRoot, 'deploy', 'games-drawer-deploy'), 'utf8').replace(/\r\n/g, '\n');
  if (deployCmd.includes('GAMES_DRAWER_EOF')) throw new Error('deploy script contains the heredoc marker');
  return [
    'set -euo pipefail',
    'install -d -m 755 /etc/games-drawer',
    `printf 'DOMAIN=%s\\nBUCKET=%s\\nREGION=%s\\nFILE_SYSTEM=%s\\nFRONT_DOOR=%s\\n' '${o.domain}' '${o.bucket}' '${o.region}' '${o.fileSystem}' '${o.frontDoor}' > /etc/games-drawer/deploy.env`,
    "cat > /usr/local/bin/games-drawer-deploy <<'GAMES_DRAWER_EOF'",
    deployCmd.trimEnd(),
    'GAMES_DRAWER_EOF',
    'chmod 755 /usr/local/bin/games-drawer-deploy',
  ];
}
