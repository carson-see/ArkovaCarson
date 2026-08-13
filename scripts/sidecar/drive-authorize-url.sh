#!/usr/bin/env bash
# Mint a fresh Google Drive authorize URL for the connector SIDE-RIG.
#
# WHY THIS EXISTS: the Drive OAuth `state` token is HMAC-signed with a 10-minute
# TTL (`StateTtlMs` in services/worker/src/api/v1/integrations/drive-oauth.ts), so
# an authorize URL pasted into a document is dead long before a human reads it.
# Run this, then click the URL it prints within 10 minutes.
#
# SIDE-RIG ONLY. This never touches the frozen soak rig
# (arkova-worker-fullsoak-2026-08-staging / gnkuaywlpmsaezwvlvhk) or production.
#
# Usage:  bash scripts/sidecar/drive-authorize-url.sh
set -euo pipefail

export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-/opt/homebrew/opt/python@3.14/bin/python3.14}"

PROJECT=arkova1
ORG_ID=40383eb2-f1cd-4a85-8099-afafff95e5cf          # "Sidecar Test Org"
USER_EMAIL=sidecar-owner@arkova-sidecar.test
# MUST be the -270018525501 hostname: the worker derives redirect_uri from the
# request Host header, and only that spelling is registered on the OAuth client.
BASE=https://arkova-worker-connector-sidecar-2026-08-staging-270018525501.us-central1.run.app

sb_url=$(gcloud secrets versions access latest --secret=supabase-url-connector-sidecar-2026-08-staging --project="$PROJECT")
anon=$(gcloud secrets versions access latest --secret=supabase-anon-key-connector-sidecar-2026-08-staging --project="$PROJECT")
pw=$(gcloud secrets versions access latest --secret=sidecar-drive-test-user-password --project="$PROJECT")

jwt=$(curl -fsS -X POST "$sb_url/auth/v1/token?grant_type=password" \
  -H "apikey: $anon" -H 'Content-Type: application/json' \
  -d "$(printf '{"email":"%s","password":"%s"}' "$USER_EMAIL" "$pw")" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

curl -fsS -X POST "$BASE/api/v1/integrations/google_drive/oauth/start" \
  -H "Authorization: Bearer $jwt" -H 'Content-Type: application/json' \
  -d "$(printf '{"org_id":"%s"}' "$ORG_ID")" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["authorizationUrl"])'

echo
echo "^ Open within 10 minutes. Sign in with a Google account that has at least"
echo "  one file, and grant drive.file + drive.activity.readonly."
echo "  Success redirects to app.arkova.ai/...?drive=connected (that frontend host"
echo "  is not part of this rig, so the browser will land on a real page that knows"
echo "  nothing about it — that is expected; the token is already persisted by then)."
