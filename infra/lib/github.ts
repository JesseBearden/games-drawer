import * as cdk from 'aws-cdk-lib';
import * as codeconnections from 'aws-cdk-lib/aws-codeconnections';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * The link from AWS to the GitHub repo, through AWS's own GitHub app ("AWS Connector for
 * GitHub"), so the account can fetch the code and deploy it itself (the deploy project in
 * stack.ts). No keys or tokens are stored anywhere, and GitHub never signs in to AWS.
 *
 * On its own and created before the main stack: it starts out pending, and you approve it once
 * on GitHub (infra/README.md) before the deploy project can watch the repo.
 *
 * The deploy project's role lives here too, already allowed to use the connection: CodeBuild
 * checks that when the project is created, and a role made in the same stack as the project
 * may not have its permissions in place yet. The main stack adds the deploy permissions.
 */
export class GamesDrawerGitHubStack extends cdk.Stack {
  readonly connectionArn: string;
  readonly deployRoleArn: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('project', 'games-drawer');
    // (The first connection, games-drawer-github, was approved without installing the app on the
    // repo, so it could fetch nothing; a new name makes a fresh one to approve.)
    const connection = new codeconnections.CfnConnection(this, 'Connection', { connectionName: 'games-drawer-repo', providerType: 'GitHub' });
    this.connectionArn = connection.attrConnectionArn;

    const deployRole = new iam.Role(this, 'DeployRole', {
      description: 'Games Drawer deploys (the games-drawer-deploy CodeBuild project)',
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        UseGitHubConnection: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'codeconnections:GetConnection',
                'codeconnections:GetConnectionToken',
                'codeconnections:UseConnection',
                'codestar-connections:GetConnection',
                'codestar-connections:GetConnectionToken',
                'codestar-connections:UseConnection',
              ],
              resources: [this.connectionArn],
            }),
          ],
        }),
      },
    });
    this.deployRoleArn = deployRole.roleArn;

    new cdk.CfnOutput(this, 'ConnectionArn', { value: this.connectionArn });
    new cdk.CfnOutput(this, 'ApproveItHere', {
      value: `https://${this.region}.console.aws.amazon.com/codesuite/settings/connections`,
      description: 'Open games-drawer-repo, then "Update pending connection", and let the AWS Connector for GitHub see the repo',
    });
  }
}
