#!/usr/bin/env bash
# setup.sh <templates dir>
#
# Sets up a game server box: Caddy (routes requests to the right box), coturn (voice relay), the
# shared disk, the service account, secrets and config files. The rollout tool runs it from each
# release whenever this file changes, so it must be safe to run again: every step checks or
# overwrites.
#
# Boxes are disposable: a deploy launches a new one and the old one shuts itself down once its
# games are done. Nothing that matters lives only on a box:
#   - Jigsaw saves and logs are on the shared disk (EFS), mounted at /mnt/games-drawer;
#   - secrets are in Parameter Store (/games-drawer/secrets), made by the first box that needs them.
#
# Reads /etc/games-drawer/deploy.env (written when AWS launches the box):
#   DOMAIN       the site's domain, e.g. games.example.com (staging is staging.DOMAIN)
#   BUCKET       S3 bucket with release bundles
#   REGION       AWS region
#   FILE_SYSTEM  the shared disk's id (fs-…)
#   FRONT_DOOR   cloudfront (CloudFront in front; HTTPS ends there) or direct (the domain points
#                at the boxes, and Caddy does HTTPS with certificates kept on the shared disk)
set -euo pipefail
tpl="${1:?usage: setup.sh <templates dir>}"
source /etc/games-drawer/deploy.env
export DEBIAN_FRONTEND=noninteractive
export PATH="$PATH:/snap/bin"
front_door="${FRONT_DOOR:-cloudfront}"
case "$front_door" in cloudfront | direct) ;; *) echo "FRONT_DOOR must be cloudfront or direct." >&2; exit 1 ;; esac

# ---------------------------------------------------------------- accounts
# The same user and group ids on every box: they all write to the shared disk. Caddy's account
# is made before its package, which then uses it (Caddy keeps its certificates on the shared disk).
getent group games >/dev/null || groupadd --system --gid 1500 games
id games >/dev/null 2>&1 || useradd --system --uid 1500 --gid 1500 --home-dir /opt/games-drawer --shell /usr/sbin/nologin games
getent group caddy >/dev/null || groupadd --system --gid 1501 caddy
id caddy >/dev/null 2>&1 || useradd --system --uid 1501 --gid 1501 --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
install -d -m 755 /opt/games-drawer /opt/games-drawer/releases /etc/games-drawer

# ---------------------------------------------------------------- the relay waits for its setup
# Written before the packages, which start services as they install: the relay runs only once its
# config is in place (relay-ready), and only behind its firewall (relay-firewall.sh). It runs
# boxed in: a memory limit (it normally uses under 20 MB) and less of the CPU than the game when
# both want it, nowhere to write but its database, no privileges, and a log of its own that can't
# fill the disk (journald's gd-relay namespace: journalctl --namespace gd-relay -u coturn).
relay_unit=/etc/systemd/system/coturn.service.d/games-drawer.conf
relay_journal=/etc/systemd/journald@gd-relay.conf
install -d -m 755 /etc/systemd/system/coturn.service.d
install -m 755 "$tpl/relay-firewall.sh" /usr/local/sbin/games-drawer-relay-firewall
cat > "$relay_unit" <<'UNIT'
[Unit]
ConditionPathExists=/etc/games-drawer/relay-ready
StartLimitIntervalSec=0

[Service]
ExecStartPre=+/usr/local/sbin/games-drawer-relay-firewall
RestartSec=2
MemoryMax=350M
MemorySwapMax=0
OOMScoreAdjust=500
CPUWeight=50
LimitNOFILE=8192
LogNamespace=gd-relay
LogRateLimitIntervalSec=30s
LogRateLimitBurst=300
StandardOutput=journal
StandardError=journal
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ReadWritePaths=/var/lib/turn
ProtectHome=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
InaccessiblePaths=-/etc/games-drawer
UNIT
cat > "$relay_journal" <<'JOURNAL'
[Journal]
Storage=persistent
SystemMaxUse=50M
SystemMaxFileSize=5M
MaxFileSec=1day
MaxRetentionSec=29day
ForwardToSyslog=no
JOURNAL
systemctl daemon-reload

