#!/usr/bin/env bash
set -euo pipefail

PG_BIN="${UAT12_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PSQL="$PG_BIN/psql"
CREATEDB="$PG_BIN/createdb"
DROPDB="$PG_BIN/dropdb"
export PGHOST="${PGHOST:-127.0.0.1}"
case "$PGHOST" in 127.0.0.1|localhost|::1|/tmp|/var/run/postgresql) ;; *) echo 'Native test requires a local PostgreSQL host' >&2; exit 2 ;; esac

DB="arkova_uat12_conservation_${$}_${RANDOM}"
MIGRATION_LOG="/tmp/uat12-conservation-migration-${$}-${RANDOM}"
GRANT_LOG="/tmp/uat12-conservation-grant-${$}-${RANDOM}"
$CREATEDB "$DB"
trap '$DROPDB --if-exists "$DB" >/dev/null 2>&1 || true; rm -f "$MIGRATION_LOG" "$GRANT_LOG"' EXIT

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
CREATE TABLE organizations(id uuid PRIMARY KEY);
CREATE TABLE anchors(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fingerprint text NOT NULL, public_id text NOT NULL UNIQUE, status anchor_status NOT NULL, org_id uuid REFERENCES organizations, user_id uuid REFERENCES auth.users, filename text, file_size bigint, file_mime text, credential_type credential_type, description text, fingerprint_source text, metadata jsonb, chain_tx_id text, deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE job_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text, payload jsonb, priority int, max_attempts int, status text, attempts int);
CREATE TABLE credits(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES auth.users, balance int NOT NULL DEFAULT 0 CHECK(balance >= 0), monthly_allocation int NOT NULL DEFAULT 0, purchased int NOT NULL DEFAULT 0, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE credit_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users, transaction_type credit_transaction_type, amount int, balance_after int, reason text, reference_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE org_credits(org_id uuid PRIMARY KEY REFERENCES organizations, balance int NOT NULL DEFAULT 0 CHECK(balance >= 0), monthly_allocation int NOT NULL DEFAULT 0, purchased int NOT NULL DEFAULT 0, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE org_credit_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_org_id uuid REFERENCES organizations, child_org_id uuid REFERENCES organizations, amount int NOT NULL);
CREATE TABLE org_credit_deductions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations, reference_id uuid, reason text, amount int NOT NULL, balance_after int NOT NULL CHECK(balance_after >= 0), entry_type text NOT NULL CHECK(entry_type IN ('DEBIT','REFUND','GRANT','REVOKE')), created_at timestamptz DEFAULT now(), UNIQUE(org_id,reference_id,reason));
CREATE FUNCTION reject_org_credit_deduction_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only'; END $$;
CREATE TRIGGER trg_org_credit_deductions_append_only BEFORE UPDATE OR DELETE ON org_credit_deductions FOR EACH ROW EXECUTE FUNCTION reject_org_credit_deduction_mutation();
CREATE TABLE anchor_txid_journal(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), anchor_ids uuid[], recovery_status text);
CREATE FUNCTION get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid WHERE false $$;
SQL

$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0349_scrum2349_credit_conservation_invariant_fix.sql >/dev/null
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0461_uat12_private_tags_submit_actions.sql >/dev/null

U=11111111-1111-4111-8111-111111111111
O=22222222-2222-4222-8222-222222222222
BAD=33333333-3333-4333-8333-333333333333
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO auth.users VALUES ('$U');
INSERT INTO organizations VALUES ('$O'), ('$BAD');
INSERT INTO org_credits(org_id,balance,purchased) VALUES ('$O',0,0),('$BAD',0,0);
INSERT INTO credits(user_id,balance,purchased) VALUES ('$U',0,0);
SET request.jwt.claim.role='service_role';
SELECT grant_purchased_anchor_credits('evt-baseline','cs-baseline','$U',NULL,'$O',7,1400,'usd');
SQL

