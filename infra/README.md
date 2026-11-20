# AWS setup (CDK)

Two stacks, both code in [lib/](lib):

- **GamesDrawerEdge** ([edge.ts](lib/edge.ts), in us-east-1, where CloudFront's certificates
  must live): the front door. The domain's DNS (Route 53), its HTTPS certificate, and
  CloudFront, which passes players through to whichever box `origin.<domain>` points at.
- **GamesDrawer** ([stack.ts](lib/stack.ts), in Ohio): the game server boxes and what outlives
  them. A launch template that deploys start boxes from, a shared disk for Jigsaw saves and logs
  (EFS), a bucket for release bundles, the role GitHub Actions deploys with, and the spending
  guardrails.

How a deploy moves from box to box is in [deploy/README.md](../deploy/README.md).

| Piece | Why | Rough cost |
| --- | --- | --- |
| A `t4g.micro` box (Ubuntu 24.04, ARM) | Runs the game, Caddy and the voice relay | ~$6.10/month (two for a little while during a deploy) |
| Its public address | The voice relay is reached directly | ~$3.65/month per box |
| Its 12 GB encrypted disk | | ~$1/month per box |
| Shared disk (EFS) | Jigsaw saves and logs outlive the boxes | pennies (a few MB) |
| Route 53 hosted zone | The domain's DNS | $0.50/month |
| CloudFront | HTTPS, the front door that never changes | free up to 1 TB and 10 million requests a month |
| A private bucket for release bundles | Deploys fetch releases from here | pennies |
| Voice relayed through a box | | free for the first 100 GB a month, then $0.09/GB |
| Budgets, the kill switch, the GitHub sign-in role | Guardrails and deploy access | free |

No load balancer or NAT gateway: either one costs more than the server. Game traffic to players
goes out through CloudFront, so it counts against CloudFront's free terabyte rather than EC2's
data-out charges.

## Spending guardrails

- **Alerts:** an email at 50% and 80% of $30 in a month, and when AWS forecasts the month going over.
- **Kill switch:** when actual spend for the month reaches $75, AWS Budgets emails you and
  triggers a small function that stops every game server box (it finds them by their
  `project=games-drawer` tag, since boxes change with every deploy). Billing data lags by a few
  hours, so it's a backstop, not a hard cap.
- **No surprise CPU bills:** boxes use "standard" CPU credits, which can't bill extra.
- **Bandwidth caps in the software:** at most 10 public and 50 private rooms of 4 at once per box
  (`MAX_PUBLIC_ROOMS` and `MAX_PRIVATE_ROOMS` in [deploy/setup.sh](../deploy/setup.sh)), and
  the voice relay is capped at 300 KB/s per box (`bps-capacity` in
  [deploy/turnserver.conf](../deploy/turnserver.conf)). A table closes a minute after its last
  person leaves, and after 10 minutes with nobody playing or talking (`IDLE_ROOM_MS`), with a
  minute's warning.
- Change the amounts in [config.json](config.json).

These budgets watch the whole AWS account, so they work best in an account used only for this.

