#!/usr/bin/env bash
# scripts/gcp-setup/apply-monitoring.sh — SCRUM-1064 monitoring-as-code.
#
# Applies metric descriptors, service/SLO definitions, dashboard config, and
# SLO burn alert policies. Notification channels are passed in by environment;
# secrets and channel IDs are never hardcoded in repo.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd -P)"
GCP_SETUP_DIR="${ROOT_DIR}/scripts/gcp-setup"
PROJECT_ID="${GCP_PROJECT_ID:-arkova1}"
SERVICE_ID="${ARKOVA_MONITORING_SERVICE_ID:-arkova-worker}"
SLACK_OPS_ALERTS_CHANNEL="${SLACK_OPS_ALERTS_CHANNEL:-}"
PAGERDUTY_NOTIFICATION_CHANNEL="${PAGERDUTY_NOTIFICATION_CHANNEL:-}"
SLO_IDS=(
  worker-availability
  worker-p95-latency
  batch-anchor-success
  verification-api-p95-latency
)

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

access_token() {
  gcloud auth print-access-token
}

monitoring_api() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local token
  token="$(access_token)"

  if [[ -n "$body" ]]; then
    curl --fail --silent --show-error \
      --header "Authorization: Bearer ${token}" \
      --header "Content-Type: application/json" \
      --request "$method" \
      --data-binary "@${body}" \
      "$url"
  else
    curl --fail --silent --show-error \
      --header "Authorization: Bearer ${token}" \
      --request "$method" \
      "$url"
  fi
}

json_value() {
  node -e "const fs=require('fs'); const obj=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(${1});" "$2"
}

render_policy() {
  local source="$1"
  local target="$2"
  local content
  content="$(<"$source")"
  content="${content//\$\{PROJECT_ID\}/$PROJECT_ID}"
  content="${content//\$\{SERVICE_ID\}/$SERVICE_ID}"
  content="${content//\$\{SLACK_OPS_ALERTS_CHANNEL\}/$SLACK_OPS_ALERTS_CHANNEL}"
  printf '%s' "$content" >"$target"

  if [[ -n "$PAGERDUTY_NOTIFICATION_CHANNEL" ]]; then
    PAGERDUTY_NOTIFICATION_CHANNEL="$PAGERDUTY_NOTIFICATION_CHANNEL" node - <<'NODE' "$target"
const fs = require('fs');
const file = process.argv[2];
const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
policy.notificationChannels = [...new Set([...(policy.notificationChannels ?? []), process.env.PAGERDUTY_NOTIFICATION_CHANNEL])];
fs.writeFileSync(file, JSON.stringify(policy, null, 2));
NODE
  fi
}

