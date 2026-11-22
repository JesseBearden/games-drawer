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
  moving it to a new box never cuts off a game on an old one. A box that's gone (a retired one
  powers itself off, but the others keep its route until the next deploy writes the map) gets
  2 seconds to answer; then the box asked answers itself, so the page hears "this table has
  closed" instead of waiting on nothing. Route changes reload Caddy without dropping anyone's
  open connection (`stream_close_delay`).

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

## The pipeline

Each push to main starts the `games-drawer` pipeline inside the AWS account (CodePipeline, built
by [infra/lib/stack.ts](../infra/lib/stack.ts)); GitHub never signs in to AWS.

| Stage | What happens |
| --- | --- |
| **Source** | Fetches the pushed commit. |
| **Test** | Typecheck, unit tests, the release build, and every browser test on that build ([buildspec.yml](buildspec.yml)). A failure stops here: staging and the site don't change. |
| **Staging** | The tested build goes on `staging.<domain>`, with smoke tests ([buildspec.staging.yml](buildspec.staging.yml)). |
| **Production** | Waits up to 30 days for someone to approve. Then that same build goes live ([buildspec.go-live.yml](buildspec.go-live.yml)). |

**To go live:** try it on staging, then open the pipeline (the AWS console, CodePipeline,
`games-drawer`, in the site's region; the stack's `PipelinePage` output is the link). On
**Approve** in Production, choose **Review**, then **Approve**. It shows the commit. It's live
about 20 minutes later. To not ship it, choose **Reject**; it stays on staging until the next
push, or until you take it down.

- **Pushes while it's busy wait their turn.** If several do, only the newest goes on.
- **The approval is always for what's on staging.** When a newer build is about to replace it,
  the waiting request is closed (Production shows "Rejected", saying staging moved on) and the
  newer build asks again once it's there ([pipeline.ts](pipeline.ts)). Going live refuses any
  other commit. So an approval left for later goes away with the next good push.
- **A push during a go-live** reaches staging after the go-live finishes.
- **A push replaces the staging box**, ending any game being tried there.
- **If going live fails**, the new box is removed, so staging is the live version again. The
  approved build can't simply be retried: choose **Release change** in the pipeline to test
  main's latest, put it on staging and ask again.
- The tests run with a role that can't deploy. The approval is a guard against mistakes, though,
  not a security boundary: whoever can push to main can change what the deploy steps do.
- GitHub shows its own tests on each commit. How the pipeline went is in CodePipeline.

## How a deploy works

