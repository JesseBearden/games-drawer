# Games Drawer

A place to hang out with friends and play small games: real-time tank battles ("Tank You For
Being A Friend") and Hearts so far, with text and voice chat that keep going between games.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:5173. **Play** drops you into a public tank battle; bots fill the room (4 tanks),
so you can play alone. **Create private room** opens a lobby where anyone in the room picks the game
(Tanks or Hearts) and can go back to the lobby from the menu. Each browser tab is a separate player,
so two tabs give you a two-player game. To play from a phone on the same
Wi-Fi, open the "Network" URL Vite prints (allow Node through Windows Firewall the first time).

Voice chat (private rooms) needs the microphone, which phones only allow on https pages. To try it
on your network, run `npm run dev:https` and open the https Network URL; accept the certificate
warning once (it is a self-signed development certificate).

```bash
npm test            # simulation, room, security and live-server tests
npm run typecheck   # all packages
npm run start       # production build served by the game server on :8787
npm run stats       # summarise logs/events-*.jsonl
npm run dev:https   # dev server over https (needed for voice chat on phones)
```

## Layout

- `packages/shared` — game rules (the deterministic tank simulation, Hearts rules and bots) and the
  WebSocket message contract. Runs on the server; the client reuses the terrain and shell code.
- `packages/server` — authoritative Node server. A room (`room.ts`) holds the people, chat and
  voice; the game it's playing (`games/tanks.ts`, `games/hearts.ts`) holds seats and rules. Chat
  filter, abuse limits, JSONL logs.
- `packages/client` — Vite + TypeScript client. `shell.ts` is the room (chat, voice, menu); the
  lobby, tanks (Canvas 2D) and Hearts (HTML cards) are views it swaps in.
- `deploy/` — notes and config for hosting, including the voice relay.

## Server settings (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `GAME_PORT` | 8787 | Listen port |
| `NODE_ENV=production` | | Serve the built client, lock down `/stats` |
| `SESSION_SECRET` | random per boot | Signs reclaim credentials |
| `ALLOWED_ORIGINS` | same origin | Comma-separated origins allowed to open sockets |
| `TRUST_PROXY=1` | off | Read client IPs from `X-Forwarded-For` (only behind our own Caddy) |
| `STATS_TOKEN` | none | Required as `?token=` for `/stats` in production |
| `EMPTY_ROOM_MS`, `RECLAIM_MS` | 60000 | Shorten to test room expiry and reclaim |
| `MAX_PUBLIC_ROOMS`, `MAX_PRIVATE_ROOMS` | 10 | Room caps |
| `VOICE_ICE_SERVERS` | public STUN | JSON list of STUN servers for voice chat |
| `TURN_URLS`, `TURN_SECRET` | none | Our own voice relay (coturn); players get expiring credentials. See [deploy/README.md](deploy/README.md) |
| `TURN_TTL_SECONDS` | 86400 | How long each player's relay credentials last |
| `GAME_CONFIG` | none | JSON gameplay overrides for playtests, e.g. `{"winLevel":3}` |

Gameplay tunables (fall distance, wind, crater size, collapse rules, ...) are in
`packages/shared/src/config.ts`. Extra chat words to block go in `packages/server/blocklist.txt`.
