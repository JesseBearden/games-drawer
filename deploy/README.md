# Deploys and the game server boxes

How a deploy moves Games Drawer from one server box to the next, and what runs on each box.
Setting up AWS itself is in [infra/README.md](../infra/README.md).

## The shape of it

```
players ──HTTPS──▶ the front door (below) ──▶ any box ──▶ the right box (by table code)
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
  fleet map says ([fleetMap.ts](fleetMap.ts)). So the front door can point at any one box, and
  moving it to a new box never cuts off a game on an old one. A box that's gone (a retired one
  powers itself off, but the others keep its route until the next deploy writes the map) gets
  2 seconds to answer; then the box asked answers itself, so the page hears "this table has
  closed" instead of waiting on nothing. Route changes reload Caddy without dropping anyone's
  open connection (`stream_close_delay`).

## The front door

`"frontDoor"` in [infra/config.json](../infra/config.json) says which:

- **`direct`** (now, as CloudFront isn't enabled on the account yet): the domain's own DNS
  records point at the boxes. Deploys point the domain and `www` at the box taking players and
  `staging` at the newest box. Caddy on each box does HTTPS itself with Let's Encrypt
  ([Caddyfile.direct](Caddyfile.direct)). The certificates live on the shared disk, so a new box
  never asks for new ones (Let's Encrypt allows only a few duplicates a week). A retiring box
  keeps answering anyone whose DNS hasn't caught up yet, passing them on to the new box.
- **`cloudfront`** (for later): CloudFront holds the HTTPS certificate and follows
  `origin.<domain>` to the current box ([Caddyfile.cloudfront](Caddyfile.cloudfront)); boxes
  take web traffic from CloudFront only.

Either way, boxes pass requests to each other on port 8080.

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
  main's latest, put it on staging and ask again. The one exception is the very last step: if the
  new box has taken over but the old box couldn't be told to retire, the release is live and
  nothing is removed; the step fails saying so, and `npx tsx deploy/fleet.ts retire` finishes it.
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
4. **promote**: the new box takes every new table, and the front door's DNS records (one-minute
   TTL) move to it. The old box gets `SIGUSR2`: it finishes the games it has (people stay
   connected the whole time, through any box), passes everything else to the new box, then powers
   itself off once its games are done and at least 15 minutes have passed. It was launched to
   terminate on shutdown, so AWS removes it. (A table can hold a box for at most `DRAIN_MAX_MS`,
   3 hours. Tables still there 10 minutes before then are told to start a new table, and at the
   cutoff they close with that reason, their puzzles saved.) From then on systemd no longer
   restarts its server (one that crashed mid-drain would come back knowing nothing of the drain),
   and the box powers off within 3½ hours whatever its server is doing. If the old box can't be
   told to retire (tried three times), the new release is still live: the step fails saying so,
   and `fleet.ts retire` tells it again.
5. If any of those fails or is stopped, **rollback** removes the new box and puts everything back
   on the current one. (A build AWS cuts off without warning can't clean up: check `fleet.ts status`.)

The very first deploy (or one after every box is gone) has no current box: the new box takes
the front door straight away. If another launch comes before anyone goes live, the box the site
points at stays, as the current box, rather than being removed with the site's games; staging
moves to the new box as usual. A launch never removes a box while staging points at it: staging
moves to the current box first.

Pages loaded from one box ask for that release's files (build files, art, sounds, pictures),
which may come back from another box. So a new box copies in the files it lacks from the release
it replaces, and at the canary step the current box copies in the new release's.

A box from an earlier deploy may still be finishing its games when the next deploy comes; it
keeps its slot, and the new box takes a free one. If all four are taken, the oldest retiring
box stops at once.

## Staging

`staging.<domain>` is the beta site. The pipeline puts each good push there on a new box; only
staging shows it, and everyone on the site itself stays on the current box. Try it from a phone
and a computer, then either:

- **go live:** approve it in the pipeline, or
- **take it down:** `npx tsx deploy/fleet.ts rollback <commit>`; staging goes back to the
  current box.

After a go-live, staging shows the live box; there's no separate staging box until the next push.
While one is up it's a second server (about 1.4¢ an hour), so don't leave it waiting for long. It
shares the site's disk and secrets: saved puzzles and logs are the real ones, so testing there
shows up on the admin page.

## The fleet tool by hand

From the repo, with the `games-drawer` AWS profile. It needs `AWS_REGION`, `SITE_DOMAIN` and
`LAUNCH_TEMPLATE`; the front door comes from `infra/config.json` (`FRONT_DOOR`, if set, must
match). On Windows (Git Bash), also set `MSYS_NO_PATHCONV=1` and `SKIP_BROWSER_INSTALL=1`
(Playwright's `--with-deps` can't run there; the local browser works).

```bash
export AWS_PROFILE=games-drawer AWS_REGION=us-east-2 SITE_DOMAIN=gamesdrawer.com LAUNCH_TEMPLATE=games-drawer-box
npx tsx deploy/fleet.ts status                 # the live boxes, and where the front door points
npx tsx deploy/fleet.ts rollback <commit>      # remove a new box by hand
npx tsx deploy/fleet.ts launch <commit>        # e.g. bring the site back after the kill switch
npx tsx deploy/fleet.ts promote <commit>
npx tsx deploy/fleet.ts retire                 # tell old boxes again to finish their games and shut down
bash deploy/deploy.sh <commit>                 # put a release on staging, as the pipeline does
GO_LIVE=1 bash deploy/deploy.sh <commit>       # take what's on staging live: a fresh box, canary, checks, promote
```

`deploy.sh` takes releases already in the releases bucket: each commit the pipeline put on
staging is kept there for 60 days. Like the pipeline, a hand staging deploy waits while a release
is going live and closes a waiting approval. Don't go live by hand while the pipeline is deploying.

Never deploy a release older than a85fbc8 (the deploy's rollback fix; older ones also lack the
voice relay's firewall). From a git checkout, `launch` refuses one; a box refuses any release
without `deploy/relay-firewall.sh` (for a box's first command, once the stack has been deployed
since: the launch template carries that command).

## What's on a box

[setup.sh](setup.sh) sets each box up, and every deploy re-runs it when it changes:

- **Caddy** ([Caddyfile.direct](Caddyfile.direct), or [Caddyfile.cloudfront](Caddyfile.cloudfront)
  behind CloudFront). The routes (`/etc/caddy/games-drawer-routes.caddy`) come from the fleet map.
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
The boxes' own policy names only that parameter and their shared secrets, but the AWS-managed
Systems Manager policy they also have (`AmazonSSMManagedInstanceCore`) lets them read any
parameter in the account; so keep nothing else secret in this account's Parameter Store. The
admin page on any box adds up every box's logs from the shared disk.

## Counts in CloudWatch

Once a minute each box sends CloudWatch a few numbers, in the `GamesDrawer` namespace
([packages/server/src/metrics.ts](../packages/server/src/metrics.ts), turned on by `METRICS=cloudwatch`
in [setup.sh](setup.sh)):

- `People`: devices at a table (two tabs on one phone are one; a family on one Wi-Fi is several),
  and the same with a `Game` dimension (`lobby` for a table choosing a game).
- `InVoice`, and `OnRelay`: people in voice, and those with a voice link through the relay.
- `DevicesToday`: different devices at a table since midnight UTC. Just after midnight,
  `DevicesPerDay` sends the day that ended, stamped at its noon (any day-long period then holds
  exactly one).

Zeros aren't sent, so a missing minute means nobody. Each box sends one value a minute with no box
name, so a minute's Sum is the whole site even while an old box drains. The smoke tests (their browsers say they're automated) and anyone on the staging site
aren't counted. Only the live site's boxes send anything: one the fleet sends new tables to (a
canary too), or one finishing its games after a deploy. Each box learns which from the fleet map
`route` leaves in `/etc/games-drawer/fleet-map.json`, so a staging box sends nothing.

The **GamesDrawer** dashboard (CloudWatch → Dashboards) shows them. The stack makes it, along with
the boxes' permission to send (`cloudwatch:PutMetricData`, into `GamesDrawer` only), so both need a
`cdk deploy`. A box without the permission plays on as normal and logs `metrics_failed` once an hour.
Only the numbers leave the box; the privacy page says so.

## Your own photos (jigsaw)

People at a table can add their own photo for a jigsaw. The phone shrinks it, the box
checks it with Amazon Rekognition (`DetectModerationLabels`, the photo sent in the request) and
keeps it in memory only until the table closes (packages/server/src/photos.ts). The boxes' role
may call it (infra/lib/stack.ts); if the check can't run, the photo is refused with "couldn't be
checked just now" (never let through unchecked).

**Opt out of AI training** before photos are checked (done for the site's account). By default
AWS may keep pictures sent to Rekognition to improve its services; the privacy page says we've
told it not to. The site's account is an **AWS project**, so the project's owner sets it in AWS
Settings: https://settings.aws.com → **Project** → **Overview** → **Actions** → **Opt out of
data use by AWS AI services** → **Opt out**. (An ordinary AWS account does it from its
organization's management account: **AWS Organizations** → **Policies** → **AI services opt-out
policies** → enable them → create a policy with this content and attach it to the root:
`{ "services": { "default": { "opt_out_policy": { "@@assign": "optOut" } } } }`.) To check it,
`aws organizations describe-effective-policy --policy-type AISERVICES_OPT_OUT_POLICY
--profile games-drawer` shows the policy (it errors until it's on).

To turn uploads off, set `PHOTO_CHECK=off` in setup.sh (`pretend` lets every photo through:
only for your own computer and tests). The admin logs show `photo_added`, `photo_refused` (with
what kind of thing the check found), `photo_check_failed` and `photo_stopped` (Cancel pressed, or
the connection lost, before the answer); never the photo. Each says where the wait went:
`readyMs` (the phone or computer shrinking it, as it reports), `sendMs` (the upload) and `ms`
(the check).

## Voice relay (TURN)

Voice chat connects players directly. Some networks (strict routers, some mobile carriers,
work Wi-Fi) block that; those players' audio goes through coturn instead. The box a table is on
hands each player relay credentials for its own coturn, which expire after 24 hours
(`TURN_TTL_SECONDS`), signed with the shared secret. The browser uses them only for a link that
hasn't connected directly within 5 seconds
([voiceRelay.ts](../packages/client/src/voiceRelay.ts)), so a relayed link takes about 6 seconds
to come up and a direct one holds no room on the relay.

**Testing it:** open a table with `?relay=1` on the end of the URL (for example
`https://<domain>/r/BCDFGH?relay=1`) on two phones on cell data. That forces every voice
link through the relay. They should hear each other, and the admin page's Voice section counts
those links as through the relay.

