#!/usr/bin/env bash
set -euo pipefail

PG_BIN="${UAT12_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PSQL="$PG_BIN/psql"
CREATEDB="$PG_BIN/createdb"
DROPDB="$PG_BIN/dropdb"
export PGHOST="${PGHOST:-127.0.0.1}"
case "$PGHOST" in 127.0.0.1|localhost|::1|/tmp|/var/run/postgresql) ;; *) echo 'Native test requires a local PostgreSQL host' >&2; exit 2 ;; esac

DB="arkova_uat12_quota_${$}_${RANDOM}"
A_LOG="/tmp/uat12-quota-a-${$}-${RANDOM}"
B_LOG="/tmp/uat12-quota-b-${$}-${RANDOM}"
$CREATEDB "$DB"
trap '$DROPDB --if-exists "$DB" >/dev/null 2>&1 || true; rm -f "$A_LOG" "$B_LOG"' EXIT

$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<'SQL' >/dev/null
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth; CREATE SCHEMA private;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
CREATE FUNCTION private.is_human_mfa_verified() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE TYPE public.anchor_status AS ENUM ('PENDING','BROADCASTING','SUBMITTED','SECURED','REVOKED','SUPERSEDED','FAILED');
CREATE TYPE public.credential_type AS ENUM ('OTHER');
CREATE TYPE public.credit_transaction_type AS ENUM ('ALLOCATION','PURCHASE','DEDUCTION','EXPIRY','REFUND');
CREATE TYPE public.org_tier AS ENUM ('FREE','PAID','ENTERPRISE');
CREATE TABLE organizations(id uuid PRIMARY KEY, tier org_tier NOT NULL DEFAULT 'FREE');
CREATE TABLE anchors(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fingerprint text NOT NULL, public_id text NOT NULL UNIQUE, status anchor_status NOT NULL, org_id uuid REFERENCES organizations, user_id uuid REFERENCES auth.users, filename text, file_size bigint, file_mime text, credential_type credential_type, description text, fingerprint_source text, metadata jsonb, chain_tx_id text, deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX idx_anchors_user_fingerprint_unique ON anchors(user_id,fingerprint) WHERE deleted_at IS NULL;
CREATE TABLE job_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text, payload jsonb, priority int, max_attempts int, status text, attempts int);
CREATE TABLE credits(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES auth.users, balance int NOT NULL DEFAULT 0, monthly_allocation int DEFAULT 0, purchased int DEFAULT 0, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE credit_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users, transaction_type credit_transaction_type, amount int, balance_after int, reason text, reference_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE org_credits(org_id uuid PRIMARY KEY REFERENCES organizations, balance int DEFAULT 0, monthly_allocation int DEFAULT 0, purchased int DEFAULT 0, anchor_quota int, cap_enforced boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE org_credit_deductions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations, reference_id uuid, reason text, amount int, balance_after int, entry_type text, created_at timestamptz DEFAULT now(), UNIQUE(org_id,reference_id,reason));
CREATE TABLE anchor_txid_journal(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), anchor_ids uuid[], recovery_status text);
CREATE TABLE org_daily_usage(org_id uuid REFERENCES organizations, usage_date date, quota_kind text, count bigint NOT NULL, updated_at timestamptz, PRIMARY KEY(org_id,usage_date,quota_kind));
CREATE FUNCTION get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid WHERE false $$;
SQL

$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0461_uat12_private_tags_submit_actions.sql >/dev/null
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0474_uat12_atomic_anchor_create_quota.sql >/dev/null
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0475_atomic_contractual_anchor_cap.sql >/dev/null

U=11111111-1111-4111-8111-111111111111
O=22222222-2222-4222-8222-222222222222
X=33333333-3333-4333-8333-333333333333
Y=44444444-4444-4444-8444-444444444444
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO auth.users VALUES ('$U');
INSERT INTO organizations(id,tier) VALUES ('$O','FREE'),('$X','FREE'),('$Y','FREE');
INSERT INTO org_daily_usage VALUES ('$O',(now() AT TIME ZONE 'UTC')::date,'anchors_created',99,now());
INSERT INTO org_credits(org_id,anchor_quota,cap_enforced) VALUES ('$X',1,true);
SQL

call_create() {
  local fingerprint="$1" public_id="$2" org_sql="$3" action="${4:-queue}"
  $PSQL -At -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT create_anchor_submission('$fingerprint','$public_id','$U',$org_sql,'doc.pdf',1,'application/pdf','OTHER',NULL,'document_bytes','{}',ARRAY['quota'],'{}','$action');"
}

