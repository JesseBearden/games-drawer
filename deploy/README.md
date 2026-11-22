# Deploys and the game server boxes

How a deploy moves Games Drawer from one server box to the next, and what runs on each box.
Setting up AWS itself is in [infra/README.md](../infra/README.md).

## The shape of it

```
players ──HTTPS──▶ CloudFront ──HTTP──▶ origin.<domain> = the current box ──▶ the right box
   │                (the front door: certificate, DNS, never changes)           (by table code)
   └──TURN (voice relay)──▶ each box's own address
```

- **Boxes are disposable.** Each deploy launches a new EC2 box from a launch template. Nothing
  that matters lives only on a box:
  - Jigsaw saves and logs are on a shared disk (EFS) that every box mounts at `/mnt/games-drawer`.
  - Secrets (session signing, stats token, voice relay secret) are in Parameter Store
    (`/games-drawer/secrets`), made by the first box that needs them. The admin password hash is
    there too (see below).
  - Release bundles are in S3.
- **A table lives on one box** (in that server's memory), and **its code says which**: every box
  has a slot letter (a–d), and room codes are made so they map to their box's letter
  (`slotOfCode` in the shared protocol). The page adds `?slot=` to its requests for a table.
- **Every box can answer any request.** Caddy on each box sends a table's requests to that
  table's box over the private network, staging to the newest box, and new tables wherever the
  fleet map says ([fleetMap.ts](fleetMap.ts)). So CloudFront can point at any one box, and
  moving it to a new box never cuts off a game on an old one.

## The front door: CloudFront, or the boxes themselves for now

`"frontDoor"` in [infra/config.json](../infra/config.json) says which:

- **`cloudfront`** (the plan): CloudFront holds the HTTPS certificate and follows
  `origin.<domain>` to the current box; boxes take web traffic from CloudFront only.
- **`direct`** (for now, until AWS lets the account use CloudFront): the domain's own DNS
  records point at the boxes. Deploys point the domain and `www` at the box taking players and
  `staging` at the newest box. Caddy on each box does HTTPS itself with Let's Encrypt
  ([Caddyfile.direct](Caddyfile.direct)). The certificates live on the shared disk, so every box
  uses the same ones and a new box never asks for new ones (Let's Encrypt allows only a few
  duplicates a week). A retiring box keeps answering anyone whose DNS hasn't caught up yet,
  passing them on to the new box.

Both work the same way otherwise; boxes always pass requests to each other on port 8080.

**Switching to CloudFront** once AWS allows it: set `"frontDoor": "cloudfront"`, deploy the
stack (it creates CloudFront and replaces the site's DNS records with ones for CloudFront), then
start a deploy right away. Until the new box (set up for CloudFront) takes over, CloudFront
reaches a box still set up for direct traffic and the site doesn't load, so do it at a quiet
time. It's a few minutes.

## How a deploy works

Each push to main starts the `games-drawer-deploy` CodeBuild project inside the AWS account
([buildspec.yml](buildspec.yml)); GitHub never signs in to AWS. It runs the typecheck and unit
tests (GitHub Actions does too, side by side), builds the release bundle
(`npm run release -- --tar`), uploads it to S3, then runs [deploy.sh](deploy.sh), which drives
the fleet tool ([fleet.ts](fleet.ts)):

1. **launch**: a new box with the release, in a free slot. Its first boot installs the deploy
   command; the fleet tool then has it fetch the release, set itself up ([setup.sh](setup.sh)),
   and start the server. Every box is told the new map: staging is the new box; new tables stay
   where they were. Smoke tests (`npx playwright test --grep @smoke`) run against
   `staging.<domain>`.
2. **canary**: the new box gets a share of new tables (10% by default). Smoke tests run against
   it through the real front door (`?slot=` routes straight to it).
3. **check**, every minute for 10 minutes: any crash, restart, room error or message-handler
   error on the new box fails the deploy.
4. **promote**: the new box takes every new table, and `origin.<domain>` moves to it (DNS with a
   one-minute TTL, so CloudFront follows within a couple of minutes). The old box gets
   `SIGUSR2`: it finishes the games it has (people stay connected the whole time, through any
   box), passes everything else to the new box, then powers itself off once its games are done
   and at least 15 minutes have passed. It was launched to terminate on shutdown, so AWS removes
   it. (A table can hold a box for at most `DRAIN_MAX_MS`, 3 hours. Tables still there 10 minutes
   before then are told to start a new table, and at the cutoff they close with that reason,
   their puzzles saved.)
5. If anything fails, **rollback** removes the new box and puts everything back on the current one.

The very first deploy (or one after every box is gone) has no current box: the new box takes
the front door straight away.

Pages loaded from one box ask for that release's build files, which may come back from
another box. So a new box copies in the files of the release it replaces, and at the canary
step the current box copies in the new release's.

A box from an earlier deploy may still be finishing its games when the next deploy comes; it
keeps its slot, and the new box takes a free one. If all four are taken, the oldest retiring
box stops at once.

## Trying a release on staging first

`staging.<domain>` is the beta site (user, 2026-11-21). `STAGING_ONLY=1 bash deploy/deploy.sh
<commit>` does step 1 only: a new box with that release, smoke tests against staging, and it
stops there. Staging shows the new box; everyone on the site itself stays on the current box,
and nobody is sent to the new one. Try it on staging from a phone and a computer, then either:

- **go live:** deploy the same commit again without `STAGING_ONLY` (its launch replaces the
  staging box with a fresh one, then canary, checks and promote as usual), or
- **take it down:** `npx tsx deploy/fleet.ts rollback <commit>`; staging goes back to the
  current box.

Any commit in the releases bucket can go to staging, pushed or not; only push and deploy pushed
commits to the site itself, so GitHub matches what's live. While it's up, the staging box is a
second server (about 1.4¢ an hour), so take it down or go live the same day. It shares the
site's disk and secrets: saved puzzles and logs are the real ones, so testing there shows up on
the admin page, and anything it can do (such as checking photos with Rekognition) needs the same
AWS set-up as the site.

## The fleet tool by hand

From the repo, with the `games-drawer` AWS profile (needs `AWS_REGION` and `LAUNCH_TEMPLATE`, as
the deploy project sets them). The domain and the front door (`direct` while the site runs without
CloudFront) come from `infra/config.json`; `SITE_DOMAIN` and `FRONT_DOOR` may repeat them, and the
tool refuses to run if they disagree. (A wrong front door would be bad: a promote would move only
`origin.`, leaving the site on the old box, which then shuts itself down.)
`bash deploy/deploy.sh <commit>` runs a whole
deploy this way, for a release already in the bucket. On Windows (Git Bash), also set
`MSYS_NO_PATHCONV=1` and `SKIP_BROWSER_INSTALL=1` (Playwright's `--with-deps` can't run there;
the local browser works), and build the release from a clean copy of the commit
(`git archive <commit>`, `origin/main` for the site itself) rather than the working folder:

```bash
export AWS_PROFILE=games-drawer AWS_REGION=us-east-2 SITE_DOMAIN=gamesdrawer.com LAUNCH_TEMPLATE=games-drawer-box FRONT_DOOR=direct
npx tsx deploy/fleet.ts status                 # the live boxes, and where the front door points
npx tsx deploy/fleet.ts rollback <commit>      # remove a new box by hand
npx tsx deploy/fleet.ts launch <commit>        # e.g. bring the site back after the kill switch
npx tsx deploy/fleet.ts promote <commit>
```

## What's on a box

[setup.sh](setup.sh) sets each box up, and every deploy re-runs it when it changes:

- **Caddy** ([Caddyfile](Caddyfile)) on port 80, plain HTTP (HTTPS ends at CloudFront). Only
  CloudFront and our other boxes can reach it. The routes (`/etc/caddy/games-drawer-routes.caddy`)
  come from the fleet map.
- **coturn** ([turnserver.conf](turnserver.conf)), the voice relay for players whose networks
  block direct voice connections. Each box runs its own, on its own address.
- **The game server**, as a systemd service ([games-drawer@.service](games-drawer@.service))
  running as the unprivileged `games` user (the same user id on every box, since they share the
  disk), locked down to writing only the shared disk.
- **The rollout tool** ([rollout.ts](rollout.ts)), which the fleet tool runs through
  `games-drawer-deploy` and AWS Systems Manager (there is no SSH).

## Handy commands

Open a shell on a box (needs the AWS CLI's Session Manager plugin; `fleet.ts status` lists ids):

```bash
aws ssm start-session --target <instance id> --profile games-drawer
```

Then:

```bash
sudo games-drawer-deploy <commit> status       # what this box runs
journalctl -u 'games-drawer@*' -f              # server output
cat /etc/caddy/games-drawer-routes.caddy       # where this box sends requests
ls /mnt/games-drawer/logs/                     # JSONL game logs, a folder per box (all deleted after 30 days)
```

## Admin page

The admin page (`/admin`) needs its password's hash in AWS Parameter Store. The hash is one-way:
it can check the password but can't be turned back into it. Still, keep it out of the repo. Set
it once (and again whenever you change the password), from the repo on your computer:

```bash
aws ssm put-parameter --profile games-drawer --name /games-drawer/admin-password-hash --type SecureString --overwrite --value "$(npm run -s admin-password -- --value)"
```

(In Git Bash on Windows, put `MSYS_NO_PATHCONV=1` in front, or Git Bash turns the name into a
Windows file path. PowerShell runs it as it is.)

The next deploy picks it up (`games-drawer-deploy` writes it to `/etc/games-drawer/admin.env`).
The boxes can read that parameter and their shared secrets, and no other. Parameter Store's
standard tier is free, unlike Secrets Manager, and does the same job here. The admin page on any
box adds up every box's logs from the shared disk.

## Your own photos (jigsaw)

People at a private table can add their own photo for a jigsaw. The phone shrinks it, the box
checks it with Amazon Rekognition (`DetectModerationLabels`, the photo sent in the request) and
keeps it in memory only until the table closes (packages/server/src/photos.ts). The boxes call
Rekognition with their own role, so two things have to be set up in AWS once, **before** the
first deploy that has it:

1. **Permission:** the boxes' role may call `rekognition:DetectModerationLabels`
   (infra/lib/stack.ts). Apply it with
   `ALERT_EMAIL=… npm run infra -- deploy GamesDrawer --profile games-drawer` (see
   infra/README.md). Until then, every photo is refused with "couldn't be checked just now"
   (never let through unchecked).
2. **Opt out of AI training.** By default AWS may keep pictures sent to Rekognition to improve
   its services; the privacy page says we've told it not to. This is set by an AWS
   Organizations policy, from the organization's **management account**. The site's account is a
   member of an organization (as of 2026-11-21), so it can't set this itself: sign in to the
   management account. (An account in no organization creates one, free, and is its own
   management account.) In the console: **AWS Organizations** → **Policies** → **AI services
   opt-out policies** → enable them → create a policy with this content, and attach it to the
   root (every account) or to the site's account:

   ```json
   { "services": { "default": { "opt_out_policy": { "@@assign": "optOut" } } } }
   ```

To turn uploads off, set `PHOTO_CHECK=off` in setup.sh (`pretend` lets every photo through:
only for your own computer and tests). The admin logs show `photo_added`, `photo_refused` (with
what kind of thing the check found) and `photo_check_failed`; never the photo.

## Voice relay (TURN)

Voice chat connects players directly. Some networks (strict routers, some mobile carriers,
work Wi-Fi) block that; those players' audio goes through coturn instead. The box a table is on
hands each player relay credentials for its own coturn, which expire after 24 hours
(`TURN_TTL_SECONDS`), signed with the shared secret.

**Testing it:** open a private room with `?relay=1` on the end of the URL (for example
`https://<domain>/r/BCDFG?relay=1`) on two phones on cell data. That forces every voice
link through the relay. The voice panel shows "(relayed)" next to each person when it works.

**Limits:** the relay refuses to forward to private and internal addresses (including the AWS
metadata service), allows 16 KB/s per relayed link (`max-bps`) and 300 KB/s in total per box
(`bps-capacity`), which is about 50 voice streams at once. Both are in
[turnserver.conf](turnserver.conf); change them there and deploy (setup.sh re-renders the file
and restarts coturn). The admin page's Voice section shows how often voice needs the relay.
Networks that only allow port 443 aren't covered; that would need a second address for the relay.
