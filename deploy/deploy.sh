#!/usr/bin/env bash
# deploy.sh <release>                  put it on staging
# GO_LIVE=1 deploy.sh <release>        what's on staging goes live
#
# For a release already uploaded to the releases bucket. The pipeline runs both (deploy/README.md):
# the first for each push to main that passes every test, the second once someone approves. You
# can run them from the repo too, with the games-drawer AWS profile.
#
# Staging:
#   1. turn     wait if a release is going live; close an older release's approval request.
#   2. launch   a new box with the release; staging shows it. Smoke tests against staging.
#               The site itself is unchanged, and nobody on it is sent to the new box.
# Going live:
#   1. check    it must be the release that's on staging.
#   2. launch   a fresh box with it, as above.
#   3. canary   it gets CANARY_PERCENT of new tables. Smoke tests against it through the front door.
#   4. check    every minute for CANARY_MINUTES: any crash or error fails the deploy.
#   5. promote  it takes every new table and the front door; the old box finishes its games and
#               shuts itself down.
# If anything fails after the first step, or the deploy is stopped (Ctrl+C, Stop), the new box is
# removed and the current one keeps everything.
#
# Needs AWS_REGION, SITE_DOMAIN and LAUNCH_TEMPLATE; CANARY_PERCENT (10) and CANARY_MINUTES (10)
# are optional. SKIP_BROWSER_INSTALL=1 uses the browser already installed (on Windows, where
# Playwright's --with-deps can't run).
set -euo pipefail
rel="${1:?usage: deploy.sh <release (git commit)>}"
: "${AWS_REGION:?}" "${SITE_DOMAIN:?}" "${LAUNCH_TEMPLATE:?}"
pct="${CANARY_PERCENT:-10}"
mins="${CANARY_MINUTES:-10}"
go_live="${GO_LIVE:-}"

fleet() { npx tsx deploy/fleet.ts "$@"; }

roll_back() {
  echo "The deploy didn't finish: removing the new box."
  fleet rollback "$rel" || echo "Rollback didn't finish; check with: npx tsx deploy/fleet.ts status"
}
if [ -n "$go_live" ]; then
  fleet on-staging "$rel"
else
  npx tsx deploy/pipeline.ts turn "$rel"
fi
# From here, however it ends short of the end, the new box goes: a failed step, or stopped by hand
# or by a time limit (and that clean-up isn't interrupted). Not an ERR trap: that doesn't fire for
# a step that fails inside a function, as fleet's do.
finished=
launch_log=
ended() {
  local status=$?
  trap '' INT TERM
  [ -z "$launch_log" ] || rm -f "$launch_log"
  if [ -z "$finished" ]; then
    roll_back
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}
trap ended EXIT
trap 'echo "The deploy was stopped."; exit 130' INT
trap 'echo "The deploy was stopped."; exit 143' TERM

echo "== Launching a box with ${rel:0:7}"
# Shown as it happens (it takes minutes), and still there to read if the launch fails.
launch_log="$(mktemp)"
fleet launch "$rel" | tee "$launch_log"
slot="$(sed -n 's/^CANARY_SLOT=//p' "$launch_log" | tail -1)"
test -n "$slot"

if [ -z "${SKIP_BROWSER_INSTALL:-}" ]; then npx playwright install --with-deps chromium; fi

echo "== Smoke tests against staging (box $slot)"
E2E_BASE_URL="https://staging.$SITE_DOMAIN" npx playwright test --grep @smoke

if [ -z "$go_live" ]; then
  finished=1
  echo "${rel:0:7} is on https://staging.$SITE_DOMAIN (box $slot). The site itself is unchanged."
  echo "To go live, approve it in the games-drawer pipeline. To take it down: npx tsx deploy/fleet.ts rollback $rel"
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
finished=1
echo "Deployed ${rel:0:7}."
