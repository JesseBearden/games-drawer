# AWS setup (CDK)

[lib/stack.ts](lib/stack.ts) is everything Games Drawer runs on in AWS:

| Piece | Why | Rough cost |
| --- | --- | --- |
| One `t4g.micro` server (Ubuntu 24.04, ARM) | Runs the game, Caddy (HTTPS) and the voice relay | ~$6.10/month |
| A fixed public address | DNS keeps working if the server is replaced | ~$3.65/month |
| 12 GB encrypted disk | | ~$1/month |
| A private bucket for release bundles | Deploys copy releases from here | pennies |
| Data out to players | Free for the first 100 GB a month, then $0.09/GB | depends on play |
| Budgets, the kill switch, the GitHub sign-in role | Guardrails and deploy access | free |

No load balancer, NAT gateway or Lambda functions: any one of them costs more than the server.

## Spending guardrails

- **Alerts:** an email at 50% and 80% of $30 in a month, and when AWS forecasts the month going over.
- **Kill switch:** when actual spend for the month reaches $75, AWS Budgets stops the server by
  itself (and emails). Billing data lags by a few hours, so it's a backstop, not a hard cap.
- **No surprise CPU bills:** the server uses "standard" CPU credits, which can't bill extra.
- **Bandwidth caps in the software:** at most 10 public and 50 private rooms of 4 at once
  (`MAX_PUBLIC_ROOMS` and `MAX_PRIVATE_ROOMS` in [deploy/setup.sh](../deploy/setup.sh)), and
  the voice relay is capped at 300 KB/s in total (`bps-capacity` in
  [deploy/turnserver.conf](../deploy/turnserver.conf)). A table closes a minute after its last
  person leaves, and after 10 minutes with nobody playing or talking (`IDLE_ROOM_MS`), with a
  minute's warning.
- Change the amounts in [config.json](config.json).

These budgets watch the whole AWS account, so they work best in an account used only for this.

**If the kill switch fires:** the site goes down until you start the server again. Check the
bill first, then: `aws ec2 start-instances --instance-ids <InstanceId> --profile games-drawer`.

## First-time setup

Done once, from this computer, after the AWS account is ready.

1. Install the AWS CLI and sign in (opens a browser):

   ```bash
   winget install Amazon.AWSCLI
   aws configure set region us-east-2 --profile games-drawer
   aws login --region us-east-2 --profile games-drawer
   ```

2. The domain is `gamesdrawer.com` (`"domain"` in `config.json`). Staging is
   `staging.gamesdrawer.com`, and `www.` redirects to the plain domain.

3. One-time CDK set-up for the account (a small bucket and roles CDK uses to deploy). Every
   `npm run infra` command needs the alert email in front, because the repo can't hold it:

   ```bash
   ALERT_EMAIL=you@example.com npm run infra -- bootstrap aws://<account id>/us-east-2 --profile games-drawer
   ```

4. Create everything. The alert email is passed in, never committed, because this repo is public:

   ```bash
   ALERT_EMAIL=you@example.com npm run infra -- deploy --profile games-drawer
   ```

   It prints `PublicIp`, `InstanceId`, `ReleaseBucket` and `DeployRoleArn`.

5. Point the domain at the server. The domain is registered at Squarespace: open
   **Domains → gamesdrawer.com → DNS → DNS Settings**, delete the **Squarespace Defaults**
   records (they point at a Squarespace page), and add three custom records:

   | Host | Type | Data |
   | --- | --- | --- |
   | `@` | A | `PublicIp` |
   | `www` | A | `PublicIp` |
   | `staging` | A | `PublicIp` |

   Caddy gets the HTTPS certificates by itself once these resolve, usually within minutes.

6. Pin the machine image, so a new Ubuntu release never replaces the server unasked. Put the
   server's image id into `config.json` as `"amiId"`, then deploy again (it should change nothing):

   ```bash
   aws ec2 describe-instances --instance-ids <InstanceId> --query "Reservations[0].Instances[0].ImageId" --output text --profile games-drawer
   ```

7. Tell GitHub Actions where to deploy (these aren't secrets; they only work for this repo's
   deploy jobs):

   ```bash
   gh variable set AWS_REGION --body us-east-2
   gh variable set SITE_DOMAIN --body <domain>
   gh variable set DEPLOY_INSTANCE_ID --body <InstanceId>
   gh variable set RELEASE_BUCKET --body <ReleaseBucket>
   gh variable set DEPLOY_ROLE_ARN --body <DeployRoleArn>
   ```

   Optional: `CANARY_PERCENT` (default 10) and `CANARY_MINUTES` (default 10). To approve each
   production deploy by hand, add yourself as a required reviewer on the `production`
   environment in the repository's settings.

8. Push to `main` (or re-run the latest workflow). The first deploy installs Node, Caddy and
   coturn on the server, which takes a few minutes.

## Day to day

- `ALERT_EMAIL=… npm run infra -- diff --profile games-drawer` shows what a change would do;
  `deploy` applies it. Changes to the server's first-boot script don't apply to a running
  server (they'd need a new one); machine setup lives in [deploy/setup.sh](../deploy/setup.sh)
  instead, which every deploy re-runs when it changes.
- `npm test` checks the stack (no AWS account needed); `npm run infra -- synth` prints the
  CloudFormation template.
- **Shutting it all down:** `npm run infra -- destroy --profile games-drawer`, then delete the
  releases bucket in the S3 console (it's kept so a slip can't lose it).
