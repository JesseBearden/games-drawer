# Plan: scale to zero, and up for a burst

_Written 2026-11-22 (UTC) against commit `58e9f97`. A plan: none of it is built._

> **On hold since 2026-11-21, until the account has CloudFront.** To pick it up again: check
> that CloudFront is verified, re-check the quotas and prices here, then start at
> [phase 0](#phase-0-gates-and-a-throwaway-spike).

How to read the claims in here:

- **Checked**: seen in this repo, in a read-only call to the AWS account, in a test, or in AWS's
  documentation ([sources](#15-sources)).
- **Estimate**: worked out from measured numbers or list prices.
- **To prove**: nobody has run it yet. [Phase 0](#phase-0-gates-and-a-throwaway-spike) does,
  before anything is built on it.

Contents: [Summary](#1-summary) · [What changed since we talked](#2-what-changed-since-we-talked) ·
[Requirements](#3-requirements) · [Design](#4-design) · [Flows](#5-flows) · [Deploys](#6-deploys) ·
[Money](#7-money-and-the-spend-limit) · [Burst size](#8-how-big-a-burst) · [Voice](#81-voice) ·
[Security](#9-security-and-abuse) · [Privacy](#10-privacy) · [Code changes](#11-code-changes) ·
[Phases](#12-phases) · [Risks and fallbacks](#13-risks-and-fallbacks) ·
[Your decisions](#14-your-decisions) · [Sources](#15-sources)

---

## 1. Summary

With nobody playing, no servers run. Landing on the site starts one. A table's six-letter code
says which server it's on, so joining never looks anything up. When servers fill, more start;
when they empty, they stop.

```
                          gamesdrawer.com
browser ──HTTPS/WSS──▶ CloudFront + a small edge function
                         │
                         ├─ pages, art, sounds ─────────▶ S3
                         │
                         ├─ "where can I start a table?"
                         │     a server has room ───────▶ answered at the edge
                         │     none has ────────────────▶ controller Lambda ─▶ starts a Fargate task
                         │
                         └─ ?s=7 (worked out from code) ─▶ server 7: game server + coturn ─▶ EFS
browser ──voice relay (only when needed)────────────────▶ server 7's own IP
```

| | Today | This plan |
|---|---|---|
| Nobody playing | ~$11/month | **~$1/month** |
| 3 hours of play a day | ~$11/month | **~$3–6/month** |
| First table after a quiet spell | instant | **20–45 s** of "Building the table…", less whatever passed since landing (to prove) |
| Tanks players at once, not talking | ~100 after a deploy | **~875** at today's quota, ~2,600 with a quota increase |
| Tanks players at once, all on voice | not measured | **~550–760**, or ~1,600–2,300 (estimate) |
| People at card tables at once, not talking | ~1,200 after a deploy | **~10,000**, or ~32,000 with a quota increase |
| People at card tables at once, all on voice | relay fills after ~1 table | **~1,300–3,800**, or ~3,800–11,000 (estimate) |
| A deploy | new box, DNS moves, 3-hour drain | push an image, flip a pointer, old servers drain |

**Three gates decide whether this works:**

1. **CloudFront must be enabled on the account.** The verification case is still open, and the
   design depends on it.
2. **The edge has to behave as documented:** a function routing a WebSocket to a task, and the
   controller updating the edge's key-value store under this account's region guardrail.
3. **The spend limit has to be handled.** At the limit AWS stops the whole project, and deletes
   its data if nobody acts for 90 days. A "huge burst" is bounded by money before technology.

**Effort (estimate):** 9–14 working sessions in eight phases. Phase 0 costs a few dollars and
changes nothing live.

## 2. What changed since we talked

Checking turned up things that were wrong or missing in what I said in our discussion.

| I said | What's true | So the plan |
|---|---|---|
| Each server gets a public hostname and a wildcard certificate | A CloudFront Function can choose the origin per request. Public hostnames would also add up to 60 s of DNS delay, and a stale record could point at an address someone else now has | One hostname. The edge routes by server number |
| Saves to S3, logs to CloudWatch, EFS goes away | EFS has no hourly charge and Fargate mounts it. Moving off it means rewriting saves, logs and the admin page for no saving | **Keep EFS.** No admin Lambda either |
| The privacy promises still hold | Not by themselves. Logs and puzzles are only deleted while a server runs, and at zero none does. CloudFront also passes traffic through edges outside the US | A daily cleanup task, and a wording change on /privacy |
| Lambda's limit of 5 must be raised before launch | The edge can answer nearly every request without Lambda | Not a launch blocker. Raise it before inviting a crowd |
| API Gateway can be the front door if CloudFront drags on | It can't pass WebSockets through to a game server | CloudFront is a gate, with [fallbacks](#13-risks-and-fallbacks) |
| Bigger tasks raise capacity | Only up to 1 vCPU: each game server is single-threaded | 0.5 vCPU to start, 1 vCPU at most |
| 20 servers hold 5,000–10,000 Tanks players, and 4 vCPUs hold 1,500–2,000 | That was at 100% CPU, with no servers spare for deploys | 2,600–5,250 at 15 live servers, ~875 on 4 vCPUs |
| A 1,000-player evening costs a couple of dollars | True once. A sustained Tanks burst costs far more in bandwidth than in servers, and can reach the spend limit in a day or two | A live spend estimate in the controller |
| The capacity and bandwidth figures were the whole picture | The load test had no audio. Relayed voice costs more bandwidth than Tanks, and coturn's cap reserves room per connection, used or not | [8.1 Voice](#81-voice): lower figures when people talk, relay limits sized per slot, relay bytes in the spend estimate |
| A code's server needs no lookup | **Holds** | Joining is pure arithmetic |
| Six letters make guessing about 4× harder | **Holds**, however many servers run (checked) | No shared guess counter needed |

## 3. Requirements

**Decided in our discussion**

- Zero game servers is the normal state.
- It can grow for a large burst.
- 20–40 s of "Building the table…" is fine.
- A server starts as soon as someone lands.
- The code identifies the server. No code-to-server records.

**Must not regress**

- Tables live in memory on one server for their whole life, and a deploy doesn't end them
  (3-hour drain, 10-minute warning).
- Voice is peer to peer, with our own STUN and TURN. No third party sees players.
- Logs and saved puzzles are deleted after 30 days.
- `staging.gamesdrawer.com` stays the beta site.
- Slow rollouts stay possible (canary share, automatic rollback).
- `npm run dev` keeps working with no AWS and no Docker.
- Spending has a ceiling.

**Not in scope:** accounts or a database, more than one region, moving a running table between
servers, surviving a server crash without losing its tables (true today too).

## 4. Design

### 4.1 Pieces

| Piece | Job | Idle cost |
|---|---|---|
| CloudFront, one distribution | HTTPS for the site, `www` and `staging`, and WebSockets | free tier |
| CloudFront Function + key-value store | Route by server number, answer "who has room", serve the right release's pages | free tier |
| S3 site bucket | Pages, hashed assets, art, puzzles, sounds (51 MB) | pennies |
| Controller Lambda | The only thing that starts servers and writes the registry and key-value store | free tier |
| DynamoDB registry | 20 rows, one per server number, plus counters | free tier |
| ECS cluster, standalone Fargate tasks | One task is one server: game container plus coturn container | $0 |
| EFS (existing) | Saved puzzles, logs | pennies |
| ECR | The two images | pennies |
| EventBridge | "Task stopped" events, a 5-minute reconcile, the daily maintenance task | pennies |
| Parameter Store (existing) | Secrets, plus the origin certificate | free |
| Route 53 (existing) | The zone. Deploys and servers never change it | $0.50 |

No load balancer, NAT gateway, ECS service or Lambda@Edge. The first two bill while idle, a
service fights scale to zero, and Lambda@Edge isn't available on this kind of account.

### 4.2 Table codes

- Six letters from the same 20 consonants, `BCDFGHJKLMNPQRSTVWXZ`.
- **Server = the sum of the letters' positions, mod 20.**
- A server makes a code by drawing five random letters, choosing the sixth so the sum lands on its
  own number, and drawing again on a collision.
- Checked over all 64,000,000 codes: exactly 3,200,000 per server (today: 800,000 per slot).
- Shown as `BCD FGH`. Typing accepts spaces and either case.
- Five-letter codes keep today's rule (sum mod 4 gives a box) until the boxes are gone, so the
  length alone says which world a table is in.

```ts
export const SERVER_COUNT = 20;

export function serverOfCode(code: string): number {
  let sum = 0;
  for (const c of code) sum += ROOM_CODE_ALPHABET.indexOf(c);
  return sum % SERVER_COUNT;
}

export function codeForServer(server: number, randomInt: (n: number) => number): string {
  const d = Array.from({ length: 5 }, () => randomInt(20));
  const sum = d.reduce((a, b) => a + b, 0);
  d.push((((server - sum) % 20) + 20) % 20);
  return d.map((i) => ROOM_CODE_ALPHABET[i]).join('');
}
```

`SERVER_COUNT` is part of the code format, so it is fixed from launch. How many of the 20 may run
is a setting. More than 20 would mean a seventh letter, again told apart by length.

### 4.3 The edge

The client puts `?s=<server>` on every request that belongs to a table: `/ws`, `/api/table`,
photo upload and photo fetch. One small function (10 KB limit) runs on viewer requests:

| Request | What the function does |
|---|---|
| `www.` host | Redirect to the bare domain |
| Pages (`/`, game pages, `/r/CODE`, `/privacy`, `/rules`) | Rewrite to that page in the live, canary or staging release |
| `/assets/*` | No function. S3, cached for good |
| `POST /api/play` | If a server of that channel and release has room, answer `{server: 7}`. If one is starting, answer `{state: "starting"}`. Otherwise pass through to the controller |
| Table requests with `?s=7` | Look up `server:7`, set the origin to that task |
| The same, with no such server | Answer "closed" at the edge, without touching a server |
| Requests with `?slot=` | The box origin, until the boxes are retired |
| `/admin` | The lowest-numbered live server, or a small page that starts one and reloads |
| `/stats` | 404 |

The key-value store holds only this:

```
live        {"release":"<sha>","canary":{"release":"<sha>","percent":10}}
staging     {"release":"<sha>"}
server:7    {"host":"ec2-…us-east-2.compute.amazonaws.com","release":"<sha>","channel":"live","room":true}
starting    {"live:<sha>":<expires at>}
paused      false
```

It is written only when a server's state changes, and spreads to the edges in a few seconds.

**Reaching a task.** Each task has a public IP. The VPC already has DNS hostnames on (checked), so
that IP has an `ec2-…compute.amazonaws.com` name that works at once, with no record to create. The
function calls `updateRequestOrigin` with:

- `domainName`: that name
- `sni` and `allowedCertificateNames`: `origin.gamesdrawer.com`
- `hostHeader`: the host the player used
- a 2 s connection timeout and one attempt

The certificate name check matters. Public IPs get reused by other AWS customers, and a stale
entry must fail the TLS handshake rather than hand a stranger our players' traffic.

**The origin certificate.** ACM's exportable public certificates are blocked on this account
(checked: explicit deny). So the daily maintenance task gets one from Let's Encrypt for
`origin.gamesdrawer.com` by DNS-01, keeps it in Parameter Store, and renews at two-thirds of its
life rather than on a fixed day count: lifetimes drop to 64 days in February 2027 and 45 in 2028.
A failed renewal emails the existing alert address.

### 4.4 A server

One Fargate task: ARM, **0.5 vCPU and 1 GB**, platform 1.4 or later, with a public IP.

- **`game` container:** a pinned `node:24` slim or Alpine base plus `server.mjs` (about 500 KB).
  Client files are not in the image, which keeps the pull small.
  - Runs as uid 1500, the owner of the EFS files.
  - Serves HTTPS itself on 8443. No Caddy.
  - Bundled server, start to healthy: 133–145 ms on the development PC (checked).
- **`coturn` container:** today's `turnserver.conf`. It waits for the game container to write
  the task's public IP, which the controller returns on "ready". The stock image's own IP
  detection asks an outside service, which the privacy page rules out.
- **Firewall:** 8443 only from CloudFront's origin-facing prefix list, 3478 and the relay's port
  range from anywhere, EFS only from the tasks. The range needs a port per relay slot, so
  today's 201 ports won't do ([8.1](#81-voice)).
- **Subnets:** add a second, with its own EFS mount target (no hourly charge), so one zone
  running out of Fargate capacity can't block every start.
- **Permissions:** Rekognition's moderation call and invoking the controller. Not ECS, DynamoDB,
  the key-value store or Route 53.
- **Console output and coturn's log:** CloudWatch Logs, 30-day retention.

### 4.5 The registry and the controller

One DynamoDB row per server number:

```
server, state (free|starting|ready|draining|cooling), epoch, taskArn,
host, release, channel, load, startedAt, seenAt, freedAt
```

No codes, names, players or addresses of players. The controller is invoked four ways:

| By | For |
|---|---|
| CloudFront, for `POST /api/play` | Start a server when none has room |
| A server, every 30 s and on a change | `ready`, load and error counts, "may I stop?". The reply carries "drain" and the day's remaining photo allowance |
| ECS "task stopped" events | Free the number, remove the edge entry |
| A 5-minute schedule | Reconcile with what ECS says is running |

- **Claiming a number** is a conditional write, so two simultaneous starts can't take the same
  one. The least recently used free number wins.
- **A freed number rests 2 minutes**, for edge entries to clear.
- **Every report carries the launch's `epoch`**, so a server on its way out can't overwrite the
  one that replaced it.
- **A missed heartbeat alone never kills a server.** ECS decides what is running. Otherwise a
  Lambda throttle would end everyone's games.

### 4.6 Scaling

| Rule | Starting value |
|---|---|
| Full: no new tables | 60% of the task's CPU over 30 s (game and coturn together), 80% memory, 80% of relay slots, or 150 tables |
| Start the next server | the fullest one passes 40%, and no other has room |
| Placement | pack the fullest server that has room, so the others can empty (and public Tanks players meet) |
| Live servers | at most 5 until the quota rises, then at most 15 |
| Numbers kept back | 5 of the 20, for draining and staging |
| Idle stop | 10 minutes with no tables and no connections |
| A server started by a visit and never used | stops after 5 minutes |
| Starts from visits alone | 40 a day, then only Start a table starts one |
| Recycle | drain after 24 hours, ahead of Fargate's own retirement of standalone tasks |

Admission stops at 60% because tables grow afterwards: people join, and a card table can switch
to Tanks. Section 8 assumes servers settle at about 70%.

## 5. Flows

**Landing**

1. The page loads from S3 through CloudFront.
2. After a second of being visible it posts `/api/play` with "warm up". Crawlers that don't run
   scripts never do.
3. If nothing is running, the controller claims a number and calls `RunTask`.

**Start a table**

1. Tap. The mic prompt and audio unlock happen now, while it's still a tap.
2. `/api/play` answers with a server, or "starting". While starting, the page shows "Building the
   table…" and asks again every 2 s (answered at the edge). After 90 s it offers Try again.
3. `wss://gamesdrawer.com/ws?s=7`. The server creates the table and its code.
4. If the server filled in the meantime, it says so and the page asks again, excluding 7.

**Join, or reconnect**

1. The code gives 7. The preview is `/api/table?code=…&s=7` and the socket is `/ws?s=7`.
2. No Lambda and no registry.

**The server is gone**

| Case | What the player gets |
|---|---|
| No edge entry | The edge answers the table lookup with "closed" |
| The number was reused | The new server doesn't have the table, so "closed" |
| A WebSocket fails with no message (browsers hide the status) | After two failures the page asks `/api/table`. "Closed" is final, a 5xx keeps retrying |
| A crash, entry not yet cleared | Retries until the stop event clears it, then "closed" |

**Stopping**

1. The server asks the controller if it may stop.
2. The controller marks it draining and removes it from "has room".
3. The server waits 15 s for the edge to catch up. A table that slipped in is played out.
4. It closes cleanly, the task exits, and the number cools.

On SIGTERM it has at most 120 s (Fargate's maximum), so it closes tables with the update message
and saves. A long drain is never done through SIGTERM.

**Cold start, piece by piece (estimate, to prove)**

| Step | Seconds |
|---|---|
| Controller, including its own cold start | 1–2 |
| Fargate assigns capacity and a network interface | 10–20 |
| Pull both images (aim: under 100 MB in all) | 4–12 |
| Mount EFS, start Node | 2–5 |
| Report ready, entry reaches the edge | 3–6 |
| **Total** | **20–45** |

## 6. Deploys

1. Typecheck and tests, as today.
2. Build the client and upload it: hashed files to shared `/assets/`, pages to
   `releases/<sha>/`. The per-game and invite link-preview tags that the server fills in today
   are written at build time.
3. Build the image, push it, register a task definition for that commit.
4. Point `staging` at the commit and run the smoke tests there. That starts a staging server,
   which also proves cold start on every deploy. **Staging-only stops here.**
5. Canary (optional, 10%): pages go out by percentage, and `/api/play` keeps a page on servers of
   its own release. Error counts from heartbeats roll it back. With few players this proves
   little, so the default is smoke tests, then live.
6. Flip `live`. Servers on older releases hear "drain" within 30 s: no new tables, the existing
   3-hour limit and warning, then exit.

**Rollback** is the pointer flipped back. No DNS, box or certificate is involved.

- Images can be built in CodeBuild (its quota case is still open) or from the PC without Docker,
  which isn't installed there, using `crane` to add the bundle as a layer. That tool is a download
  to approve, and its Windows-to-ARM path is to prove.
- The controller starts only the live, canary or staging commit, never one a request names.
- The site bucket gets **no age-based expiry**: two quiet months would delete the live site.
  Deploys prune all but the last 10 releases.
- A change of `PROTOCOL_VERSION` still cuts new pages off from old tables, as it does today. Make
  them rarely, and not during the cutover.

## 7. Money and the spend limit

### Running costs (estimate, Ohio list prices)

A 0.5 vCPU, 1 GB ARM server is $0.0198/hour plus $0.005 for its IP: **2.5¢/hour**, billed by
the second with a 1-minute minimum.

| Per month | Today | Nobody playing | 3 h/day | Someone on around the clock |
|---|---|---|---|---|
| Servers | $6.13 | $0 | $2.60 | $18.07 |
| Public IP | $3.65 | $0 | included | included |
| Server disk | $0.96 | $0 | $0 | $0 |
| Route 53 | $0.50 | $0.50 | $0.50 | $0.50 |
| EFS, S3, ECR, logs, daily task | ~$0.10 | ~$0.20 | ~$0.20 | ~$0.20 |
| Servers started by visits that don't play | n/a | $0 | up to $2.50 | n/a |
| **Total, before tax** | **~$11.30** | **~$0.70** | **~$3.30–5.80** | **~$18.80** |

Voice adds nothing here at family scale: four people talking 3 hours a day, with every link
relayed, is about 29 GB a month, inside the 100 GB that's free ([8.1](#81-voice)).

Around-the-clock use costs more than today. Above roughly 14 hours of play a day, one always-on
box is cheaper.

### The spend limit

The account is a paid-plan AWS project. The project notes say it has a $75 limit: confirm in AWS
Settings. From AWS's documentation:

- **At the limit,** AWS pauses the project and stops everything. It stays down until the limit
  is raised. **After 90 days without action, the project's data is deleted.**
- **"Pause top cost drivers"** (optional, about 4 days early) can pause Lambda. With no
  controller, nothing can scale up from zero. **Leave it off.**
- **"Stop new resource launches"** (optional, about 7 days early) blocks `ec2:RunInstances`,
  which would break today's deploys. Its published policy doesn't block `ecs:RunTask`.

### Guardrails

1. **Server cap** in the controller. Five servers are $3 a day.
2. **A live spend estimate.** Servers report hours, bytes sent and bytes relayed by coturn, and
   the controller stops starting servers at a monthly figure (suggest $50). AWS's billing data lags by hours, too
   slow for a burst.
3. **Kill switch at $65, rewritten.** It sets `paused`, stops the game tasks, and disables the
   distribution, since a request flood bills CloudFront with no server running. The daily
   maintenance task keeps running (about 3¢ a month), or the 30-day deletion promise would break
   exactly when nobody is looking. Today's version only stops EC2 boxes.
4. Today's budget emails, unchanged.

## 8. How big a burst

Per person, measured on the live box's kind of CPU on 2026-11-21 (game server plus Caddy): Tanks
0.2% of a core, nonstop Jigsaw 0.28%, at a card table 0.016%. **None of that includes voice**
([8.1](#81-voice) adds it). These assume servers at 70%, and that
a Fargate ARM core matches. Both are to prove.

| Setup | Fargate quota needed | Tanks | Busy Jigsaw | Card tables | Servers, per day |
|---|---|---|---|---|---|
| 5 live at 0.5 vCPU | 4 vCPU (**what the account has**) | ~875 | ~620 | ~10,000 | $3 |
| 15 live at 0.5 vCPU | 12 vCPU | ~2,600 | ~1,900 | ~32,000 | $9 |
| 15 live at 1 vCPU | 24 vCPU | ~5,250 | ~3,750 | ~65,000 | $16 |

On today's quota a deploy at full load has room for only three replacement servers beside five
draining ones (8 half-cores in all), so deploy at quiet times until it's raised.

The card figures are CPU arithmetic. Connection and memory limits at that size are untested, and
the 150-table admission limit has to rise to reach them.

**Bandwidth is the real bill for Tanks.** A player receives about 6 KB/s, or 21 MB an hour.
CloudFront's free 1 TB is about 47,000 player-hours, then about $85 a TB in North America. At
2,600 Tanks players around the clock that is 1.3 TB a day: the free tier is gone on day one and
each later day is over $100. Card tables cost next to nothing until people talk and some of
that audio is relayed.

So a very large burst needs three things, agreed beforehand: the quota, a higher spend limit,
and smaller Tanks traffic (the code review's batching work, worth 35–50%). With voice it also
needs the relay work below.

### 8.1 Voice

**How it's tied to a task.** Each task runs a coturn, and a table's players get credentials for
the one on their task. Audio is a mesh: each of four people has a link to each of the other
three, so a full table is 6 links and 12 one-way streams. A link that connects directly sends
no audio through AWS. A link that can't goes through that task's coturn, out of the task's own
public IP. It can't use CloudFront or its free terabyte. A server with a table doesn't stop, so
a drain doesn't cut off voice early.

**Measured 2026-11-21**, with our client in Chrome, a fake mic, and a counting test relay on
the development PC:

| | 2 people | 3 people | 4 people |
|---|---|---|---|
| Relay slots held when every link is **direct** (internet-like delay) | 4 | 10 | 18–22 |
| Relay slots held when every link is relayed | 4 | 12 | 24 |
| Sent out by the relay when every link is relayed | 14.8 KB/s (53 MB/h) | about 44 KB/s | 88.3 KB/s (318 MB/h) |

One relayed stream is 7.4 KB/s on the wire and 51 packets a second. The three-person relayed
column is worked out from that. The other figures are measured.

**The cap counts reservations, not audio.** Each browser connection opens a relay slot over UDP
and one over TCP, and keeps them after the link connects directly. coturn 4.6.1 sets aside
`max-bps` from `bps-capacity` for each slot as it opens (checked in its source). At 16,000 and
300,000 that is **19 slots in all**, about one full table. With that cap, one table of four
connected directly left a relay-only pair at another table unable to connect, with no error on
screen. Without the cap the same pair connected.

A server taking 150 tables would need up to 3,600 slots, each with a port. So, before phase 5:

1. Ask for relay slots only when a link needs one (retry with the relay after the direct
   attempt fails), or at least only one slot per connection.
2. Size `bps-capacity`, `total-quota` and the port range in slots, from the admission limit.
3. Admit tables by free slots as well as CPU.
4. Cap money by relayed bytes in the controller, since a slot limit that large is no cost ceiling.

**Bandwidth.** Ohio charges $0.09/GB after 100 GB a month that's free across the account
(checked). The share of links needing the relay is a guess: 20% here for planning, and 0 of the
6 links logged on the live site so far.

| | 20% of links relayed | All relayed |
|---|---|---|
| Per person talking, per hour, at tables of four | 16 MB | 79 MB |
| Compared with a Tanks player's 21 MB | 0.8 times | 3.8 times |
| Person-hours in the free 100 GB | ~6,300 | ~1,260 |
| 1,000 people talking around the clock, per day, after that | ~$34 | ~$172 |

When both ends of a link are relayed, AWS may also bill the hop between the two slots through
the public IP (about $0.02/GB).

**CPU (estimate, to prove).** At 20% relayed, a person talking is about 61 packets a second
through coturn. At a guessed 5–20 µs a packet that adds 0.03–0.12% of a core per person. That is
small beside Tanks and 2–8 times what a card player costs:

| Everyone on voice, 20% relayed | 5 live at 0.5 vCPU | 15 live at 0.5 vCPU | Without voice, 5 live |
|---|---|---|---|
| Tanks | ~550–760 | ~1,600–2,300 | ~875 |
| Busy Jigsaw | ~440–560 | ~1,300–1,700 | ~620 |
| Card tables | ~1,300–3,800 | ~3,800–11,000 | ~10,000 |

**Quotas (checked)**

| Quota | Now | Ask for | When |
|---|---|---|---|
| Fargate on-demand vCPU | 4 | 12 | before the burst test |
| Lambda concurrent executions | 5 | 1,000, the standard default | before inviting a crowd |
| CloudFront | not verified | verified | gate |
| CodeBuild small builds | case open | 2 | before automatic deploys |

With 5 concurrent executions the controller handles about 50 requests a second. That is enough
because the edge answers everything else, but a flood could starve the kill switch. At 1,000,
reserve capacity for both.

## 9. Security and abuse

| Risk | Handling |
|---|---|
| Stale edge entry to a reused IP | Certificate name check, plus removal on the stop event |
| Someone else's CloudFront pointed at our tasks | A secret origin header, rejected if absent. Only then is `CloudFront-Viewer-Address` believed |
| Invoking the controller directly | Function URL with IAM auth, reachable only by this distribution (origin access control) |
| Other sites triggering starts | `/api/play` needs `x-amz-content-sha256` (Lambda origin access control requires it on a POST anyway), so cross-site calls fail preflight |
| Bots keeping servers warm | Script and visibility required, the daily cap on visit starts, the 5-minute stop, the server cap |
| Guessing codes | Six letters. The per-server limit is enough: spreading tables over k servers multiplies tries and divides hits equally (checked for 1, 5 and 20) |
| IPv6 dodging per-address limits | Key on the /64. CloudFront brings IPv6, which the boxes don't have today |
| In-memory limits multiply by servers and reset on each start | Move the photo check's 300/day to the controller, because each check costs money. Admin goes to the lowest-numbered server. The rest are bounded by the server cap |
| A compromised game server | Its role can't start tasks, change routing or touch DNS. The origin key is valid only for the origin name |
| WAF | Not available with CloudFront on an AWS project. Caps and the kill switch stand in |

## 10. Privacy

Change `/privacy` and its date in the same commit as each change.

| Promise | Effect |
|---|---|
| Logs deleted after 30 days | **Breaks at zero without work.** The daily task runs the pruning, and CloudWatch groups expire at 30 days |
| Saved puzzles deleted after 30 days | Same: the daily task runs the sweep |
| Only AWS, "in the United States" | Still only AWS, but traffic passes CloudFront's North American and European edges. Reword: the servers and what's kept are in the US |
| Our own relay | Unchanged. coturn runs beside each server |
| Internet addresses only used for a moment | The registry holds none. CloudFront access logs stay off, and the controller never logs them |
| Photos in memory only | Unchanged. The check's credentials change, not what's sent |
| No cookies | Unchanged |

Let's Encrypt sees only the origin's hostname, never player traffic, and needs no contact email.

## 11. Code changes

**Shared**

- `serverOfCode`, `codeForServer`. `isRoomCode` and `normalizeRoomCode` accept 5 or 6 letters.
  Today's `normalizeRoomCode` silently cuts a sixth letter off (checked).
- One helper that builds table URLs, so none can forget its routing parameter.

**Client**

- `net.ts`: `?s=`, the "closed?" lookup after two silent failures.
- `main.ts`: warm-up, "Building the table…", six-letter entry and display.
- Photo upload and `photoUrl` (`packages/shared/src/photoUrls.ts`) through the helper. Getting
  `?slot=` onto them for today's boxes is a separate fix, outside this plan.
- `voice.ts`: relay slots on demand ([8.1](#81-voice)).

**Server**

- A lifecycle module: ready, heartbeat, drain, may-I-stop, recycle.
- HTTPS from a provided certificate, the origin-header check, `/64` keys.
- `photoCheck.ts` reads credentials from EC2's metadata service only (checked). It needs the ECS
  container credentials endpoint too.
- `--maintenance`: prune logs, sweep puzzles, renew the certificate, exit.
- EFS reads and writes off the event loop. It's on the review backlog, and a half-core server
  feels it more.
- Error counts, bytes sent, relayed bytes and slots in use in the heartbeat.

**Infrastructure**

- A new stack for the cluster, task definition, registry, controller, schedules, ECR and site
  bucket. The edge construct grows behaviours, the function and the store.
- The ECS service-linked role, which doesn't exist yet (checked).
- The kill switch rewrite.

**Retired in phase 7:** `fleet.ts`, `fleetMap.ts`, `rollout.ts`, `setup.sh`, both Caddyfiles, the
systemd unit, `games-drawer-deploy`, the launch template, slots.

**Unchanged:** game rules, rooms, voice signalling, saves, logs, the admin page, local
development (one server, number 0, no edge or controller).

**Tests**

- Code functions over every server number.
- The edge function as a pure function against a table of requests.
- The controller against a fake cloud, as `fleet.test.ts` does: races, stale epochs, cooling,
  caps, pause.
- Lifecycle with fake timers.
- e2e through a small local stand-in for the edge, including a cold start and a vanished server.

## 12. Phases

Each ends at a point that's safe to stop at.

| Phase | What | Sessions | Live site changes? |
|---|---|---|---|
| 0 | Gates and a throwaway spike | 1–2 | no |
| 1 | Fixes useful on the boxes anyway | 1–2 | normal deploy |
| 2 | CloudFront and S3 in front of the boxes | 1–2 | yes |
| 3 | The server as a task | 1–2 | no |
| 4 | Controller and routing, on staging | 2 | staging |
| 5 | Cutover | 1 | yes |
| 6 | Burst proof | 1 | no |
| 7 | Remove the boxes | 1–2 | no |

### Phase 0: gates and a throwaway spike

- You: confirm the spend limit and its optional controls, and chase the CloudFront case.
- Build under a separate `spike` stack, with a hello-world WebSocket server. Delete it afterwards.

| To prove | Pass mark |
|---|---|
| Update the key-value store from a Lambda in Ohio | Succeeds. Its SigV4a signing is the risk: the permission simulator allows region `us-east-1` and denies `*` |
| Visible at the edge | within 10 s, 19 of 20 times |
| WebSocket through `updateRequestOrigin`, with `sni` and `allowedCertificateNames` | connects, and holds for 2 hours with pings |
| Wrong certificate at the origin | refused (502) |
| Dead origin | fails within 3 s |
| Cold start, tap to welcome, 20 runs at different hours | 18 of 20 within 40 s (the agreed wait), median within 30 s |
| Tanks on 0.5 vCPU, 100 players | late ticks under 0.1%, response time within 20 ms of today's |
| EFS from a task as uid 1500 | reads and writes existing saves |
| coturn in a task, two phones on cell data with `?relay=1` | "(relayed)", audio both ways |
| coturn's CPU at 500 and 2,000 relayed streams of 51 packets a second | under 20 µs a packet, or redo [8.1](#81-voice) |
| Relay slots a real iPhone and Android hold on cell data | recorded: Chrome on a PC holds up to 2 a connection |
| Image built from the PC | runs on ARM |

**Stop here** if the key-value store, the WebSocket or the cold start fails, and choose from
[the fallbacks](#13-risks-and-fallbacks).

### Phase 1: fixes useful on the boxes anyway

- EFS off the event loop. `/64` keys. The credential provider. Relay slots on demand, and limits
  sized in slots.
- **Done when:** ten full tables on voice leave room for a pair that can only use the relay.

### Phase 2: CloudFront and S3 in front of the boxes

- Flip `frontDoor` to `cloudfront` at a quiet time (already built), then move pages and files to
  S3 with the release pointer. Update the privacy wording.
- **Done when:** a table and voice survive a deploy, and previews are right in a text message.
- **Undo:** `frontDoor: direct`, deploy.

### Phase 3: the server as a task

- Image, task definition, HTTPS, certificate renewal, coturn, the maintenance task.
- **Done when:** a hand-started task plays every game under a test hostname, and a maintenance
  run deletes a planted 31-day-old file.

### Phase 4: controller and routing, on staging

- Registry, controller, edge routing, six-letter codes, the waiting screen, staging deploys.
- **Done when:** staging goes from zero to playing and back to zero by itself for three days,
  and a phone and a computer pass the checklist.

### Phase 5: cutover

- An `engine` switch in the key-value store sends a share of **new** tables to tasks: 10%, then
  100%.
- Five-letter tables keep reaching the boxes through `?slot=` until they end.
- **Done when:** a week at 100% with no unexplained errors and costs as estimated.
- **Undo:** the switch back. The boxes stay deployable until phase 7.

### Phase 6: burst proof

- Quota increases. Load test on staging from zero to the cap. Drill the kill switch, the spend
  estimate and a deploy under load.
- Include voice in the test, with a share of players forced onto the relay.
- **Done when:** sections 8 and 8.1 hold within 25%, or are corrected.

### Phase 7: remove the boxes

- Delete what section 11 lists, rewrite both READMEs, drop five-letter codes.
- **Done when:** an idle week bills under 50¢.

## 13. Risks and fallbacks

| If | Then |
|---|---|
| CloudFront stays blocked | Do phases 1 and 3 and wait. The alternative, a public hostname per server with a wildcard certificate, works but adds DNS delay, dangling-record care, cross-origin rules and a separate static host. Not recommended |
| The key-value store can't be written | Pre-create `s0`–`s19.origin.gamesdrawer.com`. The function computes the name from the number and needs no store for routing. Only CloudFront resolves them, and the certificate check still protects reuse. Costs up to 60 s more cold start while Route 53 spreads |
| Cold start is too slow | Smaller or zstd images, then 1 vCPU, then a warm server during set hours (~2.5¢/hour) |
| Half a core stutters in Tanks | 1 vCPU and 2 GB, 4.5¢/hour |
| Fargate has no capacity | The controller retries in the other subnet. The page offers Try again |
| A host fails or a task is retired | That server's tables are lost, as with a box today. The daily recycle avoids most retirements |
| The project's guardrails block something else | "Advanced features" lifts them, but **can't be undone and removes the spend limit**. Last resort |
| It's too much machinery for the traffic | Stop after phase 2: free bandwidth and a steady front door, on one box |

**Considered and not chosen**

- **API Gateway WebSockets + Lambda:** no 60 Hz simulation, per-message charges, a rewrite.
- **Load balancer:** about $16–20/month while idle.
- **EC2 started on demand:** cheaper per hour, but images to maintain, and burstable boxes start
  with no CPU credits.
- **Fargate Spot:** a 2-minute eviction ends games.
- **A code-to-server table:** the code already says it.

## 14. Your decisions

| Decision | Recommendation | Needed by |
|---|---|---|
| Run phase 0 (temporary AWS resources, a few dollars) | Yes, once CloudFront is verified | phase 0 |
| Spend limit | Keep $75 for now, "Pause top cost drivers" off | phase 0 |
| Download `crane`, or wait for CodeBuild | CodeBuild if its case clears first | phase 0 |
| Stop starting servers at an estimated spend of | $50/month | phase 4 |
| Canary by default | No: smoke tests, then live, with canary available | phase 5 |
| How much relayed voice to pay for in a burst | Count it in the $50 figure | phase 4 |
| Budget for a planned big share (a Facebook or LinkedIn post) | Decide beforehand, along with the quota | phase 6 |

## 15. Sources

AWS project accounts

- [Supported services](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html)
- [Regions](https://docs.aws.amazon.com/accounts/latest/reference/project-regions.html)
- [Guardrail policies](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html)
- [Spend limits](https://docs.aws.amazon.com/accounts/latest/reference/create-spend-limit.html)
- [Advanced features](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html)

CloudFront

- [Changing the origin in a function](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html)
- [WebSockets](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)
- [Quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)
- [Key-value store, and how fast it spreads](https://aws.amazon.com/blogs/aws/introducing-amazon-cloudfront-keyvaluestore-a-low-latency-datastore-for-cloudfront-functions/)
- [Lambda origins and origin access control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)
- [Pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go)

Voice

- [coturn 4.6.1, how `bps-capacity` is reserved](https://github.com/coturn/coturn/blob/4.6.1/src/apps/relay/netengine.c) (`allocate_bps`)
- [EC2 data transfer pricing](https://aws.amazon.com/ec2/pricing/on-demand/)

Fargate, Lambda, DNS, certificates

- [Fargate pricing](https://aws.amazon.com/fargate/pricing/), with Ohio's ARM rates from [vmprices](https://vmprices.com/serverless/fargate/)
- [Fargate networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html)
- [Task definition limits, including the 120 s stop](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
- [Task retirement](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-maintenance.html)
- [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [Route 53 propagation](https://docs.aws.amazon.com/Route53/latest/APIReference/API_ChangeResourceRecordSets.html)
- [Let's Encrypt lifetimes](https://letsencrypt.org/2025/12/02/from-90-to-45)
- [crane append](https://github.com/google/go-containerregistry/blob/main/cmd/crane/recipes.md)
