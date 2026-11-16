# Tank You For Being A Friend

Real-time browser artillery: drop in by helicopter, aim, fire, climb to level 50.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:5173. Bots fill the room, so you can play alone. Each browser tab is a
separate player, so two tabs give you a two-player game. To play from a phone on the same
Wi-Fi, open the "Network" URL Vite prints (allow Node through Windows Firewall the first time).

```bash
npm test            # simulation, room, security and live-server tests
npm run typecheck   # all packages
npm run start       # production build served by the game server on :8787
npm run stats       # summarise logs/events-*.jsonl
```

## Layout

- `packages/shared` — the deterministic simulation (terrain, physics, progression, bots) and the
  WebSocket message contract. Runs on the server; the client reuses the terrain and shell code.
- `packages/server` — authoritative Node server: rooms, bot handoff and reclaim, chat filter,
  abuse limits, JSONL logs.
- `packages/client` — Vite + TypeScript + Canvas 2D client.

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

Gameplay tunables (fall distance, wind, crater size, collapse rules, ...) are in
`packages/shared/src/config.ts`. Extra chat words to block go in `packages/server/blocklist.txt`.
