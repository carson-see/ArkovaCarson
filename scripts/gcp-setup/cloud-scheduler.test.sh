#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEDULER_SCRIPT="$SCRIPT_DIR/cloud-scheduler.sh"
EXPECTED='docusign-listener-drift|15 * * * *|/jobs/docusign-listener-drift|30s,120s,2'

if ! grep -Fq "\"$EXPECTED\"" "$SCHEDULER_SCRIPT"; then
  echo "Missing expected DocuSign listener drift Scheduler job: $EXPECTED" >&2
  exit 1
fi

MATCH_COUNT="$(grep -Fc '"docusign-listener-drift|' "$SCHEDULER_SCRIPT")"
if [[ "$MATCH_COUNT" != "1" ]]; then
  echo "Expected one DocuSign listener drift Scheduler job, found $MATCH_COUNT" >&2
  exit 1
fi

echo "ok - docusign-listener-drift Scheduler job is bound hourly with retry"
