# Games Drawer

A place to hang out with friends and play small games: real-time tank battles ("Tank You For
Being A Friend"), Hearts, Spades, Dominoes and a co-op jigsaw puzzle so far, with text and voice chat that keep going between games.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:5173: the home page lists the games, and each has its own page (`/tanks`,
`/hearts`, `/spades`, `/dominoes`, `/jigsaw`). **Play now** on a game's page joins a public game
(Tanks and Jigsaw for now; the others are private rooms only, marked "Under construction");
**Play with friends** opens a private room already playing it. **Start a private room** opens a
lobby where anyone in the room picks the game and can go back to the lobby from the menu. Each
browser tab is a separate player, so two tabs give you a two-player game. To play from a phone on
the same Wi-Fi, open the "Network" URL Vite prints (allow Node through Windows Firewall the first
time).

Game controllers (Xbox, PlayStation, Switch Pro) work through the browser's Gamepad API: the
d-pad and A get around the menus, and each game maps the rest (see `onPad` in the views).

Voice chat (private rooms) is on by default: new players get a prompt, and the choice is
remembered per browser. It needs the microphone, which phones only allow on https pages. To try it
on your network, run `npm run dev:https` and open the https Network URL; accept the certificate
warning once (it is a self-signed development certificate).

```bash
npm test            # simulation, room, security, live-server, deploy-tool and AWS-stack tests
npm run typecheck   # everything
npm run e2e         # build a release and play it in Chrome at desktop and phone sizes
npm run start       # build a release and run it in production mode on :8787
npm run stats       # summarise logs/events-*.jsonl
npm run -s admin-password   # make the admin page's password hash (see "Admin page" below)
npm run dev:https   # dev server over https (needed for voice chat on phones)
```

## Puzzle pictures only for this computer

Family photos can be puzzles without ever being published:

```bash
npm run local-puzzle -- "C:\path\to\photo.jpg" "Wedding day"
```

That saves a copy (upright, standard colours, no camera or location data, at most 2400 px wide)
and a preview in `local-puzzles/` at the top of the repo, and lists it in
`local-puzzles/puzzles.json` (edit a title there; delete a line and its files to remove one).
Git ignores the folder, so it's never committed or deployed. With `npm run dev` running, those
pictures come first in the puzzle picker (reload the page after adding one). Production servers
and builds never look for them.

## Deploying

GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) tests every pull request
and push. Each push to `main` also starts a deploy inside the AWS account (CodeBuild,
[deploy/buildspec.yml](deploy/buildspec.yml)), which launches a new server box with the new version. It shows on staging for smoke
tests, then gets 10% of new tables for 10 minutes. If it stays healthy, it takes all new tables
and the front door (CloudFront); the old box finishes its games and shuts itself down, so a
deploy never cuts anyone off. If it isn't, the new box is removed. The AWS side (CloudFront and
DNS, the boxes' launch template, a shared disk, budgets and a spending kill switch) is code in
[infra/](infra/README.md); how a deploy moves between boxes is in [deploy/README.md](deploy/README.md).

## Adding a game

1. Add it to [packages/shared/src/games.ts](packages/shared/src/games.ts) with `availability: 'private'`,
   so only private rooms can pick it while friends try it. Switch it to `'public'` to give it
   public matchmaking and a Play button on the home page.
2. Rules and bots go in `packages/shared`, the server side in `packages/server/src/games/` (a
   `ServerGame`), and the screen in `packages/client/src/` (a `View`, with `onPad` for
   controllers). Hook the id into
   `makeGame` in `room.ts` and `showGame` in `shell.ts`.

## Layout

- `packages/shared` — game rules (the deterministic tank simulation, Hearts rules and bots) and the
  WebSocket message contract. Runs on the server; the client reuses the terrain and shell code.
- `packages/server` — authoritative Node server. A room (`room.ts`) holds the people, chat and
  voice; the game it's playing (`games/tanks.ts`, `games/hearts.ts`) holds seats and rules. Chat
  filter, abuse limits, JSONL logs. Chat text stays in the room's memory and goes when the table
  closes; the chat log only counts messages, except a reported one, which is saved for review.
- `packages/client` — Vite + TypeScript client. `shell.ts` is the room (chat, voice, menu); the
  lobby, tanks (Canvas 2D) and Hearts (HTML cards) are views it swaps in.