**Firewall:** [relay-firewall.sh](relay-firewall.sh) (nftables, tables `inet gd_relay` and
`netdev gd_relay_bill`) runs before every start of coturn (setup, reboots, package updates); if it
fails, coturn stays off and setup fails. Three kinds of sender reach the relay, each with limits
of its own:

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
journal of its own capped at 50 MB and 30 days. journald only enforces that when it writes, so a
daily timer (`games-drawer-journal-vacuum`) also closes each journal's file and deletes notes
older than 29 days, from the relay's journal and the main one, even on a quiet month.

```bash
sudo nft list table inet gd_relay                          # the rules, with what each has dropped
sudo nft list table netdev gd_relay_bill                   # the spending cap
sudo journalctl --namespace gd-relay -u coturn             # the relay's log
systemctl show coturn -p MemoryCurrent -p MemoryPeak -p NRestarts
```

**Limits:** the relay refuses to forward to private and internal addresses (including the AWS
metadata service). It has **60 slots per box** (`total-quota`): 60 relayed links, or ten tables of
four, or four of six, where every link needs the relay (a lot more where only some do). A link
takes two slots if Firefox makes it, or if UDP is blocked at the answering end. One household
holds at most 20 (`user-quota`). Counted where it leaves the box (the firewall), each slot sends at
most 14 KB/s each way and all of them 930 KB/s, so flat out all month is about 2.4 TB (about $220; the kill
switch stops the boxes at $65). **Don't use coturn's `max-bps` or `bps-capacity` for that:** with
them on it stops answering a long call's renewals, and the call drops. The voice code asks every
browser for mono at 32 kbit/s, which those numbers allow for (voice.ts `speechBitrate`). When
all are taken, further links retry each minute and the games carry on. More slots means a higher
spending ceiling: change the numbers in [turnserver.conf](turnserver.conf) and deploy. The admin
page's Voice section shows how often voice needs the relay. Networks that only allow port 443 aren't covered; that would need a
second address for the relay.