[deploy.sh](deploy.sh) drives the fleet tool ([fleet.ts](fleet.ts)) for a release that's in S3.
Staging is step 1 alone; going live first checks it's the release that staging shows, then does
all of them:

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
5. If any of those fails or is stopped, **rollback** removes the new box and puts everything back
   on the current one. (A build AWS cuts off without warning can't clean up: check `fleet.ts status`.)

The very first deploy (or one after every box is gone) has no current box: the new box takes
the front door straight away.

Pages loaded from one box ask for that release's files (build files, art, sounds, pictures),
which may come back from another box. So a new box copies in the files it lacks from the release
it replaces, and at the canary step the current box copies in the new release's.

A box from an earlier deploy may still be finishing its games when the next deploy comes; it
keeps its slot, and the new box takes a free one. If all four are taken, the oldest retiring
box stops at once.

## Staging

`staging.<domain>` is the beta site (user, 2026-11-21). The pipeline puts each good push there.
By hand, `bash deploy/deploy.sh <commit>` does the same: a new box with that release, smoke tests
against staging, and it stops there. Staging shows the new box; everyone on the site itself
stays on the current box, and nobody is sent to the new one. Try it on staging from a phone and a
computer, then either:

- **go live:** approve it in the pipeline (or, for a release put there by hand,
  `GO_LIVE=1 bash deploy/deploy.sh <commit>`: a fresh box replaces the staging box, then canary,
  checks and promote as usual), or
- **take it down:** `npx tsx deploy/fleet.ts rollback <commit>`; staging goes back to the
  current box.

A hand staging deploy waits if the pipeline is going live, and closes a waiting approval, just as
the pipeline does. Don't go live by hand while the pipeline is deploying.

Any commit in the releases bucket can go to staging, pushed or not; only push and deploy pushed
commits to the site itself, so GitHub matches what's live. While it's up, the staging box is a
second server (about 1.4¢ an hour), so take it down or go live the same day. It shares the
site's disk and secrets: saved puzzles and logs are the real ones, so testing there shows up on
the admin page, and anything it can do (such as checking photos with Rekognition) needs the same
AWS set-up as the site.

## The fleet tool by hand

From the repo, with the `games-drawer` AWS profile (needs `AWS_REGION` and `LAUNCH_TEMPLATE`, as
the pipeline sets them). The domain and the front door (`direct` while the site runs without
CloudFront) come from `infra/config.json`; `SITE_DOMAIN` and `FRONT_DOOR` may repeat them, and the
tool refuses to run if they disagree. (A wrong front door would be bad: a promote would move only
`origin.`, leaving the site on the old box, which then shuts itself down.)
`bash deploy/deploy.sh <commit>` puts a
release that's already in the bucket on staging, and with `GO_LIVE=1` runs the rest. On Windows (Git Bash), also set
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
  block direct voice connections. Each box runs its own, on its own address. It starts only once
  its config is written, and behind its own firewall ([relay-firewall.sh](relay-firewall.sh)).
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
   its services; the privacy page says we've told it not to. The site's account is an **AWS
   project** (AWS's simpler sign-up, 2026): each project is its own account inside an
   organization the Projects console manages, so the project's owner sets the opt-out in AWS
   Settings: https://settings.aws.com → **Project** → **Overview** → **Actions** → **Opt out of
   data use by AWS AI services** → **Opt out**. It covers every AI service and every project,
   by attaching an AI services opt-out policy to the organization. To check it from the repo,
   `aws organizations describe-effective-policy --policy-type AISERVICES_OPT_OUT_POLICY
   --profile games-drawer` shows the policy (it errors until it's on). Both steps are done for
   the site's account (2026-11-21).

   (An ordinary AWS account does the same from its organization's management account:
   **AWS Organizations** → **Policies** → **AI services opt-out policies** → enable them →
   create a policy with this content and attach it to the root:
   `{ "services": { "default": { "opt_out_policy": { "@@assign": "optOut" } } } }`.)

To turn uploads off, set `PHOTO_CHECK=off` in setup.sh (`pretend` lets every photo through:
only for your own computer and tests). The admin logs show `photo_added`, `photo_refused` (with
what kind of thing the check found) and `photo_check_failed`; never the photo.

## Voice relay (TURN)

Voice chat connects players directly. Some networks (strict routers, some mobile carriers,
work Wi-Fi) block that; those players' audio goes through coturn instead. The box a table is on
hands each player relay credentials for its own coturn, which expire after 24 hours
(`TURN_TTL_SECONDS`), signed with the shared secret. The browser uses them only for a link that
hasn't connected directly within 5 seconds
([voiceRelay.ts](../packages/client/src/voiceRelay.ts)), so a relayed link takes about 6 seconds
to come up and a direct one holds no room on the relay.

**Testing it:** open a private room with `?relay=1` on the end of the URL (for example
`https://<domain>/r/BCDFG?relay=1`) on two phones on cell data. That forces every voice
link through the relay. They should hear each other, and the admin page's Voice section counts
those links as through the relay.

**Firewall:** [relay-firewall.sh](relay-firewall.sh) (nftables, tables `inet gd_relay` and
`netdev gd_relay_bill`) runs before
every start of coturn (setup, reboots, package updates); if it fails, coturn stays off and setup
fails. Three kinds of sender reach the relay, each with limits of its own:

- **members**, who coturn gave a slot, so calls already up don't share a limit with anyone;
- **players**, whose address has a real connection to this box's web server, in their own lane;
- **everyone else**, in a smaller lane, only to ask for their address or a slot.

Someone who gives a slot up stops being a member within seconds. Nothing bigger than one internet
packet gets through either way, and nothing leaves in pieces (voice is never either, and the
spending cap can only count whole packets).

Out of the relay: only other relayed links' audio ports on this box, nothing to private addresses
or over IPv6, and no new TCP connections. Three rules for changing it: limits stay on the way in
(a blocked send makes coturn end that player's call); don't load it while the relay runs (that
forgets who has a slot, so restart coturn instead); and don't take the private half out of
`external-ip` (two relayed ends on one box meet through it).

**Boxed in:** setup.sh also gives coturn a memory limit (it restarts by itself if it gets there),
less CPU than the game when both want it, no privileges, nowhere to write but its database, and a
journal of its own capped at 50 MB and 30 days.

```bash
sudo nft list table inet gd_relay                          # the rules, with what each has dropped
sudo nft list table netdev gd_relay_bill                   # the spending cap
sudo journalctl --namespace gd-relay -u coturn             # the relay's log
systemctl show coturn -p MemoryCurrent -p MemoryPeak -p NRestarts
```

**Limits:** the relay refuses to forward to private and internal addresses (including the AWS
metadata service). It has **40 slots per box** (`total-quota`): 40 relayed links, or six tables of
four where every link needs the relay (a lot more where only some do). A link takes two slots if
Firefox makes it, or if UDP is blocked at the answering end. One household holds at most 18
(`user-quota`). Counted where it leaves the box (the firewall), each slot sends at most 14 KB/s
each way and all of them 620 KB/s, so flat out all month is about 1.6 TB (about $140; the kill
switch stops the boxes at $65). **Don't use coturn's `max-bps` or `bps-capacity` for that:** with
them on it stops answering a long call's renewals, and the call drops. The voice code asks every
browser for mono at 32 kbit/s, which those numbers allow for (voice.ts `speechBitrate`).
When all are taken, further links retry each minute and
the games carry on. More slots means a higher spending ceiling: change the numbers in
[turnserver.conf](turnserver.conf) and deploy. The admin page's Voice section shows how often
voice needs the relay. Public games have no voice, so they get no relay credentials. Networks
that only allow port 443 aren't covered; that would need a second address for the relay.