ensure_metric_descriptors() {
  echo "--- SCRUM-1987: metric descriptors ---"
  for descriptor in "${GCP_SETUP_DIR}"/metrics/*.json; do
    local metric_type
    metric_type="$(json_value 'obj.type' "$descriptor")"
    if monitoring_api GET "https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/metricDescriptors/${metric_type}" >/dev/null 2>&1; then
      echo "Metric descriptor exists: ${metric_type}"
    else
      monitoring_api POST "https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/metricDescriptors" "$descriptor" >/dev/null
      echo "Metric descriptor created: ${metric_type}"
    fi
  done
}

ensure_log_based_metrics() {
  echo "--- SCRUM-3050: log-based metrics ---"
  # Log-based metrics live on the LOGGING API, not the Monitoring
  # metricDescriptors API used by ensure_metric_descriptors — hence a separate
  # directory (log-metrics/) and a separate function. They must exist BEFORE
  # ensure_alert_policies, which references
  # logging.googleapis.com/user/<name>.
  for metric in "${GCP_SETUP_DIR}"/log-metrics/*.json; do
    [[ -e "$metric" ]] || continue
    local metric_name
    metric_name="$(json_value 'obj.name' "$metric")"
    if monitoring_api GET "https://logging.googleapis.com/v2/projects/${PROJECT_ID}/metrics/${metric_name}" >/dev/null 2>&1; then
      monitoring_api PUT "https://logging.googleapis.com/v2/projects/${PROJECT_ID}/metrics/${metric_name}" "$metric" >/dev/null
      echo "Log-based metric updated: ${metric_name}"
    else
      monitoring_api POST "https://logging.googleapis.com/v2/projects/${PROJECT_ID}/metrics" "$metric" >/dev/null
      echo "Log-based metric created: ${metric_name}"
    fi
  done
}

ensure_monitoring_service() {
  echo "--- SCRUM-1988: monitoring service ---"
  if monitoring_api GET "https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/services/${SERVICE_ID}" >/dev/null 2>&1; then
    echo "Monitoring service exists: ${SERVICE_ID}"
    return
  fi

  local payload
  payload="$(mktemp)"
  cat >"$payload" <<JSON
{
  "displayName": "Arkova Worker",
  "custom": {}
}
JSON
  monitoring_api POST "https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/services?serviceId=${SERVICE_ID}" "$payload" >/dev/null
  rm -f "$payload"
  echo "Monitoring service created: ${SERVICE_ID}"
}

ensure_slos() {
  echo "--- SCRUM-1988: service-level objectives ---"
  for slo_id in "${SLO_IDS[@]}"; do
    local slo_json="${GCP_SETUP_DIR}/slos-json/${slo_id}.json"
    if monitoring_api GET "https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/services/${SERVICE_ID}/serviceLevelObjectives/${slo_id}" >/dev/null 2>&1; then
      monitoring_api PATCH "https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/services/${SERVICE_ID}/serviceLevelObjectives/${slo_id}?updateMask=displayName,goal,rollingPeriod,serviceLevelIndicator,userLabels" "$slo_json" >/dev/null
      echo "SLO updated: ${slo_id}"
    else
      monitoring_api POST "https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/services/${SERVICE_ID}/serviceLevelObjectives?serviceLevelObjectiveId=${slo_id}" "$slo_json" >/dev/null
      echo "SLO created: ${slo_id}"
    fi
  done
}

ensure_dashboard() {
  echo "--- SCRUM-1989: dashboard ---"
  local dashboard_file="${GCP_SETUP_DIR}/dashboards/arkova-ops-health.json"
  gcloud monitoring dashboards create --validate-only --config-from-file="$dashboard_file" --project="$PROJECT_ID" --quiet >/dev/null

  local dashboard_name
  dashboard_name="$(gcloud monitoring dashboards list \
    --project="$PROJECT_ID" \
    --filter='displayName="Arkova Operations Health"' \
    --format='value(name)' \
    --limit=1)"

  if [[ -n "$dashboard_name" ]]; then
    gcloud monitoring dashboards update "$dashboard_name" --config-from-file="$dashboard_file" --project="$PROJECT_ID" --quiet >/dev/null
    echo "Dashboard updated: ${dashboard_name}"
  else
    gcloud monitoring dashboards create --config-from-file="$dashboard_file" --project="$PROJECT_ID" --quiet >/dev/null
    echo "Dashboard created: Arkova Operations Health"
  fi
}

ensure_alert_policies() {
  echo "--- SCRUM-1990: SLO burn alert policies ---"
  if [[ -z "$SLACK_OPS_ALERTS_CHANNEL" ]]; then
    echo "ERROR: set SLACK_OPS_ALERTS_CHANNEL to a projects/.../notificationChannels/... resource name." >&2
    exit 1
  fi

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  for policy in "${GCP_SETUP_DIR}"/alert-policies/*.json; do
    local rendered
    rendered="${tmpdir}/$(basename "$policy")"
    render_policy "$policy" "$rendered"

    local display_name
    display_name="$(json_value 'obj.displayName' "$rendered")"
    local existing
    existing="$(gcloud monitoring policies list \
      --project="$PROJECT_ID" \
      --filter="displayName=\"${display_name}\"" \
      --format='value(name)' \
      --limit=1)"

    if [[ -n "$existing" ]]; then
      gcloud monitoring policies update "$existing" \
        --policy-from-file="$rendered" \
        --project="$PROJECT_ID" \
        --quiet >/dev/null
      echo "Alert policy updated: ${display_name} (${existing})"
    else
      gcloud monitoring policies create --policy-from-file="$rendered" --project="$PROJECT_ID" --quiet >/dev/null
      echo "Alert policy created: ${display_name}"
    fi
  done
}

main() {
  require_command gcloud
  require_command curl
  require_command node

  ensure_metric_descriptors
  ensure_log_based_metrics
  ensure_monitoring_service
  ensure_slos
  ensure_dashboard
  ensure_alert_policies
}

main "$@"