# Two different fingerprints race for the final FREE-tier slot. Exactly one
# transaction creates all of its rows; the other returns quota_exceeded and
# leaves no anchor, tags, intent, or job behind.
( call_create "$(printf 'a%.0s' {1..64})" 'ARK-QUOTA-A' "'$O'" instant >"$A_LOG" ) & a_pid=$!
( call_create "$(printf 'b%.0s' {1..64})" 'ARK-QUOTA-B' "'$O'" instant >"$B_LOG" ) & b_pid=$!
wait "$a_pid" "$b_pid"
[[ "$($PSQL -At -d "$DB" -c "SELECT count FROM org_daily_usage WHERE org_id='$O' AND quota_kind='anchors_created';")" == 100 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchors WHERE org_id='$O';")" == 1 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchor_instant_intents i JOIN anchors a ON a.id=i.anchor_id WHERE a.org_id='$O';")" == 1 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM job_queue WHERE type='anchor.instant_secure';")" == 1 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchor_private_tags t JOIN anchors a ON a.id=t.anchor_id WHERE a.org_id='$O';")" == 1 ]]
[[ "$(cat "$A_LOG"; cat "$B_LOG")" == *'"error": "quota_exceeded"'* ]]

# The contractual lifetime cap is independent of the tier daily counter. Two
# requests racing for its final slot serialize on org_credits; exactly one
# anchor is committed and the loser reports the contractual boundary. The
# winner still consumes the separate daily quota exactly once.
( call_create "$(printf '1%.0s' {1..64})" 'ARK-CONTRACT-A' "'$X'" >"$A_LOG" ) & a_pid=$!
( call_create "$(printf '2%.0s' {1..64})" 'ARK-CONTRACT-B' "'$X'" >"$B_LOG" ) & b_pid=$!
wait "$a_pid" "$b_pid"
contract_anchor_count=$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchors WHERE org_id='$X';")
contract_daily_count=$($PSQL -At -d "$DB" -c "SELECT count FROM org_daily_usage WHERE org_id='$X' AND quota_kind='anchors_created';")
contract_results=$(cat "$A_LOG" "$B_LOG")
if [[ "$contract_anchor_count" != 1 || "$contract_daily_count" != 1 ]]; then
  echo "contractual final-slot race was not conserved: anchors=$contract_anchor_count daily=$contract_daily_count" >&2
  exit 1
fi
if [[ "$contract_results" != *'"error": "contractual_quota_exceeded"'* ]]; then
  echo 'contractual final-slot loser did not return contractual_quota_exceeded' >&2
  exit 1
fi

# A contended contractual authority fails within the function's five-second
# lock deadline instead of holding a request until the outer statement timeout.
$PSQL -v ON_ERROR_STOP=1 -d "$DB" >"$A_LOG" 2>&1 <<SQL & lock_pid=$!
BEGIN;
SELECT org_id FROM org_credits WHERE org_id='$X' FOR UPDATE;
\echo CONTRACT_LOCK_HELD
SELECT pg_sleep(7);
ROLLBACK;
SQL
for _ in {1..100}; do
  grep -q CONTRACT_LOCK_HELD "$A_LOG" && break
  sleep 0.05
done
grep -q CONTRACT_LOCK_HELD "$A_LOG" || { echo 'contract lock fixture did not acquire' >&2; exit 1; }
lock_started=$(date +%s)
set +e
call_create "$(printf '3%.0s' {1..64})" 'ARK-CONTRACT-CONTENDED' "'$X'" >"$B_LOG" 2>&1
lock_rc=$?
set -e
lock_elapsed=$(( $(date +%s) - lock_started ))
wait "$lock_pid"
if [[ "$lock_rc" -eq 0 || "$lock_elapsed" -lt 4 || "$lock_elapsed" -gt 6 ]]; then
  echo "contract lock deadline failed: rc=$lock_rc elapsed=${lock_elapsed}s" >&2
  exit 1
fi
grep -qi 'lock timeout' "$B_LOG" || { echo 'contended call did not report lock timeout' >&2; exit 1; }

# Only the canonical active (user_id,fingerprint) collision is an idempotency
# duplicate. A collision on an unrelated unique key must remain an operational
# error; otherwise the worker falsely reports fingerprint_conflict and hides a
# broken public-id generator or another schema invariant.
OTHER_FP=$(printf '9%.0s' {1..64})
if call_create "$OTHER_FP" "$($PSQL -At -d "$DB" -c "SELECT public_id FROM anchors WHERE org_id='$O' LIMIT 1;")" "'$Y'" >"$A_LOG" 2>&1; then
  echo 'unrelated public_id collision was misclassified as a duplicate' >&2
  exit 1
