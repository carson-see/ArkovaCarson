#!/usr/bin/env bash
# Enterprise gcloud auth guard for Cloud Run / Secret Manager operations.
#
# Mutation and verification scripts should run under GitHub Workload Identity
# Federation, Cloud Run service identity, or an external-account credential.
# A local interactive user account is intentionally rejected unless an operator
# sets ARKOVA_ALLOW_USER_GCLOUD=breakglass for a one-off emergency.

arkova_require_enterprise_gcloud_auth() {
  local context="${1:-GCP operation}"
  local gcloud_bin="${2:-gcloud}"
  local active_account=""

  if [[ "${GITHUB_ACTIONS:-}" == "true" || -n "${K_SERVICE:-}" || -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
    return 0
  fi

  active_account="$("$gcloud_bin" auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
  if [[ "$active_account" == *".gserviceaccount.com" ]]; then
    return 0
  fi

  if [[ "${ARKOVA_ALLOW_USER_GCLOUD:-}" == "breakglass" ]]; then
    echo "WARN: ${context} is using breakglass local user gcloud auth (${active_account:-none})." >&2
    return 0
  fi

  cat >&2 <<EOF
ERROR: ${context} requires enterprise GCP identity, not local interactive gcloud auth.

Active gcloud account: ${active_account:-none}

Use a WIF-backed GitHub workflow instead:
  gh workflow run deploy-worker.yml --ref main
  gh workflow run deploy-staging.yml --ref main -f pr_number=<PR> -f source_ref=<SHA>
  gh workflow run verify-worker-runtime.yml --ref main

For emergency breakglass only:
  ARKOVA_ALLOW_USER_GCLOUD=breakglass <command>
EOF
  return 2
}
