#!/usr/bin/env bash
# DocuSign guard T3 soak driver v2 (bash 3.2 compatible).
#
# WHY v2 — three defects in v1 made the 2026-08-31..09-02 run hollow:
#   1. Success was HTTP-code-only: `[ "$C_OUTA" = "202" ] && OK=...`. Outbound
#      events are silently orphan-dropped when the integration has no access
#      token (rig had has_tokens=false), so 381 probes returned 202 and created
#      ZERO connector_artifact rows. Same class as the hollow-200
#      statement_timeout incident. v2 asserts DB deltas, not status codes.
#   2. No guard probe at all — PR #2472's entire changed behavior (the 0423
#      write-authority trigger) was never exercised in 191 cycles.
#   3. No restart detection: the worker restarted 3x on 09-01 and the 48h
#      "continuous" claim survived 12h undetected. v2 records uptime and flags
#      any reset.
set -uo pipefail
export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3
SOAKDIR="$HOME/arkova-soak/docusign-bilateral"
source "$SOAKDIR/rig.env"   # URL, PGURI, HMAC, ACCT_A, ACCT_B, ORG_A, ORG_B, USER_A, SOAK_END

SOAK_LOCK="$SOAKDIR/supervisor.pid"
if [ -f "$SOAK_LOCK" ] && kill -0 "$(cat "$SOAK_LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "refusing to start: supervisor $(cat "$SOAK_LOCK") already running" >&2; exit 3
fi
echo $$ > "$SOAK_LOCK"; trap 'rm -f "$SOAK_LOCK"' EXIT
END_EPOCH="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$SOAK_END" +%s)"

q() { psql "$PGURI" -At -c "$1" 2>/dev/null; }

# --- Guard probe: all four branches of the 0423 trigger. -------------------
# A direct psql connection sets no request.jwt.* GUC, so get_caller_role()
# returns NULL and the guard treats it as untrusted -- exactly the forgery path.
guard_probe() {
  # ONE psql session: set_config is session-scoped, so the role GUC and the
  # INSERT it governs MUST share a connection. Splitting them across `psql -c`
  # calls silently ran every branch as an untrusted caller (cycle 1: "0000").
  local n="$1" out
  out="$(psql "$PGURI" -At -v ON_ERROR_STOP=1 <<SQL 2>/dev/null | tail -1
SELECT set_config('request.jwt.claim.role','',false);
INSERT INTO public.anchors (user_id,org_id,fingerprint,filename,metadata) VALUES
 ('$USER_A','$ORG_A',encode(gen_random_bytes(32),'hex'),'GUARDPROBE-A-$n','{"connector_source":"docusign","account_id":"FORGED","envelope_id":"FORGED","_signers":[{"recipient_id_guid":"x"}],"_docusign_env":"prod","_direction":"inbound","_sending_account_id":"F","connector_artifact_id":"F","benign":"KEEP"}'::jsonb),
 ('$USER_A','$ORG_A',encode(gen_random_bytes(32),'hex'),'GUARDPROBE-B-$n','{"account_id":"LEGIT","envelope_id":"LEGIT","benign":"KEEP"}'::jsonb);
SELECT set_config('request.jwt.claim.role','service_role',false);
INSERT INTO public.anchors (user_id,org_id,fingerprint,filename,metadata) VALUES
 ('$USER_A','$ORG_A',encode(gen_random_bytes(32),'hex'),'GUARDPROBE-C-$n','{"connector_source":"docusign","account_id":"REAL","envelope_id":"REAL"}'::jsonb);
SELECT set_config('request.jwt.claim.role','',false);
UPDATE public.anchors SET metadata = metadata || '{"account_id":"HIJACK"}'::jsonb WHERE filename='GUARDPROBE-C-$n';
SELECT
   (SELECT (NOT (metadata ?| ARRAY['connector_source','account_id','envelope_id','_signers','_docusign_env','_direction','_sending_account_id','connector_artifact_id']) AND metadata->>'benign'='KEEP')::int::text FROM public.anchors WHERE filename='GUARDPROBE-A-$n')
||(SELECT (metadata->>'account_id'='LEGIT' AND metadata->>'envelope_id'='LEGIT')::int::text FROM public.anchors WHERE filename='GUARDPROBE-B-$n')
||(SELECT (metadata->>'connector_source'='docusign')::int::text FROM public.anchors WHERE filename='GUARDPROBE-C-$n')
||(SELECT (metadata->>'account_id'='REAL')::int::text FROM public.anchors WHERE filename='GUARDPROBE-C-$n');
SQL
)"
  psql "$PGURI" -At -c "DELETE FROM public.anchors WHERE filename LIKE 'GUARDPROBE-%-$n';" >/dev/null 2>&1
  echo "${out:-0000}"
}