- `e2e/` — browser tests (Playwright) that play the site like people do.
- `deploy/` — deploys: the fleet tool (launches, promotes and retires boxes) and what runs on
  each box (machine setup, Caddy routing between boxes, coturn, the rollout tool).
- `infra/` — the AWS stacks (CDK): CloudFront and DNS, the boxes' launch template, shared disk,
  firewall, budgets, kill switch, deploy access.

## Server settings (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `GAME_PORT` | 8787 | Listen port |
| `NODE_ENV=production` | | Serve the built client, lock down `/stats` |
| `SESSION_SECRET` | random per boot | Signs reclaim credentials |
| `ALLOWED_ORIGINS` | same origin | Comma-separated origins allowed to open sockets |
| `TRUST_PROXY=1` | off | Read client IPs from CloudFront's `CloudFront-Viewer-Address`, else `X-Forwarded-For` (only behind our own Caddy) |
| `STATS_TOKEN` | none | Required as `?token=` for `/stats` in production |
| `EMPTY_ROOM_MS`, `RECLAIM_MS` | 60000 | Shorten to test room expiry and reclaim |
| `MAX_PUBLIC_ROOMS`, `MAX_PRIVATE_ROOMS` | 10 | Room caps |
| `VOICE_ICE_SERVERS` | public STUN | JSON list of STUN servers for voice chat |
| `TURN_URLS`, `TURN_SECRET` | none | Our own voice relay (coturn); players get expiring credentials. See [deploy/README.md](deploy/README.md) |
| `TURN_TTL_SECONDS` | 86400 | How long each player's relay credentials last |
| `GAME_CONFIG` | none | JSON gameplay overrides for playtests, e.g. `{"winLevel":3}` |
| `LIMITS` | none | JSON overrides for the abuse limits in `server.ts`, e.g. `{"privateRoomsPer10Min":50}` |
| `SLOT`, `RELEASE` | none | Set by deploys: this box's slot letter (a-d; its table codes all name it) and its git commit, shown on `/healthz` |
| `DRAIN_MAX_MS` | 3 hours | On `SIGUSR2`, finish games for at most this long, then exit |
| `PUZZLE_DIR` | `./data/puzzles` | Where jigsaw saves go (one small JSON file each; untouched for 90 days, deleted) |
| `ADMIN_PASSWORD_HASH` | none (no admin page) | Turns on `/admin`. A one-way hash from `npm run admin-password`, never the password |
| `ADMIN_LOG_DIRS` | `LOG_DIR` | Comma-separated log folders `/admin` adds up, with the folders directly inside them (one per box on AWS) |

## Admin page

`/admin` shows who's playing what: games ranked by person-hours, how often each has two or more
people at once, chat per hour of play, and a day-by-day table. It's served by the game server
(nothing of it is in the browser bundle), behind a password, and only exists when
`ADMIN_PASSWORD_HASH` is set. Neither the password nor its hash is ever committed: this repo is
public.

- **Locally:** `npm run -s admin-password > .env.local` (type the password; git ignores
  `.env.local`), restart `npm run dev`, then open http://localhost:5173/admin.
- **On AWS:** store the hash in Parameter Store; each deploy fetches it (see
  [deploy/README.md](deploy/README.md#admin-page)).

Each game logs one `game_session` line when it ends (back to the lobby, or the room closing), so a
game still going shows up once it's over. Five wrong passwords from one address (or 30 in total)
lock sign-in for 15 minutes. Signing in lasts a week; changing the password signs everyone out.

Gameplay tunables (fall distance, wind, crater size, collapse rules, ...) are in
`packages/shared/src/config.ts`.

The chat filter is in `packages/shared/src/chatFilter.ts`, shared by the browser (which greys out
Send) and the server (which has the final say). Public rooms block swearing; private rooms choose
None, Hide (****) or Block, and start on Hide. Slurs are blocked everywhere. Add harmless words
that get caught to `ALLOWED_WORDS` there; extra words to block go in `EXTRA_BLOCKED`, or in
`packages/server/blocklist.txt` for a server-only list. Three caught messages in a minute pause
that person's chat for 30 seconds.

Jigsaw pictures are listed in `PUZZLE_IMAGES` in `packages/shared/src/puzzle.ts` and live in
`packages/client/public/puzzles/` (only pictures we own or that are public domain / CC0; credit
them in CREDITS.md). Each puzzle's piece shapes come from a random seed, so every edge is
different but everyone in the room cuts the same pieces.
