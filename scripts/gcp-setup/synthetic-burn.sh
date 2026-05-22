#!/usr/bin/env bash
# scripts/gcp-setup/synthetic-burn.sh
#
# Operator-only SCRUM-1064 synthetic metric injection. The batch point is
# intentionally SLO-driving, so run only in an approved staging/isolated project.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-}"
ENVIRONMENT="${ARKOVA_MONITORING_ENVIRONMENT:-staging}"
BATCH_FAILURES="${SYNTHETIC_BATCH_FAILURES:-10}"
GEMINI_TOKENS="${SYNTHETIC_GEMINI_TOKENS:-100000}"
# Batch metric uses synthetic="false" so Cloud Monitoring includes it in the SLO filter.
BATCH_METRIC_SYNTHETIC_LABEL="false"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

if [[ "${ALLOW_SYNTHETIC_SLO_BURN:-false}" != "true" ]]; then
  cat >&2 <<'MSG'
Refusing to write synthetic burn metrics.
Set ALLOW_SYNTHETIC_SLO_BURN=true and target an approved project/environment.
Do not run this against production without explicit operator approval.
MSG
  exit 1
fi

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: GCP_PROJECT_ID must be set explicitly." >&2
  exit 1
fi

require_command gcloud
require_command curl
require_command python3

ACCESS_TOKEN="$(gcloud auth print-access-token)"
TIMES="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
end = datetime.now(timezone.utc).replace(microsecond=0)
start = end - timedelta(seconds=60)
print(start.isoformat().replace('+00:00', 'Z'), end.isoformat().replace('+00:00', 'Z'))
PY
)"
START_TIME="${TIMES%% *}"
END_TIME="${TIMES##* }"

PAYLOAD="$(mktemp)"
trap 'rm -f "$PAYLOAD"' EXIT

cat >"$PAYLOAD" <<JSON
{
  "timeSeries": [
    {
      "metric": {
        "type": "custom.googleapis.com/arkova/batch_anchor_run_result",
        "labels": {
          "result": "failed",
          "environment": "${ENVIRONMENT}",
          "synthetic": "${BATCH_METRIC_SYNTHETIC_LABEL}"
        }
      },
      "resource": {
        "type": "global",
        "labels": {
          "project_id": "${PROJECT_ID}"
        }
      },
      "metricKind": "DELTA",
      "valueType": "INT64",
      "points": [
        {
          "interval": {
            "startTime": "${START_TIME}",
            "endTime": "${END_TIME}"
          },
          "value": {
            "int64Value": "${BATCH_FAILURES}"
          }
        }
      ]
    },
    {
      "metric": {
        "type": "custom.googleapis.com/arkova/gemini_token_burn",
        "labels": {
          "model": "synthetic-gemini-golden",
          "operation": "synthetic-burn-test",
          "environment": "${ENVIRONMENT}",
          "synthetic": "true"
        }
      },
      "resource": {
        "type": "global",
        "labels": {
          "project_id": "${PROJECT_ID}"
        }
      },
      "metricKind": "DELTA",
      "valueType": "INT64",
      "points": [
        {
          "interval": {
            "startTime": "${START_TIME}",
            "endTime": "${END_TIME}"
          },
          "value": {
            "int64Value": "${GEMINI_TOKENS}"
          }
        }
      ]
    }
  ]
}
JSON

curl --fail --silent --show-error \
  --connect-timeout 10 \
  --max-time 60 \
  --retry 3 \
  --retry-delay 2 \
  --retry-connrefused \
  --header "Authorization: Bearer ${ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --request POST \
  --data-binary "@${PAYLOAD}" \
  "https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/timeSeries"

echo "Synthetic burn metrics written to ${PROJECT_ID} (${ENVIRONMENT}) at ${END_TIME}."