post() { local sig
  sig="$(printf '%s' "$1" | openssl dgst -sha256 -hmac "$HMAC" -binary | base64)"
  curl -s -o /dev/null -w '%{http_code}' -m 25 -X POST "$URL/webhooks/docusign$2" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "X-DocuSign-Signature-1: $sig" --data "$1"
}
env_body() {
cat <<JSON
{"event":"envelope-completed","apiVersion":"v2.1","uri":"/x","retryCount":0,"configurationId":1,"generatedDateTime":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","eventId":"$2","data":{"accountId":"$3","envelopeId":"$1","envelopeSummary":{"status":"completed","sender":{"email":"s@soak.test","accountId":"$4"},"envelopeDocuments":[{"documentId":"1","name":"c.pdf","documentIdGuid":"$(uuidgen|tr 'A-Z' 'a-z')","sha256":"$5"}]}},"envelopeSummary":{"recipients":{"signers":[{"recipientIdGuid":"$(uuidgen|tr 'A-Z' 'a-z')","userId":"$(uuidgen|tr 'A-Z' 'a-z')","status":"completed","signedDateTime":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","name":"PII Name Marker","email":"pii-marker@example.com"}]}}}
JSON
}
newid() { uuidgen | tr 'A-Z' 'a-z'; }
CYCLE=0; PREV_UPTIME=0; RESTARTS=0
while [ "$(date -u +%s)" -lt "$END_EPOCH" ]; do
  CYCLE=$((CYCLE+1)); TS="$(date -u +%s)"
  TOKEN="$(gcloud auth print-identity-token 2>/dev/null)"
  CRON="$(gcloud secrets versions access latest --secret=cron-secret --project=arkova1 2>/dev/null)"

  ART_BEFORE="$(q 'SELECT count(*) FROM public.connector_artifact;')"
  ANC_BEFORE="$(q 'SELECT count(*) FROM public.anchors;')"

  # Drive BOTH orgs inbound so per-org isolation is genuinely exercised.
  C_IN_A="$(post "$(env_body "$(newid)" "c$CYCLE-ia-$TS" "$ACCT_A" "ffffffff-9999-4999-8999-ffffffffffff" "$(openssl rand -hex 32)")" "?customrecipient=true")"
  C_IN_B="$(post "$(env_body "$(newid)" "c$CYCLE-ib-$TS" "$ACCT_B" "ffffffff-9999-4999-8999-ffffffffffff" "$(openssl rand -hex 32)")" "?customrecipient=true")"
  RB="$(env_body "$(newid)" "c$CYCLE-r-$TS" "$ACCT_A" "ffffffff-9999-4999-8999-ffffffffffff" "$(openssl rand -hex 32)")"
  post "$RB" "?customrecipient=true" >/dev/null; C_REPLAY="$(post "$RB" "?customrecipient=true")"
  C_BADSIG="$(curl -s -o /dev/null -w '%{http_code}' -m 25 -X POST "$URL/webhooks/docusign?customrecipient=true" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "X-DocuSign-Signature-1: deadbeef" --data "$(env_body "$(newid)" "c$CYCLE-x-$TS" "$ACCT_A" "ffffffff-9999-4999-8999-ffffffffffff" "$(openssl rand -hex 32)")")"

  GUARD="$(guard_probe "$CYCLE")"

  # Anchor lifecycle load, both tenants, written as service_role exactly like
  # the connector drain does -- so the guard's service_role-preserve branch and
  # the batch/confirm lifecycle are exercised under real multi-tenant volume.
  # Same single-session rule as guard_probe: the service_role GUC and the INSERTs
  # it authorises must share one connection, or the guard strips connector_source
  # off the load rows (observed: orgs_with_docusign=0 on the first attempt).
  psql "$PGURI" -At -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>&1
SELECT set_config('request.jwt.claim.role','service_role',false);
INSERT INTO public.anchors (user_id,org_id,fingerprint,filename,status,metadata) VALUES
 ('$USER_A','$ORG_A',encode(gen_random_bytes(32),'hex'),'soak-c$CYCLE-a.pdf','PENDING',
  jsonb_build_object('connector_source','docusign','account_id','$ACCT_A','envelope_id','env-a-$CYCLE-$TS','_direction','inbound','_sending_account_id','ffffffff-9999-4999-8999-ffffffffffff')),
 ('$USER_A','$ORG_B',encode(gen_random_bytes(32),'hex'),'soak-c$CYCLE-b.pdf','PENDING',
  jsonb_build_object('connector_source','docusign','account_id','$ACCT_B','envelope_id','env-b-$CYCLE-$TS','_direction','inbound','_sending_account_id','ffffffff-9999-4999-8999-ffffffffffff'));
