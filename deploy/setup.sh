#!/usr/bin/env bash
# setup.sh <templates dir>
#
# Sets up the game server machine: Caddy (HTTPS), coturn (voice relay), the service account,
# secrets and config files. The rollout tool runs it from each release whenever this file
# changes, so it must be safe to run again: every step checks or overwrites.
#
# Reads /etc/games-drawer/deploy.env (written when AWS creates the machine):
#   DOMAIN   the site's domain, e.g. games.example.com (staging is staging.DOMAIN)
#   BUCKET   S3 bucket with release bundles
#   REGION   AWS region
set -euo pipefail
tpl="${1:?usage: setup.sh <templates dir>}"
source /etc/games-drawer/deploy.env
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- packages
if ! command -v caddy >/dev/null || ! command -v turnserver >/dev/null; then
  apt-get update -q
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  # Caddy's own package repository (Ubuntu's copy is too old for weighted canaries).
  if [ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
  fi
  apt-get install -y -q caddy coturn
fi
# Security updates install themselves (Ubuntu's default, made explicit).
apt-get install -y -q unattended-upgrades >/dev/null

# ---------------------------------------------------------------- account and folders
id games >/dev/null 2>&1 || useradd --system --home-dir /opt/games-drawer --shell /usr/sbin/nologin games
install -d -m 755 /opt/games-drawer /opt/games-drawer/releases /etc/games-drawer
install -d -m 750 -o games -g games /var/log/games-drawer
# Jigsaw saves (both copies of the game read and write here, so a deploy keeps them).
install -d -m 750 -o games -g games /var/lib/games-drawer /var/lib/games-drawer/puzzles

# ---------------------------------------------------------------- secrets (made once, never leave this machine)
if [ ! -f /etc/games-drawer/secrets.env ]; then
  (
    umask 077
    {
      echo "SESSION_SECRET=$(openssl rand -hex 32)"
      echo "STATS_TOKEN=$(openssl rand -hex 24)"
      echo "TURN_SECRET=$(openssl rand -hex 32)"
    } > /etc/games-drawer/secrets.env
  )
fi
# shellcheck disable=SC1091
source /etc/games-drawer/secrets.env

# ---------------------------------------------------------------- addresses (from the EC2 metadata service)
token="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
meta() { curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"; }
public_ip="$(meta public-ipv4)"
private_ip="$(meta local-ipv4)"

# ---------------------------------------------------------------- game server settings shared by every copy
cat > /etc/games-drawer/common.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
TRUST_PROXY=1
ALLOWED_ORIGINS=https://${DOMAIN},https://staging.${DOMAIN}
MAX_PUBLIC_ROOMS=${MAX_PUBLIC_ROOMS:-10}
MAX_PRIVATE_ROOMS=${MAX_PRIVATE_ROOMS:-50}
PUZZLE_DIR=/var/lib/games-drawer/puzzles
TURN_URLS=turn:${DOMAIN}:3478?transport=udp,turn:${DOMAIN}:3478?transport=tcp
EOF

# ---------------------------------------------------------------- systemd unit and deploy command
install -m 644 "$tpl/games-drawer@.service" /etc/systemd/system/games-drawer@.service
install -m 755 "$tpl/games-drawer-deploy" /usr/local/bin/games-drawer-deploy
systemctl daemon-reload

# ---------------------------------------------------------------- voice relay
fill() { sed -e "s|@DOMAIN@|${DOMAIN}|g" -e "s|@PUBLIC_IP@|${public_ip}|g" -e "s|@PRIVATE_IP@|${private_ip}|g" -e "s|@TURN_SECRET@|${TURN_SECRET}|g" "$1"; }
fill "$tpl/turnserver.conf" > /etc/turnserver.conf.new
chmod 640 /etc/turnserver.conf.new
chgrp turnserver /etc/turnserver.conf.new 2>/dev/null || true
if ! cmp -s /etc/turnserver.conf.new /etc/turnserver.conf; then
  mv /etc/turnserver.conf.new /etc/turnserver.conf
  if [ -f /etc/default/coturn ]; then sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn; fi
  touch /var/log/turnserver.log && chown turnserver:turnserver /var/log/turnserver.log 2>/dev/null || true
  systemctl enable coturn
  systemctl restart coturn
else
  rm -f /etc/turnserver.conf.new
fi

# ---------------------------------------------------------------- web server
if [ ! -f /etc/caddy/games-drawer-upstreams.caddy ]; then
  echo 'respond "Starting up. Try again in a minute." 503' > /etc/caddy/games-drawer-upstreams.caddy
fi
fill "$tpl/Caddyfile" > /etc/caddy/Caddyfile.new
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null
if ! cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile; then
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl enable caddy
  systemctl reload-or-restart caddy
else
  rm -f /etc/caddy/Caddyfile.new
fi

echo "Setup done for ${DOMAIN} (${public_ip})."
