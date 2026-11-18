#!/usr/bin/env bash
# ssm-run.sh "<command>"
#
# Runs a shell command on the game server through AWS Systems Manager (no SSH), waits for it,
# prints its output, and exits non-zero if it failed. Used by .github/workflows/ci.yml.
# Needs AWS credentials and DEPLOY_INSTANCE_ID in the environment.
set -euo pipefail
cmd="${1:?usage: ssm-run.sh <command>}"
: "${DEPLOY_INSTANCE_ID:?DEPLOY_INSTANCE_ID is not set}"

params="$(jq -cn --arg c "$cmd" '{commands: [$c], executionTimeout: ["1800"]}')"
id="$(aws ssm send-command --instance-ids "$DEPLOY_INSTANCE_ID" --document-name AWS-RunShellScript \
  --comment "games-drawer deploy" --parameters "$params" --query Command.CommandId --output text)"

status=Pending
for _ in $(seq 1 400); do
  sleep 5
  status="$(aws ssm get-command-invocation --command-id "$id" --instance-id "$DEPLOY_INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
  case "$status" in Pending | InProgress | Delayed) ;; *) break ;; esac
done

aws ssm get-command-invocation --command-id "$id" --instance-id "$DEPLOY_INSTANCE_ID" --query StandardOutputContent --output text
err="$(aws ssm get-command-invocation --command-id "$id" --instance-id "$DEPLOY_INSTANCE_ID" --query StandardErrorContent --output text)"
if [ -n "$err" ] && [ "$err" != "None" ]; then echo "$err" >&2; fi
if [ "$status" != Success ]; then
  echo "Command on the server ended with status: $status" >&2
  exit 1
fi
