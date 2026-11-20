import * as cdk from 'aws-cdk-lib';
import * as codeconnections from 'aws-cdk-lib/aws-codeconnections';
import type { Construct } from 'constructs';

/**
 * The link from AWS to the GitHub repo, through AWS's own GitHub app ("AWS Connector for
 * GitHub"), so the account can fetch the code and deploy it itself (the deploy project in
 * stack.ts). No keys or tokens are stored anywhere, and GitHub never signs in to AWS.
 *
 * On its own and created before the main stack: it starts out pending, and you approve it once
 * on GitHub (infra/README.md) before the deploy project can watch the repo.
 */
export class GamesDrawerGitHubStack extends cdk.Stack {
  readonly connectionArn: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('project', 'games-drawer');
    const connection = new codeconnections.CfnConnection(this, 'Connection', { connectionName: 'games-drawer-github', providerType: 'GitHub' });
    this.connectionArn = connection.attrConnectionArn;
    new cdk.CfnOutput(this, 'ConnectionArn', { value: this.connectionArn });
    new cdk.CfnOutput(this, 'ApproveItHere', {
      value: `https://${this.region}.console.aws.amazon.com/codesuite/settings/connections`,
      description: 'Open games-drawer-github, then "Update pending connection", and let the AWS Connector for GitHub see the repo',
    });
  }
}
