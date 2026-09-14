#!/usr/bin/env bash
set -euo pipefail
PG_BIN="${UAT12_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PSQL="$PG_BIN/psql"
CREATEDB="$PG_BIN/createdb"
DROPDB="$PG_BIN/dropdb"
export PGHOST="${PGHOST:-127.0.0.1}"
case "$PGHOST" in 127.0.0.1|localhost|::1|/tmp|/var/run/postgresql) ;; *) echo 'Native test requires a local PostgreSQL host' >&2; exit 2 ;; esac
DB="arkova_uat12_${$}_${RANDOM}"
A_LOG="/tmp/uat12-a-${$}-${RANDOM}"
SETTLE_LOG="/tmp/uat12-settle-${$}-${RANDOM}"
$CREATEDB "$DB"
trap 'rm -f "$A_LOG" "$SETTLE_LOG"; $DROPDB --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<'SQL' >/dev/null
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth; CREATE SCHEMA private;
CREATE TABLE auth.users(id uuid primary key);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
CREATE FUNCTION private.is_human_mfa_verified() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.aal',true)='aal2' $$;
CREATE TYPE public.anchor_status AS ENUM ('PENDING','BROADCASTING','SUBMITTED','SECURED','REVOKED','SUPERSEDED','FAILED');
CREATE TYPE public.credential_type AS ENUM ('OTHER');
CREATE TYPE public.credit_transaction_type AS ENUM ('ALLOCATION','PURCHASE','DEDUCTION','EXPIRY','REFUND');
CREATE TABLE public.organizations(id uuid primary key);
CREATE TABLE public.anchors(id uuid primary key default gen_random_uuid(), fingerprint text not null, public_id text not null unique, status anchor_status not null, org_id uuid references organizations, user_id uuid references auth.users, filename text, file_size bigint, file_mime text, credential_type credential_type, description text, metadata jsonb, chain_tx_id text, deleted_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
CREATE TABLE public.job_queue(id uuid primary key default gen_random_uuid(), type text, payload jsonb, priority int, max_attempts int, status text, attempts int);
CREATE TABLE public.credits(id uuid primary key default gen_random_uuid(), user_id uuid unique references auth.users, org_id uuid, balance int not null default 0 check(balance>=0), monthly_allocation int default 0, purchased int default 0, cycle_start timestamptz, cycle_end timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
CREATE TABLE public.credit_transactions(id uuid primary key default gen_random_uuid(), user_id uuid references auth.users, org_id uuid, transaction_type credit_transaction_type, amount int, balance_after int, reason text, reference_id uuid, created_at timestamptz default now());
CREATE UNIQUE INDEX uq_credit_transactions_user_reference_type ON public.credit_transactions(user_id,reference_id,transaction_type) WHERE reference_id IS NOT NULL;
CREATE TABLE public.org_credits(org_id uuid primary key references organizations, balance int default 0 check(balance>=0), monthly_allocation int default 0, purchased int default 0, cycle_start timestamptz default now(), cycle_end timestamptz default now(), created_at timestamptz default now(), updated_at timestamptz default now());
CREATE TABLE public.org_credit_deductions(id uuid primary key default gen_random_uuid(), org_id uuid references organizations, reference_id uuid, reason text, amount int, balance_after int, entry_type text, created_at timestamptz default now(), unique(org_id,reference_id,reason));
CREATE TABLE public.anchor_txid_journal(id uuid primary key default gen_random_uuid(), anchor_ids uuid[], recovery_status text);
CREATE FUNCTION public.get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid WHERE false $$;
CREATE FUNCTION public.debit_and_enqueue_anchor(p_org_id uuid,p_anchor_id uuid,p_amount int,p_reason text,p_target_status anchor_status,p_expected_status anchor_status) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE b int; n int;
BEGIN
 SELECT balance INTO b FROM org_credits WHERE org_id=p_org_id FOR UPDATE;
 IF b IS NULL THEN RETURN jsonb_build_object('success',false,'error','org_not_initialized'); END IF;
 IF b<p_amount THEN RETURN jsonb_build_object('success',false,'error','insufficient_credits'); END IF;
 UPDATE anchors SET status=p_target_status WHERE id=p_anchor_id AND status=p_expected_status; GET DIAGNOSTICS n=ROW_COUNT;
 IF n=0 THEN RETURN jsonb_build_object('success',false,'error','anchor_not_in_expected_status'); END IF;
 UPDATE org_credits SET balance=balance-p_amount WHERE org_id=p_org_id RETURNING balance INTO b;
 INSERT INTO org_credit_deductions(org_id,reference_id,reason,amount,balance_after,entry_type) VALUES(p_org_id,p_anchor_id,p_reason,-p_amount,b,'DEBIT');
 RETURN jsonb_build_object('success',true);
END $$;
SQL
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0461_uat12_private_tags_submit_actions.sql >/dev/null
# Replace the bootstrap stand-in with the exact canonical 0341 helper body.
sed -n '306,434p' supabase/migrations/0341_scrum2349_2350_credit_integrity_foundation.sql | $PSQL -v ON_ERROR_STOP=1 -d "$DB" >/dev/null
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0463_scrum5212_retry_needs_credit_intent.sql >/dev/null
U=11111111-1111-4111-8111-111111111111
A=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1
P=22222222-2222-4222-8222-222222222222
C=33333333-3333-4333-8333-333333333333
OA=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO auth.users VALUES('$U'); INSERT INTO credits(user_id,balance) VALUES('$U',0);
INSERT INTO organizations VALUES('$P'),('$C'); INSERT INTO org_credits(org_id,balance) VALUES('$P',5),('$C',0);
INSERT INTO anchors(id,fingerprint,public_id,status,user_id,filename,credential_type) VALUES('$A',repeat('a',64),'ARK-RETRY','PENDING','$U','p.pdf','OTHER');
INSERT INTO anchors(id,fingerprint,public_id,status,user_id,org_id,filename,credential_type) VALUES('$OA',repeat('b',64),'ARK-ORG-RETRY','PENDING','$U','$C','o.pdf','OTHER');
SET request.jwt.claim.role='service_role';
SELECT enqueue_existing_anchor_instant_intent('$A','$U',NULL,'{}','{}');
SELECT claim_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$A'),'old');
SELECT grant_purchased_anchor_credits('evt-p','cs-p','$U','$U',NULL,1,200,'usd');
SQL
# Two explicit retries serialize on intent; only the first publishes a new job.
( $PSQL -v ON_ERROR_STOP=1 -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT retry_anchor_instant_intent('$A','$U',NULL);" >"$A_LOG" ) & r1=$!
( $PSQL -v ON_ERROR_STOP=1 -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT retry_anchor_instant_intent('$A','$U',NULL);" >"$SETTLE_LOG" ) & r2=$!
wait "$r1" "$r2"
[[ "$($PSQL -At -d "$DB" -c "SELECT status||':'||rearm_generation||':'||(SELECT count(*) FROM job_queue WHERE type='anchor.instant_secure') FROM anchor_instant_intents WHERE anchor_id='$A';")" == 'QUEUED:1:2' ]]
# Two exact workers race; exactly one debit and one claimed row.
( $PSQL -v ON_ERROR_STOP=1 -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT count(*) FROM claim_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$A'),'w1');" >"$A_LOG" ) & c1=$!
( $PSQL -v ON_ERROR_STOP=1 -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT count(*) FROM claim_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$A'),'w2');" >"$SETTLE_LOG" ) & c2=$!
wait "$c1" "$c2"
[[ "$(( $(tail -1 "$A_LOG") + $(tail -1 "$SETTLE_LOG") ))" == 1 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*)||':'||(SELECT balance FROM credits WHERE user_id='$U') FROM credit_transactions WHERE transaction_type='DEDUCTION';")" == '1:0' ]]
# Terminal/unsafe states never revive; wrong owner and null role are denied.
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
UPDATE anchors SET status='PENDING' WHERE id='$A'; UPDATE anchor_instant_intents SET status='HELD' WHERE anchor_id='$A';
SET request.jwt.claim.role='service_role'; SELECT retry_anchor_instant_intent('$A','$U',NULL);
UPDATE anchor_instant_intents SET status='NEEDS_CREDIT',attempt=1,debit_reason='prior' WHERE anchor_id='$A';
SELECT retry_anchor_instant_intent('$A','$U',NULL);
SQL
[[ "$($PSQL -At -d "$DB" -c "SELECT status||':'||rearm_generation FROM anchor_instant_intents WHERE anchor_id='$A';")" == 'NEEDS_CREDIT:1' ]]
DENIED=$($PSQL -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT retry_anchor_instant_intent('$A','44444444-4444-4444-8444-444444444444',NULL)->>'error';")
[[ "${DENIED##*$'\n'}" == 'anchor_not_queued' ]]
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "RESET request.jwt.claim.role; SELECT retry_anchor_instant_intent('$A','$U',NULL);" >/dev/null 2>&1; then exit 1; fi
# Org recovery uses the exact canonical 0341 debit helper and touches only child.
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
SET request.jwt.claim.role='service_role';
SELECT enqueue_existing_anchor_instant_intent('$OA','$U','$C','{}','{}');
SELECT claim_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$OA'),'org-old');
SELECT grant_purchased_anchor_credits('evt-o','cs-o','$U',NULL,'$C',1,200,'usd');
SELECT retry_anchor_instant_intent('$OA','$U','$C');
SELECT claim_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$OA'),'org-new');
SQL
[[ "$($PSQL -At -d "$DB" -c "SELECT (SELECT balance FROM org_credits WHERE org_id='$P')||':'||(SELECT balance FROM org_credits WHERE org_id='$C')||':'||(SELECT count(*) FROM org_credit_deductions WHERE org_id='$C' AND reference_id='$OA' AND entry_type='DEBIT');")" == '5:0:1' ]]

# Independent negative matrix and deterministic retry-versus-claim lock overlap.
for terminal in HELD PROCESSING SUBMITTED FAILED; do
  $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE anchors SET status='PENDING' WHERE id='$A'; UPDATE anchor_instant_intents SET status='$terminal' WHERE anchor_id='$A'; SET request.jwt.claim.role='service_role'; SELECT retry_anchor_instant_intent('$A','$U',NULL);" >/dev/null
  [[ "$($PSQL -At -d "$DB" -c "SELECT status||':'||rearm_generation FROM anchor_instant_intents WHERE anchor_id='$A';")" == "$terminal:1" ]]
done
for scope in "NULL" "'$P'"; do
  denied=$($PSQL -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT retry_anchor_instant_intent('$OA','$U',$scope)->>'error';")
  [[ "${denied##*$'\n'}" == 'anchor_not_queued' ]]
done
R=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO anchors(id,fingerprint,public_id,status,user_id,filename,credential_type) VALUES('$R',repeat('c',64),'ARK-LOCK-RACE','PENDING','$U','r.pdf','OTHER');
SET request.jwt.claim.role='service_role';
SELECT enqueue_existing_anchor_instant_intent('$R','$U',NULL,'{}','{}');
SELECT claim_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$R'),'unfunded');
SELECT grant_purchased_anchor_credits('evt-r','cs-r','$U','$U',NULL,1,200,'usd');
SQL
( $PSQL -v ON_ERROR_STOP=1 -At -d "$DB" -c "BEGIN; SET request.jwt.claim.role='service_role'; SELECT retry_anchor_instant_intent('$R','$U',NULL); SELECT pg_sleep(1); COMMIT;" >"$A_LOG" ) & retry_pid=$!
sleep 0.1
( $PSQL -v ON_ERROR_STOP=1 -At -d "$DB" -c "SET statement_timeout='5s'; SET request.jwt.claim.role='service_role'; SELECT count(*) FROM claim_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$R'),'racing-claim');" >"$SETTLE_LOG" ) & claim_pid=$!
wait "$retry_pid" "$claim_pid"
[[ "$(tail -1 "$SETTLE_LOG")" == 1 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM credit_transactions WHERE reference_id='$R' AND transaction_type='DEDUCTION';")" == 1 ]]
echo 'Root additional native PASS terminal4 wrongorg2 retry_vs_claim_overlap one_debit'
echo 'SCRUM-5212 native PASS rearm_job=exactly_one personal_debit=exactly_one unsafe_terminal=blocked auth=blocked org_scope=parent5:child0:debit1 canonical0341=yes'
