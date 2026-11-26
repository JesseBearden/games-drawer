# AWS setup (CDK)

Three stacks, all code in [lib/](lib) and all in Ohio (the AWS account's organization keeps it
to that region):

- **GamesDrawerDns** ([edge.ts](lib/edge.ts)): the domain's DNS zone (Route 53), on its own
  and created first, because the registrar has to point the domain at it before HTTPS
  certificates can be issued.
- **GamesDrawerGitHub** ([github.ts](lib/github.ts)): the link from AWS to the GitHub repo
  (a CodeConnections connection, through AWS's own GitHub app), on its own because you approve
  it once on GitHub before deploys can use it.
- **GamesDrawer** ([stack.ts](lib/stack.ts)): everything else.
  - **The front door:** with `"frontDoor": "cloudfront"` in [config.json](config.json), the
    HTTPS certificate (asked for in us-east-1, the only region CloudFront takes them from) and
    CloudFront, which passes players through to whichever box `origin.<domain>` points at. It's
    `"direct"` now, as CloudFront isn't enabled on the account yet: the domain points straight at
    the boxes, with Caddy doing HTTPS. Switching is in
    [deploy/README.md](../deploy/README.md#the-front-door).
  - **The game server boxes and what outlives them:** a launch template that deploys start
    boxes from, a shared disk for Jigsaw saves and logs (EFS), a bucket for release bundles.
  - **The pipeline** (CodePipeline, with three CodeBuild projects): each push to main gets every
    test, goes to staging, and waits for approval to go live. It's all inside the account; GitHub
    never signs in to AWS. GitHub Actions tests every push and pull request too.
  - **The spending guardrails.**
  - **The GamesDrawer dashboard** (CloudWatch): the boxes' minute counts, people at a table,
    by game, in voice and on the relay, and devices a day
    ([deploy/README.md](../deploy/README.md#counts-in-cloudwatch)).

How a deploy moves from box to box is in [deploy/README.md](../deploy/README.md).

| Piece | Why | Rough cost |
| --- | --- | --- |
| A `t4g.micro` box (Ubuntu 24.04, ARM) | Runs the game, Caddy and the voice relay | ~$6.10/month (two for a little while during a deploy) |
| Its public address | The voice relay is reached directly | ~$3.65/month per box |
| Its 12 GB encrypted disk | | ~$1/month per box |
| Shared disk (EFS) | Jigsaw saves and logs outlive the boxes | pennies (a few MB) |
| Route 53 hosted zone | The domain's DNS | $0.50/month |
| CloudFront (once enabled) | HTTPS, the front door that never changes | free up to 1 TB and 10 million requests a month |
| A private bucket for release bundles | Deploys fetch releases from here | pennies |
| Voice relayed through a box | | free for the first 100 GB a month, then $0.09/GB |
| The pipeline (CodeBuild and CodePipeline) | Tests each push, deploys staging, then the site | free for 100 build minutes and 100 pipeline minutes a month, then about half a cent and a fifth of a cent a minute: roughly 25¢ a push that goes live |
| A staging box | The release being tried, until it's live or taken down | about 1.4¢/hour |
| Budgets, the kill switch, the GitHub connection | Guardrails and deploy access | free |
| CloudWatch counts and the dashboard | How busy the site is | 30¢ a month per number for the hours it's sent; zeros aren't, so about 40¢–70¢ a month (at most $4 if someone's always on). Sending is one request a minute, inside the free million a month. The dashboard is free as one of the account's first three |

No load balancer or NAT gateway: either one costs more than the server. With the `direct` front
door, game traffic goes straight from the box: free for the first 100 GB a month across AWS, then
$0.09/GB. Behind CloudFront it would count against CloudFront's free terabyte instead.

## Spending guardrails

- **Alerts:** an email at 50% and 80% of $30 in a month, and when AWS forecasts the month going over.
- **Kill switch:** when actual spend for the month reaches $65, AWS Budgets emails you and
  triggers a small function that stops every game server box (it finds them by their
  `project=games-drawer` tag, since boxes change with every deploy). Billing data lags by a few
  hours, so it's a backstop, not a hard cap.
- **No surprise CPU bills:** boxes use "standard" CPU credits, which can't bill extra.
- **Bandwidth caps in the software:** at most 50 tables at once per box, of up to 4 people (6 for
  Jigsaw) (`MAX_PRIVATE_ROOMS` in [deploy/setup.sh](../deploy/setup.sh)), and the
  voice relay is capped at 60 slots and 930 KB/s out per box
  ([deploy/turnserver.conf](../deploy/turnserver.conf), [deploy/relay-firewall.sh](../deploy/relay-firewall.sh)).
  Web traffic itself (pages, pictures, game connections) has no cap of its own.
  A table closes a minute after its last person leaves, and after 10 minutes with nobody playing
  or talking (`IDLE_ROOM_MS`), with a minute's warning.
- Change the amounts in [config.json](config.json).

These budgets watch the whole AWS account, so they work best in an account used only for this.
The organization the account belongs to also has its own hard limit at $75; the kill switch is
set lower so the boxes stop (and stop costing) before that locks the account.

**If the kill switch fires:** the site goes down. Check the bill first. Then launch a fresh box,
which takes the front door straight away (`npx tsx deploy/fleet.ts launch <commit>` then
`promote <commit>`; see [deploy/README.md](../deploy/README.md#the-fleet-tool-by-hand)), and
terminate the stopped ones in the EC2 console. Nothing is lost: saves and logs are on the shared
disk.

## First-time setup

Done once, from your computer, to build the AWS side in a ready AWS account.

1. Install the AWS CLI and sign in (opens a browser):

   ```bash
   winget install Amazon.AWSCLI
   aws configure set region us-east-2 --profile games-drawer
   aws login --region us-east-2 --profile games-drawer
   ```

2. The domain is `gamesdrawer.com` (`"domain"` in `config.json`). Staging is
   `staging.gamesdrawer.com`, and `www.` redirects to the plain domain.

3. One-time CDK set-up for the account (a small bucket and roles CDK uses to deploy):

   ```bash
   npm run infra -- bootstrap aws://<account id>/us-east-2 --profile games-drawer
   ```

4. Create the domain's DNS zone, and move the domain to it:

   ```bash
   npm run infra -- deploy GamesDrawerDns --profile games-drawer
   ```

   It prints `NameServers`: four names. Enter them at Squarespace, where the domain is
   registered: **Domains → gamesdrawer.com → DNS → Nameservers → Use custom nameservers**. The
   domain stays registered at Squarespace; only its DNS moves. The change usually spreads within
   an hour; this shows the Route 53 names once it has:

   ```bash
   nslookup -type=NS gamesdrawer.com 8.8.8.8
   ```

5. Create the link to GitHub, and approve it:

   ```bash
   npm run infra -- deploy GamesDrawerGitHub --profile games-drawer
   ```

   It starts out pending. Open the link it prints (`ApproveItHere`), pick
   **games-drawer-repo**, then **Update pending connection**. That has two parts, and both are
   needed:
   - **Authorize** the **AWS Connector for GitHub** app (signing in with GitHub).
   - **Install** it: under **GitHub Apps**, choose **Install a new app**, pick your account, then
     **Only select repositories** → `games-drawer`, and **Install**. Back on the AWS page, the
     new installation fills in the box; choose **Connect**.

   The connection then shows **Available**. (Authorizing alone also shows Available, but the app
   then can't see the repo or set up the push webhook. On GitHub, the app should be listed under
   **Settings → Applications → Installed GitHub Apps**, not only under Authorized.)

6. Create the rest. The alert email is passed in, never committed, because this repo is public:

   ```bash
   ALERT_EMAIL=<your email address> npm run infra -- deploy GamesDrawer --profile games-drawer
   ```

   It can take up to 20 minutes (CloudFront and its certificate are the slow parts) and prints
   `LaunchTemplateName`, `ReleaseBucket` and `PipelinePage`. No box runs yet; the first deploy
   starts one.

7. Set the admin page's password hash ([deploy/README.md](../deploy/README.md#admin-page)).

8. Push to `main` (or choose **Release change** in the pipeline, which also runs by itself when
   it's created). The first deploy launches the first box and points the front door at it (with
   no site yet, that's the Staging step), and installs Node, Caddy and coturn on it, which takes
   a few minutes. Then approve it ([deploy/README.md](../deploy/README.md#the-pipeline)). Each
   step's log is linked from the pipeline. The canary's share and watch time are
   `CANARY_PERCENT` and `CANARY_MINUTES` on the go-live project (stack.ts).

9. Optional: pin the machine image, so boxes keep the same Ubuntu image until you choose to
   move on. Put the launch template's image id into `config.json` as `"amiId"`, then deploy the
   stack again:

   ```bash
   aws ec2 describe-launch-template-versions --launch-template-name games-drawer-box --versions '$Latest' --query "LaunchTemplateVersions[0].LaunchTemplateData.ImageId" --output text --profile games-drawer
   ```

   Unpinned, each stack update picks up Ubuntu's latest image for boxes launched after it
   (security updates install themselves on running boxes either way).

## Day to day

- `ALERT_EMAIL=… npm run infra -- diff GamesDrawer --profile games-drawer` shows what a change
  would do; `deploy GamesDrawer` applies it. A change to the launch template (instance size,
  image, first-boot script) takes effect with the next deploy's box; nothing running is replaced.
  Machine setup lives in [deploy/setup.sh](../deploy/setup.sh), which every new box runs.
- **A bigger box:** change `"instanceType"` in `config.json` (for example `t4g.small`, or
  `c7g.medium` for steady CPU) and deploy the stack; the next deploy's box is the bigger size.
- `npm test` checks the stacks (no AWS account needed); `ALERT_EMAIL=… npm run infra -- synth`
  prints the CloudFormation templates.
- **Shutting it all down:** `npx tsx deploy/fleet.ts status` to find the boxes and terminate
  them, then `ALERT_EMAIL=… npm run infra -- destroy --all --profile games-drawer`. The DNS zone,
  the shared disk and the releases bucket are kept so a slip can't lose them; delete them in the
  console if you really mean it.