# ---------------------------------------------------------------- packages
if ! command -v caddy >/dev/null || ! command -v turnserver >/dev/null || ! command -v mount.nfs4 >/dev/null; then
  apt-get update -q
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  # Caddy's own package repository (Ubuntu's copy is too old for weighted routing).
  if [ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
  fi
  apt-get install -y -q caddy coturn nftables nfs-common
fi
# Security updates install themselves (Ubuntu's default, made explicit).
apt-get install -y -q unattended-upgrades >/dev/null

# ---------------------------------------------------------------- this box (from the EC2 metadata service)
token="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
meta() { curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"; }
public_ip="$(meta public-ipv4)"
private_ip="$(meta local-ipv4)"
instance_id="$(meta instance-id)"
printf 'PUBLIC_IP=%s\nPRIVATE_IP=%s\nINSTANCE_ID=%s\n' "$public_ip" "$private_ip" "$instance_id" > /etc/games-drawer/box.env

# ---------------------------------------------------------------- the shared disk (EFS)
mnt=/mnt/games-drawer
install -d -m 755 "$mnt"
fstab_line="${FILE_SYSTEM}.efs.${REGION}.amazonaws.com:/ ${mnt} nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0"
if ! grep -qF "$fstab_line" /etc/fstab; then
  sed -i "\|[[:space:]]${mnt}[[:space:]]|d" /etc/fstab
  echo "$fstab_line" >> /etc/fstab
  systemctl daemon-reload
fi
for _ in $(seq 1 30); do
  mountpoint -q "$mnt" && break
  mount "$mnt" 2>/dev/null || sleep 5
done
mountpoint -q "$mnt" || { echo "Couldn't mount the shared disk ${FILE_SYSTEM}." >&2; exit 1; }
# Jigsaw saves (every box reads and writes them) and logs (a folder per box; the admin page adds them up).
install -d -m 750 -o games -g games "$mnt/puzzles" "$mnt/logs" "$mnt/logs/$instance_id"
# HTTPS certificates, when Caddy does HTTPS (FRONT_DOOR=direct): every box uses the same ones.
install -d -m 700 -o caddy -g caddy "$mnt/caddy"

# ---------------------------------------------------------------- secrets (shared by every box, in Parameter Store)
param=/games-drawer/secrets
get_secrets() { aws ssm get-parameter --region "$REGION" --name "$param" --with-decryption --query Parameter.Value --output text 2>/dev/null; }
if ! secrets="$(get_secrets)"; then
  # The first box makes them. If another box makes them at the same moment, theirs wins.
  made="$(printf 'SESSION_SECRET=%s\nSTATS_TOKEN=%s\nTURN_SECRET=%s' "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" "$(openssl rand -hex 32)")"
  aws ssm put-parameter --region "$REGION" --name "$param" --type SecureString --value "$made" --no-overwrite >/dev/null 2>&1 || true
  secrets="$(get_secrets)"
fi
# They are values, never commands: each name must have one plain hex value, and nothing else in
# there is used.
secret() {
  local value
  value="$(printf '%s\n' "$secrets" | sed -n "s/^$1=//p")"
  [[ "$value" =~ ^[0-9a-f]{32,128}$ ]] || { echo "$1 in $param isn't a plain hex value." >&2; exit 1; }
  printf '%s' "$value"
}
SESSION_SECRET="$(secret SESSION_SECRET)"
STATS_TOKEN="$(secret STATS_TOKEN)"
TURN_SECRET="$(secret TURN_SECRET)"
(umask 077 && printf 'SESSION_SECRET=%s\nSTATS_TOKEN=%s\nTURN_SECRET=%s\n' "$SESSION_SECRET" "$STATS_TOKEN" "$TURN_SECRET" > /etc/games-drawer/secrets.env)

# ---------------------------------------------------------------- game server settings
cat > /etc/games-drawer/common.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
TRUST_PROXY=1
ALLOWED_ORIGINS=https://${DOMAIN},https://staging.${DOMAIN}
MAX_PUBLIC_ROOMS=${MAX_PUBLIC_ROOMS:-10}
MAX_PRIVATE_ROOMS=${MAX_PRIVATE_ROOMS:-50}
# 30 new tables per address per 10 minutes (the server's own default is 5): each deploy's smoke
# tests open about 16 from one address, and a family on one home connection shares an address.
# The 50-table cap still bounds the cost. (Single quotes: systemd would strip the double ones.)
LIMITS='{"privateRoomsPer10Min":30}'
PUZZLE_DIR=${mnt}/puzzles
# Photos people add to a jigsaw are checked by Amazon Rekognition, with this box's own role. The
# AI services opt-out policy must be on first (deploy/README.md), or the privacy page isn't true.
PHOTO_CHECK=rekognition
PHOTO_CHECK_REGION=${REGION}
LOG_DIR=${mnt}/logs/${instance_id}
ADMIN_LOG_DIRS=${mnt}/logs
TURN_URLS=turn:${public_ip}:3478?transport=udp,turn:${public_ip}:3478?transport=tcp
EOF

# ---------------------------------------------------------------- systemd unit and deploy command
install -m 644 "$tpl/games-drawer@.service" /etc/systemd/system/games-drawer@.service
install -m 755 "$tpl/games-drawer-deploy" /usr/local/bin/games-drawer-deploy
systemctl daemon-reload

# ---------------------------------------------------------------- voice relay (each box runs its own, on its own address)
fill() { sed -e "s|@DOMAIN@|${DOMAIN}|g" -e "s|@PUBLIC_IP@|${public_ip}|g" -e "s|@PRIVATE_IP@|${private_ip}|g" -e "s|@TURN_SECRET@|${TURN_SECRET}|g" "$1"; }
(umask 077 && fill "$tpl/turnserver.conf" > /etc/turnserver.conf.new)
chmod 640 /etc/turnserver.conf.new
chgrp turnserver /etc/turnserver.conf.new
# relay-ready says which setup the relay last started with. (Its firewall only loads as it starts:
# loading forgets who has a slot.)
relay_setup="$(cat /etc/turnserver.conf.new /usr/local/sbin/games-drawer-relay-firewall "$relay_unit" "$relay_journal" | sha256sum)"
if [ "$relay_setup" != "$(cat /etc/games-drawer/relay-ready 2>/dev/null)" ] || ! systemctl is-active --quiet coturn; then
  mv /etc/turnserver.conf.new /etc/turnserver.conf
  printf '%s\n' "$relay_setup" > /etc/games-drawer/relay-ready
  if [ -f /etc/default/coturn ]; then sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn; fi
  systemctl enable coturn
  systemctl restart coturn
else
  rm -f /etc/turnserver.conf.new
fi
systemctl is-active --quiet coturn || { echo "The voice relay didn't start." >&2; exit 1; }

# ---------------------------------------------------------------- this box's own logs: 30 days
# Like the game's logs (pruned by the server), nothing on the box is kept longer than 30 days;
# the privacy page says so. The relay's notes go to a journal of their own (above), the web
# server's to the main one: each has a size limit and starts a file a day, because journald only
# deletes whole files (29 days of them, plus the day being written). The journal stops copying
# into /var/log/syslog, which Ubuntu keeps for about five weeks.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\nMaxFileSec=1day\nMaxRetentionSec=29day\nForwardToSyslog=no\n' > /etc/systemd/journald.conf.d/games-drawer.conf
systemctl restart systemd-journald || true

# ---------------------------------------------------------------- web server
if [ ! -f /etc/caddy/games-drawer-routes.caddy ]; then
  echo 'respond "Starting up. Try again in a minute." 503' > /etc/caddy/games-drawer-routes.caddy
fi
# Caddy keeps certificates on the shared disk, so it waits for it after a reboot.
install -d -m 755 /etc/systemd/system/caddy.service.d
printf '[Unit]\nRequiresMountsFor=%s\n' "$mnt" > /etc/systemd/system/caddy.service.d/shared-disk.conf
systemctl daemon-reload
sed -e "s|@DOMAIN@|${DOMAIN}|g" "$tpl/Caddyfile.${front_door}" > /etc/caddy/Caddyfile.new
chmod 644 /etc/caddy/Caddyfile.new
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null
if ! cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile; then
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl enable caddy
  systemctl reload-or-restart caddy
else
  rm -f /etc/caddy/Caddyfile.new
fi

echo "Setup done for ${DOMAIN} on ${instance_id} (${public_ip}), front door: ${front_door}."