SQL

  DRAIN="$(curl -s -m 90 -X POST "$URL/jobs/drain-connector-artifacts" -H "Authorization: Bearer $TOKEN" -H "X-Cron-Secret: $CRON" -H "Content-Type: application/json" -d '{}')"
  TRIGA="$(curl -s -m 90 -X POST "$URL/jobs/batch-anchors" -H "Authorization: Bearer $TOKEN" -H "X-Cron-Secret: $CRON" -H "Content-Type: application/json" -d '{}')"
  FLUSH="$(curl -s -m 120 -X POST "$URL/jobs/batch-anchors?force=true" -H "Authorization: Bearer $TOKEN" -H "X-Cron-Secret: $CRON" -H "Content-Type: application/json" -d '{}')"
  TRIGB="$(curl -s -m 90 -X POST "$URL/jobs/check-confirmations" -H "Authorization: Bearer $TOKEN" -H "X-Cron-Secret: $CRON" -H "Content-Type: application/json" -d '{}')"
  DRAIN2="$(curl -s -m 90 -X POST "$URL/jobs/drain-connector-artifacts" -H "Authorization: Bearer $TOKEN" -H "X-Cron-Secret: $CRON" -H "Content-Type: application/json" -d '{}')"

  ART_AFTER="$(q 'SELECT count(*) FROM public.connector_artifact;')"
  ANC_AFTER="$(q 'SELECT count(*) FROM public.anchors;')"
  ART_DELTA=$(( ${ART_AFTER:-0} - ${ART_BEFORE:-0} ))
  ANC_DELTA=$(( ${ANC_AFTER:-0} - ${ANC_BEFORE:-0} ))
  ORG_ISO="$(q "SELECT count(DISTINCT org_id) FROM public.anchors WHERE metadata ? 'connector_source';")"

  H="$(curl -s -m 20 -H "Authorization: Bearer $TOKEN" "$URL/health")"
  UP="$(printf '%s' "$H" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("uptime",0))' 2>/dev/null || echo 0)"
  [ "${UP:-0}" -lt "$PREV_UPTIME" ] && RESTARTS=$((RESTARTS+1))
  PREV_UPTIME="${UP:-0}"

  # HARD assertions: DB deltas, not HTTP codes.
  OK=0
  [ "$C_IN_A" = "202" ] && OK=$((OK+1)); [ "$C_IN_B" = "202" ] && OK=$((OK+1))
  [ "$C_REPLAY" = "200" ] && OK=$((OK+1)); [ "$C_BADSIG" = "401" ] && OK=$((OK+1))
  [ "$GUARD" = "1111" ] && OK=$((OK+1))
  [ "$ANC_DELTA" -ge 2 ] && OK=$((OK+1))
  FAIL=$((6-OK))

  printf '{"cycle":%d,"ts":"%s","ok":%d,"fail":%d,"guard":"%s","artifact_delta":%d,"anchor_delta":%d,"orgs_with_docusign":%s,"restarts":%d,"uptime":%s,"codes":{"inbound_A":"%s","inbound_B":"%s","replay":"%s","wrong_hmac":"%s"},"drain":%s,"drain2":%s,"triggerA":%s,"flush":%s,"triggerB":%s,"health":%s}\n' \
    "$CYCLE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OK" "$FAIL" "$GUARD" "$ART_DELTA" "$ANC_DELTA" "${ORG_ISO:-0}" "$RESTARTS" "${UP:-0}" \
    "$C_IN_A" "$C_IN_B" "$C_REPLAY" "$C_BADSIG" \
    "${DRAIN:-null}" "${DRAIN2:-null}" "${TRIGA:-null}" "${FLUSH:-null}" "${TRIGB:-null}" "${H:-null}" \
    > "$SOAKDIR/evidence-v2/cycle-$(date -u +%Y%m%dT%H%M%SZ).json"
  sleep 300
done
echo "supervisor-v2 done $(date -u +%Y-%m-%dT%H:%M:%SZ) restarts=$RESTARTS" >> "$SOAKDIR/supervisor.log"