**If the kill switch fires:** the site goes down. Check the bill first. Then launch a fresh box,
which takes the front door straight away (re-run the latest deploy in GitHub Actions, or
`npx tsx deploy/fleet.ts launch <commit>` then `promote <commit>`; see
[deploy/README.md](../deploy/README.md#the-fleet-tool-by-hand)), and terminate the stopped ones
in the EC2 console. Nothing is lost: saves and logs are on the shared disk.

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

3. One-time CDK set-up for the account, in both regions (a small bucket and roles CDK uses to
   deploy). Every `npm run infra` command needs the alert email in front, because the repo
   can't hold it:

   ```bash
   ALERT_EMAIL=you@example.com npm run infra -- bootstrap aws://<account id>/us-east-2 aws://<account id>/us-east-1 --profile games-drawer
   ```

4. Create the front door, and move the domain's DNS to it. Start the deploy:

   ```bash
   ALERT_EMAIL=you@example.com npm run infra -- deploy GamesDrawerEdge --profile games-drawer
   ```

   It creates the domain's DNS zone in Route 53, then waits for the HTTPS certificate, which
   AWS only issues once the domain's DNS really is Route 53. So while it waits, in another
   terminal, get the zone's four nameservers:

   ```bash
   aws route53 get-hosted-zone --profile games-drawer --id "$(aws route53 list-hosted-zones-by-name --profile games-drawer --dns-name gamesdrawer.com --query 'HostedZones[0].Id' --output text)" --query DelegationSet.NameServers
   ```

   and enter them at Squarespace, where the domain is registered: **Domains → gamesdrawer.com
   → DNS → Nameservers → Use custom nameservers**. The domain stays registered at Squarespace;
   only its DNS moves. (Squarespace's own DNS records stop applying. If the domain ever gets
   email, its MX records go in Route 53 instead.) The deploy finishes once the change has
   spread, usually within an hour. It prints `NameServers` too.

5. Create the rest:

   ```bash
   ALERT_EMAIL=you@example.com npm run infra -- deploy GamesDrawer --profile games-drawer
   ```

   It prints `LaunchTemplateName`, `ReleaseBucket` and `DeployRoleArn`. No box runs yet; the
   first deploy starts one.

6. Set the admin page's password hash ([deploy/README.md](../deploy/README.md#admin-page)).

7. Tell GitHub Actions where to deploy (these aren't secrets; they only work for this repo's
   deploy jobs):

   ```bash
   gh variable set AWS_REGION --body us-east-2
   gh variable set SITE_DOMAIN --body gamesdrawer.com
   gh variable set LAUNCH_TEMPLATE --body <LaunchTemplateName>
   gh variable set RELEASE_BUCKET --body <ReleaseBucket>
   gh variable set DEPLOY_ROLE_ARN --body <DeployRoleArn>
   ```

   Optional: `CANARY_PERCENT` (default 10) and `CANARY_MINUTES` (default 10). To approve each
   production step by hand, add yourself as a required reviewer on the `production`
   environment in the repository's settings.

8. Push to `main` (or re-run the latest workflow). The first deploy launches the first box,
   points the front door at it, and installs Node, Caddy and coturn on it, which takes a few
   minutes.

9. Optional: pin the machine image, so boxes keep the same Ubuntu image until you choose to
   move on. Put the launch template's image id into `config.json` as `"amiId"`, then deploy the
   stack again:

   ```bash
   aws ec2 describe-launch-template-versions --launch-template-name games-drawer-box --versions '$Latest' --query "LaunchTemplateVersions[0].LaunchTemplateData.ImageId" --output text --profile games-drawer
   ```

   Unpinned, each stack update picks up Ubuntu's latest image for boxes launched after it
   (security updates install themselves on running boxes either way).

## Day to day

- `ALERT_EMAIL=… npm run infra -- diff --all --profile games-drawer` shows what a change would
  do; `deploy --all` applies it. A change to the launch template (instance size, image, first-boot
  script) takes effect with the next box, so with the next deploy; nothing running is replaced.
  Machine setup lives in [deploy/setup.sh](../deploy/setup.sh), which every new box runs.
- **A bigger box:** change `"instanceType"` in `config.json` (for example `t4g.small`, or
  `c7g.medium` for steady CPU), deploy the stack, then deploy the site.
- `npm test` checks both stacks (no AWS account needed); `npm run infra -- synth` prints the
  CloudFormation templates.
- **Shutting it all down:** `npx tsx deploy/fleet.ts status` to find the boxes and terminate
  them, then `npm run infra -- destroy --all --profile games-drawer`. The DNS zone, the shared
  disk and the releases bucket are kept so a slip can't lose them; delete them in the console
  if you really mean it.