[[ "$($PSQL -At -d "$DB" -c "SELECT divergence FROM org_credit_ledger_divergence('$O');")" == '-7' ]]

# Malformed legacy-looking rows do not satisfy the exact receipt join.
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO org_credit_deductions(org_id,reference_id,reason,amount,balance_after,entry_type)
VALUES ('$BAD',gen_random_uuid(),'anchor.credit_purchase',9,0,'GRANT');
SQL

# Hold the final ledger lock. The migration acquires purchase + balance locks,
# then waits here; a concurrent old-function grant must wait behind its purchase
# lock and resume only after CREATE OR REPLACE commits.
( $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "BEGIN; LOCK TABLE org_credit_deductions IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(1.5); COMMIT;" >/dev/null ) & blocker_pid=$!
sleep 0.15
( $PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0473_uat12_anchor_credit_purchase_conservation.sql >"$MIGRATION_LOG" 2>&1 ) & migration_pid=$!
sleep 0.15
( $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT grant_purchased_anchor_credits('evt-race','cs-race','$U',NULL,'$O',3,600,'usd');" >"$GRANT_LOG" 2>&1 ) & grant_pid=$!
sleep 0.2
[[ "$($PSQL -At -d "$DB" -c "SELECT wait_event_type FROM pg_stat_activity WHERE datname='$DB' AND query LIKE '%evt-race%' AND state='active';")" == 'Lock' ]]
wait "$blocker_pid" "$migration_pid" "$grant_pid"

# Baseline receipt is reclassified, concurrent purchase uses corrected body,
# replay changes nothing, malformed row is untouched, conservation is restored.
[[ "$($PSQL -At -d "$DB" -c "SELECT divergence FROM org_credit_ledger_divergence('$O');")" == '0' ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_credit_deductions WHERE org_id='$O' AND reason='anchor.credit_purchase' AND entry_type='GRANT';")" == '1' ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_credit_deductions WHERE org_id='$O' AND reason='anchor.credit_purchase.principal_reclassification' AND entry_type='REVOKE';")" == '1' ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_credit_deductions WHERE org_id='$BAD' AND reason='anchor.credit_purchase' AND entry_type='GRANT';")" == '1' ]]
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0473_uat12_anchor_credit_purchase_conservation.sql >/dev/null
[[ "$($PSQL -At -d "$DB" -c "SELECT divergence FROM org_credit_ledger_divergence('$O');")" == '0' ]]

# Personal path remains unchanged and idempotent.
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
SET request.jwt.claim.role='service_role';
SELECT grant_purchased_anchor_credits('evt-user','cs-user','$U','$U',NULL,2,400,'usd');
SELECT grant_purchased_anchor_credits('evt-user','cs-user','$U','$U',NULL,2,400,'usd');
SQL
[[ "$($PSQL -At -d "$DB" -c "SELECT balance||':'||purchased FROM credits WHERE user_id='$U';")" == '2:2' ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM credit_transactions WHERE user_id='$U' AND transaction_type='PURCHASE';")" == '1' ]]

# NULL role and NULL scalar inputs fail closed.
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "RESET request.jwt.claim.role; SELECT grant_purchased_anchor_credits('evt-null-role','cs-null-role','$U','$U',NULL,1,200,'usd');" >/dev/null 2>&1; then exit 1; fi
for args in \
  "'evt-null-q','cs-null-q','$U','$U',NULL,NULL,200,'usd'" \
  "'evt-null-a','cs-null-a','$U','$U',NULL,1,NULL,'usd'" \
  "'evt-null-c','cs-null-c','$U','$U',NULL,1,200,NULL"; do
  result=$($PSQL -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT grant_purchased_anchor_credits($args)->>'error';")
  [[ "${result##*$'\n'}" == 'invalid_purchase' ]]
done

echo 'UAT-12 native conservation PASS baseline=-7 corrected=0 replay=0 personal=unchanged malformed=untouched nulls=denied concurrent_grant=serialized'
