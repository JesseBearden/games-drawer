# On the server

What runs on the game server, and how a deploy works there. Setting up AWS itself is in
[infra/README.md](../infra/README.md).

## What's installed

[setup.sh](setup.sh) sets the machine up, and every deploy re-runs it when it changes:

- **Caddy** ([Caddyfile](Caddyfile)) serves HTTPS for the domain and `staging.` the domain, gets
  and renews certificates, and passes everything to the game server copies on localhost.
- **coturn** ([turnserver.conf](turnserver.conf)), the voice relay for players whose networks
  block direct voice connections.
- **The game server**, as a systemd service ([games-drawer@.service](games-drawer@.service))
  running as the unprivileged `games` user, locked down to writing only its logs.
- **Secrets** (session signing, stats token, relay secret) are generated on the machine on first
  setup, in `/etc/games-drawer/secrets.env`, and never leave it.

## How a deploy works

GitHub Actions uploads a release bundle (`npm run release -- --tar`) to S3, then runs
`games-drawer-deploy <commit> <command>` on the server through AWS Systems Manager (there is no
SSH). That fetches the bundle and runs its [rollout tool](rollout.ts):

1. **staging**: the release starts on port 8803 behind `staging.<domain>`, and the smoke tests
   (`npx playwright test --grep @smoke`) run against it.
2. **canary**: the release starts in whichever of the two production slots is free (a on
   port 8801, b on 8802). Caddy sends it 10% of new rooms; everything else stays on the
   current version. Smoke tests then run against the canary alone (`?slot=` routes straight to
   one copy).
3. **check**, every minute for 10 minutes: any crash, restart, room error or message-handler
   error fails the deploy.
4. **promote**: the new version takes all new rooms. The old one gets `SIGUSR2`: it finishes
   the games it has (people stay connected the whole time), then exits on its own.
5. If anything fails, **rollback** sends everything back to the old version and stops the new one.

A room's code says which slot holds it (`slotOfCode` in the shared protocol), so reconnects and
invite links reach the right copy even while two versions run. Each release also carries the
other's build files, so a page loaded from either copy works.

## Handy commands

Open a shell on the server (needs the AWS CLI's Session Manager plugin):

```bash
aws ssm start-session --target <InstanceId> --profile games-drawer
```

Then:

```bash
sudo games-drawer-deploy <commit> status       # what's running in each slot
sudo games-drawer-deploy <commit> rollback     # undo a canary by hand
journalctl -u games-drawer@a -f                # server output (also @b, @staging)
ls /var/log/games-drawer/a                     # JSONL game and chat logs
```

## Admin page

The admin page (`/admin`) needs its password's hash in AWS Parameter Store. The hash is one-way:
it can check the password but can't be turned back into it. Still, keep it out of the repo. Set
it once (and again whenever you change the password), from the repo on your computer:

```bash
aws ssm put-parameter --profile games-drawer --name /games-drawer/admin-password-hash --type SecureString --overwrite --value "$(npm run -s admin-password -- --value)"
```

The next deploy picks it up (`games-drawer-deploy` writes it to `/etc/games-drawer/admin.env`).
The server's role can read that one parameter and nothing else. Parameter Store's standard tier
is free, unlike Secrets Manager, and does the same job here.

## Voice relay (TURN)

Voice chat connects players directly. Some networks (strict routers, some mobile carriers,
work Wi-Fi) block that; those players' audio goes through coturn on the server instead.
The game server hands each player relay credentials that expire after 24 hours
(`TURN_TTL_SECONDS`), signed with the shared secret.

**Testing it:** open a private room with `?relay=1` on the end of the URL (for example
`https://<domain>/r/BCDFG?relay=1`) on two phones on cell data. That forces every voice
link through the relay. The voice panel shows "(relayed)" next to each person when it works.

**Limits:** the relay refuses to forward to private and internal addresses (including the AWS
metadata service), allows 16 KB/s per relayed link and 300 KB/s in total, which is about 50
voice streams at once. Networks that only allow port 443 aren't covered; that would need a
second IP address for the relay.
