#!/usr/bin/env bash
# mig-docusign-trust T3 soak driver (PR #2472 / 0423 + PR #2476 / 0424).
# bash 3.2 compatible. Window END computed with `date -u`.
set -uo pipefail
export CLOUDSDK_PYTHON=${CLOUDSDK_PYTHON:-/opt/homebrew/bin/python3}
SOAKDIR="$HOME/arkova-soak/migdstrust"
. "$SOAKDIR/driver-env.sh"
HMAC="$(cat "$SOAKDIR/hmac.key")"
UPW="$(cat "$SOAKDIR/userpw")"
ACCT_A="aa000000-1111-4111-8111-00000000000a"
ACCT_B="bb000000-2222-4222-8222-00000000000b"
FOREIGN="ff000000-9999-4999-8999-00000000000f"
UNKNOWN="cc000000-3333-4333-8333-00000000000c"
ORG_A="50a70000-0000-4000-8000-00000000a001"
USER_A="50a70000-0000-4000-8000-00000000a0a1"
PII_MARKER="SOAKPII-DoNotLog-Marker"
END_EPOCH="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$SOAK_END" +%s)"

newid() { uuidgen | tr 'A-Z' 'a-z'; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- DocuSign Connect webhook ---------------------------------------------
# $1 body  $2 query-suffix  -> prints http code
post() { local sig
  sig="$(printf '%s' "$1" | openssl dgst -sha256 -hmac "$HMAC" -binary | base64)"
  curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "$URL/webhooks/docusign$2" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "X-DocuSign-Signature-1: $sig" --data "$1"
}
post_body() { local sig
  sig="$(printf '%s' "$1" | openssl dgst -sha256 -hmac "$HMAC" -binary | base64)"
  curl -s -m 30 -X POST "$URL/webhooks/docusign$2" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "X-DocuSign-Signature-1: $sig" --data "$1"
}
# $1 envelopeId $2 eventId $3 resolving accountId $4 senderAccountId $5 sha256 $6 generatedDateTime
env_body() {
cat <<JSON
{"event":"envelope-completed","apiVersion":"v2.1","uri":"/x","retryCount":0,"configurationId":1,"generatedDateTime":"$6","eventId":"$2","data":{"accountId":"$3","senderAccountId":"$4","envelopeId":"$1","envelopeSummary":{"status":"completed","sender":{"email":"sender@soak.test","accountId":"$4"},"envelopeDocuments":[{"documentId":"1","name":"contract.pdf","documentIdGuid":"$(newid)","sha256":"$5"}]}},"envelopeSummary":{"recipients":{"signers":[{"recipientIdGuid":"$(newid)","userId":"$(newid)","status":"completed","signedDateTime":"$6","name":"$PII_MARKER","email":"pii-marker@example.invalid"}]}}}
JSON
}

# --- Supabase helpers ------------------------------------------------------
sb_service() { # $1 method $2 path $3 body(optional) -> prints response body
  if [ $# -ge 3 ]; then
    curl -s -m 30 -X "$1" "$SUPABASE_URL/rest/v1/$2" \
      -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
      -H "Content-Type: application/json" -H "Prefer: return=representation" --data "$3"
  else
    curl -s -m 30 -X "$1" "$SUPABASE_URL/rest/v1/$2" \
      -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
  fi
}
sb_user() { # $1 method $2 path $3 body(optional)
  if [ $# -ge 3 ]; then
    curl -s -m 30 -X "$1" "$SUPABASE_URL/rest/v1/$2" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" \
      -H "Content-Type: application/json" -H "Prefer: return=representation" --data "$3"
  else
    curl -s -m 30 -X "$1" "$SUPABASE_URL/rest/v1/$2" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT"
  fi
}
refresh_user_jwt() {
  USER_JWT="$(curl -s -m 30 -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
    --data "{\"email\":\"soak-a@soak-fixture.invalid\",\"password\":\"$UPW\"}" | jq -r '.access_token // empty')"
}

FORGED_META='{"connector_source":"docusign","connector_artifact_id":"11111111-1111-4111-8111-111111111111","account_id":"FORGED-ACCT","envelope_id":"FORGED-ENV","_signers":[{"recipientIdGuid":"forged","status":"completed"}],"_docusign_env":"prod","_direction":"inbound","_sending_account_id":"FORGED-SEND","soak_probe":"kept"}'

CYCLE=0
while [ "$(date -u +%s)" -lt "$END_EPOCH" ]; do
  CYCLE=$((CYCLE+1)); TS="$(date -u +%s)"; CY_START="$(now_iso)"
  TOKEN="$(gcloud auth print-identity-token 2>/dev/null)"
  refresh_user_jwt
  HEALTH="$(curl -s -m 20 -H "Authorization: Bearer $TOKEN" "$URL/health")"

  # ---- Trigger A: outbound delivery + tenant-scoped nonce (per-org isolation)
  E="$(newid)"; V="cyc$CYCLE-$TS"; G="$(now_iso)"; SHA="$(openssl rand -hex 32)"
  A_OUT="$(post "$(env_body "$E" "$V" "$ACCT_A" "$ACCT_A" "$SHA" "$G")" "")"
  # SAME (envelope_id,event_id,generated_at) tuple, DIFFERENT tenant -> must be accepted
  B_OUT="$(post "$(env_body "$E" "$V" "$ACCT_B" "$ACCT_B" "$SHA" "$G")" "")"
  # replay INSIDE org A -> must be rejected as duplicate
  A_REPLAY="$(post "$(env_body "$E" "$V" "$ACCT_A" "$ACCT_A" "$SHA" "$G")" "")"

  # ---- Trigger B: inbound (Recipient Connect), foreign sending account
  IE="$(newid)"; IV="cyc$CYCLE-in-$TS"; IG="$(now_iso)"
  IN_RESP="$(post_body "$(env_body "$IE" "$IV" "$ACCT_A" "$FOREIGN" "$(openssl rand -hex 32)" "$IG")" "?customrecipient=true")"
  IN_CODE="$(post "$(env_body "$(newid)" "cyc$CYCLE-in2-$TS" "$ACCT_A" "$FOREIGN" "$(openssl rand -hex 32)" "$(now_iso)")" "?customrecipient=true")"
  # nonce rows written for the FIRST inbound tuple (flag OFF must write none)
  IN_NONCES="$(sb_service GET "docusign_webhook_nonces?envelope_id=eq.$IE&select=account_id" | jq 'length')"

  # ---- negative controls
  BADSIG="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "$URL/webhooks/docusign" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "X-DocuSign-Signature-1: deadbeef" --data "$(env_body "$(newid)" "cyc$CYCLE-x-$TS" "$ACCT_A" "$ACCT_A" "$SHA" "$(now_iso)")")"
  ORPHAN="$(post "$(env_body "$(newid)" "cyc$CYCLE-o-$TS" "$UNKNOWN" "$UNKNOWN" "$SHA" "$(now_iso)")" "")"

  # ---- 0423 write-authority trigger --------------------------------------
  FP="$(openssl rand -hex 32)"
  USER_INS="$(sb_user POST "anchors?select=id,metadata" \
    "{\"user_id\":\"$USER_A\",\"org_id\":\"$ORG_A\",\"status\":\"PENDING\",\"fingerprint\":\"$FP\",\"filename\":\"soak-user-$CYCLE.pdf\",\"metadata\":$FORGED_META}")"
  USER_ANCHOR_ID="$(printf '%s' "$USER_INS" | jq -r '.[0].id // empty')"
  USER_META="$(printf '%s' "$USER_INS" | jq -c '.[0].metadata // {}')"
  USER_STRIPPED="$(printf '%s' "$USER_META" | jq '[(has("connector_source")),(has("connector_artifact_id")),(has("account_id")),(has("envelope_id")),(has("_signers")),(has("_docusign_env")),(has("_direction")),(has("_sending_account_id"))] | any | not')"
  USER_KEPT_UNGUARDED="$(printf '%s' "$USER_META" | jq -r '.soak_probe // "MISSING"')"

  FP2="$(openssl rand -hex 32)"
  SVC_INS="$(sb_service POST "anchors?select=id,metadata" \
    "{\"user_id\":\"$USER_A\",\"org_id\":\"$ORG_A\",\"status\":\"PENDING\",\"fingerprint\":\"$FP2\",\"filename\":\"soak-svc-$CYCLE.pdf\",\"metadata\":$FORGED_META}")"
  SVC_ANCHOR_ID="$(printf '%s' "$SVC_INS" | jq -r '.[0].id // empty')"
  SVC_KEPT="$(printf '%s' "$SVC_INS" | jq '[.[0].metadata | (has("connector_source")),(has("connector_artifact_id")),(has("account_id")),(has("envelope_id")),(has("_signers")),(has("_docusign_env")),(has("_direction")),(has("_sending_account_id"))] | all')"

  # owner tries to tamper the service-stamped row -> trigger must REVERT
  TAMPER_RESP="$(sb_user PATCH "anchors?id=eq.$SVC_ANCHOR_ID&select=id,metadata" \
    '{"metadata":{"connector_source":"TAMPERED","account_id":"TAMPERED","envelope_id":"TAMPERED","_signers":[],"_docusign_env":"TAMPERED","_direction":"TAMPERED","_sending_account_id":"TAMPERED","owner_note":"unrelated edit"}}')"
  AFTER="$(sb_service GET "anchors?id=eq.$SVC_ANCHOR_ID&select=metadata")"
  REVERTED="$(printf '%s' "$AFTER" | jq '.[0].metadata.connector_source == "docusign" and .[0].metadata.account_id == "FORGED-ACCT" and .[0].metadata._direction == "inbound"')"

  # ---- cron paths --------------------------------------------------------
  SUB_BEFORE="$(sb_service GET "anchors?select=id&status=in.(SUBMITTED,SECURED)" | jq 'length // 0')"
  DRAIN="$(curl -s -m 90 -X POST "$URL/jobs/drain-connector-artifacts" \
    -H "Authorization: Bearer $TOKEN" -H "X-Cron-Secret: $CRON_SECRET" -H "Content-Length: 0")"
  FLUSH="$(curl -s -m 150 -X POST "$URL/jobs/batch-anchors?force=true" \
    -H "Authorization: Bearer $TOKEN" -H "X-Cron-Secret: $CRON_SECRET" -H "Content-Length: 0")"
  SUB_AFTER="$(sb_service GET "anchors?select=id&status=in.(SUBMITTED,SECURED)" | jq 'length // 0')"
  SECURED_AFTER="$(sb_service GET "anchors?select=id&status=eq.SECURED" | jq 'length // 0')"
  PEND_AFTER="$(sb_service GET "anchors?select=id&status=eq.PENDING" | jq 'length // 0')"

  # ---- §1.6A leak probes --------------------------------------------------
  LASTERR_LEAK="$(sb_service GET "job_queue?select=id&last_error=ilike.*${PII_MARKER}*" | jq 'length // 0')"
  ARTIFACTS="$(sb_service GET "connector_artifact?select=id" | jq 'length // 0')"
  NONCE_TOTAL="$(sb_service GET "docusign_webhook_nonces?select=id" | jq 'length // 0')"
  ANCHOR_TOTAL="$(sb_service GET "anchors?select=id" | jq 'length // 0')"

  jq -nc \
    --arg cycle "$CYCLE" --arg started "$CY_START" --arg ended "$(now_iso)" \
    --arg a_out "$A_OUT" --arg b_out "$B_OUT" --arg a_replay "$A_REPLAY" \
    --arg in_code "$IN_CODE" --argjson in_resp "$(printf '%s' "$IN_RESP" | jq -c . 2>/dev/null || echo '{}')" \
    --argjson in_nonces "${IN_NONCES:-0}" \
    --arg badsig "$BADSIG" --arg orphan "$ORPHAN" \
    --argjson user_stripped "${USER_STRIPPED:-false}" --arg user_kept_unguarded "$USER_KEPT_UNGUARDED" \
    --argjson svc_kept "${SVC_KEPT:-false}" --argjson reverted "${REVERTED:-false}" \
    --argjson drain "$(printf '%s' "$DRAIN" | jq -c . 2>/dev/null || echo '{}')" \
    --argjson flush "$(printf '%s' "$FLUSH" | jq -c . 2>/dev/null || echo '{}')" \
    --argjson lasterr_leak "${LASTERR_LEAK:-0}" --argjson artifacts "${ARTIFACTS:-0}" \
    --argjson sub_before "${SUB_BEFORE:-0}" --argjson sub_after "${SUB_AFTER:-0}" --argjson pend_after "${PEND_AFTER:-0}" \
    --argjson secured_after "${SECURED_AFTER:-0}" \
    --argjson nonce_total "${NONCE_TOTAL:-0}" --argjson anchor_total "${ANCHOR_TOTAL:-0}" \
    --argjson health "$(printf '%s' "$HEALTH" | jq -c . 2>/dev/null || echo '{}')" \
    --arg inbound_flag "${INBOUND_FLAG:-off}" \
    '{cycle: ($cycle|tonumber), started_at:$started, ended_at:$ended, inbound_flag:$inbound_flag,
      trigger_a_nonce_tenant_scope:{org_a_first:$a_out, org_b_same_tuple:$b_out, org_a_replay:$a_replay},
      trigger_b_inbound:{http:$in_code, first_response:$in_resp, nonce_rows_for_first_inbound:$in_nonces},
      negative_controls:{bad_signature:$badsig, unknown_account_orphan:$orphan},
      guard_0423:{user_insert_keys_stripped:$user_stripped, user_unguarded_key_kept:$user_kept_unguarded,
                  service_role_keys_preserved:$svc_kept, owner_tamper_reverted:$reverted},
      cron:{drain:$drain, batch_flush:$flush,
            daily_flush_observation:{flushed_before:$sub_before, flushed_after:$sub_after,
                                     newly_flushed:($sub_after-$sub_before), pending_left:$pend_after,
                                     secured_total:$secured_after}},
      leak_1_6a:{job_queue_last_error_hits:$lasterr_leak},
      totals:{connector_artifacts:$artifacts, nonces:$nonce_total, anchors:$anchor_total},
      health:$health}' \
    > "$SOAKDIR/evidence/cycle-$(date -u +%Y%m%dT%H%M%SZ).json"

  sleep "${CYCLE_SLEEP:-300}"
done
echo "soak window complete at $(now_iso)"