fi
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchors WHERE fingerprint='$OTHER_FP';")" == 0 ]]

# A same-scope replay and a cross-scope same-user conflict both hit the existing
# global identity constraint and consume no additional quota or metadata writes.
WIN_FP=$($PSQL -At -d "$DB" -c "SELECT trim(fingerprint) FROM anchors WHERE org_id='$O';")
before=$($PSQL -At -d "$DB" -c "SELECT count FROM org_daily_usage WHERE org_id='$O' AND quota_kind='anchors_created';")
[[ "$(call_create "$WIN_FP" 'ARK-REPLAY' "'$O'")" == *'"error": "duplicate"'* ]]
[[ "$(call_create "$WIN_FP" 'ARK-CROSS-SCOPE' "'$Y'")" == *'"error": "duplicate"'* ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count FROM org_daily_usage WHERE org_id='$O' AND quota_kind='anchors_created';")" == "$before" ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_daily_usage WHERE org_id='$Y';")" == 0 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchors WHERE org_id='$Y';")" == 0 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchor_private_tags t JOIN anchors a ON a.id=t.anchor_id WHERE a.org_id='$O';")" == 1 ]]

# Personal scope preserves the existing no-org-quota boundary and still creates
# queue/instant state atomically. It never invents an org_daily_usage row.
PFP=$(printf 'c%.0s' {1..64})
[[ "$(call_create "$PFP" 'ARK-PERSONAL' NULL instant)" == *'"success": true'* ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchors WHERE org_id IS NULL AND user_id='$U';")" == 1 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_daily_usage;")" == 1 ]]

# NULL scalar/array inputs return one bounded validation result and leave every
# canonical-create table unchanged. PostgreSQL's three-valued predicates must
# never let NULL action/fingerprint through or let FOREACH throw on NULL arrays.
before_rows=$($PSQL -At -d "$DB" -c "SELECT (SELECT count(*) FROM anchors)||':'||(SELECT count(*) FROM anchor_private_tags)||':'||(SELECT count(*) FROM anchor_instant_intents)||':'||(SELECT count(*) FROM job_queue)||':'||(SELECT sum(count) FROM org_daily_usage);")
for invalid_call in \
  "NULL,'ARK-NULL-FP','$U','$O','x',1,NULL,'OTHER',NULL,NULL,'{}','{}','{}','queue'" \
  "'$(printf 'e%.0s' {1..64})','ARK-NULL-ACTION','$U','$O','x',1,NULL,'OTHER',NULL,NULL,'{}','{}','{}',NULL" \
  "'$(printf 'f%.0s' {1..64})','ARK-NULL-USER-TAGS','$U','$O','x',1,NULL,'OTHER',NULL,NULL,'{}',NULL::text[],'{}','queue'" \
  "'$(printf '0%.0s' {1..64})','ARK-NULL-ORG-TAGS','$U','$O','x',1,NULL,'OTHER',NULL,NULL,'{}','{}',NULL::text[],'queue'"; do
  invalid=$($PSQL -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT create_anchor_submission($invalid_call)->>'error';")
  [[ "${invalid##*$'\n'}" == 'invalid_request' ]]
done
[[ "$($PSQL -At -d "$DB" -c "SELECT (SELECT count(*) FROM anchors)||':'||(SELECT count(*) FROM anchor_private_tags)||':'||(SELECT count(*) FROM anchor_instant_intents)||':'||(SELECT count(*) FROM job_queue)||':'||(SELECT sum(count) FROM org_daily_usage);")" == "$before_rows" ]]

# Unknown role cannot call the SECURITY DEFINER boundary.
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "RESET request.jwt.claim.role; SELECT create_anchor_submission('$(printf 'd%.0s' {1..64})','ARK-DENIED','$U',NULL,'x',1,NULL,'OTHER',NULL,NULL,'{}','{}','{}','queue');" >/dev/null 2>&1; then exit 1; fi

echo 'UAT-12 native atomic quota PASS daily=one-winner contractual=one-winner independent-counters=yes lock-timeout=5s duplicate=zero-charge unrelated-unique=raised cross-scope=bounded personal=no-org-quota null-inputs=bounded null-role=denied'
