#!/usr/bin/env bash
# deploy.sh <release>
#
# The whole deploy, a box at a time (deploy/README.md), for a release already uploaded to the
# releases bucket. CodeBuild runs it on each push to main (deploy/buildspec.yml); you can run it
# from the repo too, with the games-drawer AWS profile.
#
#   1. launch   a new box with the release; staging shows it. Smoke tests against staging.
#   2. canary   it gets CANARY_PERCENT of new tables. Smoke tests against it through the front door.
#   3. check    every minute for CANARY_MINUTES: any crash or error fails the deploy.
#   4. promote  it takes every new table and the front door; the old box finishes its games and
#               shuts itself down.
# If anything fails, the new box is removed and the current one keeps everything.
#
# Needs AWS_REGION, SITE_DOMAIN and LAUNCH_TEMPLATE; CANARY_PERCENT (10) and CANARY_MINUTES (10)
# are optional.
set -euo pipefail
rel="${1:?usage: deploy.sh <release (git commit)>}"
: "${AWS_REGION:?}" "${SITE_DOMAIN:?}" "${LAUNCH_TEMPLATE:?}"
pct="${CANARY_PERCENT:-10}"
mins="${CANARY_MINUTES:-10}"

fleet() { npx tsx deploy/fleet.ts "$@"; }

roll_back() {
  echo "The deploy failed: removing the new box."
  fleet rollback "$rel" || echo "Rollback didn't finish; check with: npx tsx deploy/fleet.ts status"
}
trap roll_back ERR

echo "== Launching a box with ${rel:0:7}"
out="$(fleet launch "$rel")"
echo "$out"
slot="$(printf '%s\n' "$out" | sed -n 's/^CANARY_SLOT=//p' | tail -1)"
test -n "$slot"

npx playwright install --with-deps chromium

echo "== Smoke tests against staging (box $slot)"
E2E_BASE_URL="https://staging.$SITE_DOMAIN" npx playwright test --grep @smoke

echo "== Canary: box $slot gets $pct% of new tables"
fleet canary "$rel" "$pct"
E2E_BASE_URL="https://$SITE_DOMAIN" E2E_SLOT="$slot" npx playwright test --grep @smoke

for i in $(seq 1 "$mins"); do
  sleep 60
  echo "== Check $i of $mins"
  fleet check "$rel"
done

echo "== Promoting box $slot"
fleet promote "$rel"
trap - ERR
echo "Deployed ${rel:0:7}."
