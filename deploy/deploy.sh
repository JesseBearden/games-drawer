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
# STAGING_ONLY=1 stops after step 1: the new box stays up on staging.<domain> to try by hand,
# and nobody on the site itself is sent to it. Afterwards, deploy the same release without it to
# go live (its launch replaces the staging box), or remove it with `fleet.ts rollback <release>`.
#
# Needs AWS_REGION, SITE_DOMAIN and LAUNCH_TEMPLATE; CANARY_PERCENT (10) and CANARY_MINUTES (10)
# are optional. SKIP_BROWSER_INSTALL=1 uses the browser already installed (on Windows, where
# Playwright's --with-deps can't run).
set -euo pipefail
rel="${1:?usage: deploy.sh <release (git commit)>}"
: "${AWS_REGION:?}" "${SITE_DOMAIN:?}" "${LAUNCH_TEMPLATE:?}"
pct="${CANARY_PERCENT:-10}"
mins="${CANARY_MINUTES:-10}"
staging_only="${STAGING_ONLY:-}"

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

if [ -z "${SKIP_BROWSER_INSTALL:-}" ]; then npx playwright install --with-deps chromium; fi

echo "== Smoke tests against staging (box $slot)"
E2E_BASE_URL="https://staging.$SITE_DOMAIN" npx playwright test --grep @smoke

if [ -n "$staging_only" ]; then
  trap - ERR
  echo "${rel:0:7} is on https://staging.$SITE_DOMAIN (box $slot). The site itself is unchanged."
  echo "To go live, deploy ${rel:0:7} again without STAGING_ONLY. To take it down: npx tsx deploy/fleet.ts rollback $rel"
  exit 0
fi

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
