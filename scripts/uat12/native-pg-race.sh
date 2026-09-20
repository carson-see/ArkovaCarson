#!/usr/bin/env bash
set -euo pipefail
PSQL=/opt/homebrew/opt/postgresql@17/bin/psql
CREATEDB=/opt/homebrew/opt/postgresql@17/bin/createdb
DROPDB=/opt/homebrew/opt/postgresql@17/bin/dropdb
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
USER_ID=11111111-1111-4111-8111-111111111111
A1=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1
A2=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2
A3=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3
ORG_PARENT=22222222-2222-4222-8222-222222222222
ORG_CHILD=33333333-3333-4333-8333-333333333333
ORG_ANCHOR=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO auth.users VALUES('$USER_ID');
INSERT INTO credits(user_id,balance) VALUES('$USER_ID',2);
INSERT INTO anchors(id,fingerprint,public_id,status,user_id,filename,credential_type,created_at) VALUES
('$A1',repeat('a',64),'ARK-INSTANT','PENDING','$USER_ID','instant.pdf','OTHER',now()-interval '1 hour'),
('$A2',repeat('b',64),'ARK-QUEUE','PENDING','$USER_ID','queue.pdf','OTHER',now()),
('$A3',repeat('c',64),'ARK-REFUND','PENDING','$USER_ID','refund.pdf','OTHER',now()+interval '1 hour');
INSERT INTO organizations VALUES('$ORG_PARENT'),('$ORG_CHILD');
INSERT INTO org_credits(org_id,balance) VALUES('$ORG_PARENT',5),('$ORG_CHILD',2);
INSERT INTO anchors(id,fingerprint,public_id,status,user_id,org_id,filename,credential_type,created_at)
VALUES('$ORG_ANCHOR',repeat('d',64),'ARK-CHILD','PENDING','$USER_ID','$ORG_CHILD','child.pdf','OTHER',now()+interval '2 hour');
SQL
# Hold the existing-anchor upgrade open. The ordinary scanner must skip its row
# lock, claim the unrelated row, then continue excluding the committed intent.
( $PSQL -v ON_ERROR_STOP=1 -At -d "$DB" <<SQL >/dev/null
BEGIN; SET LOCAL request.jwt.claim.role='service_role';
SELECT public.enqueue_existing_anchor_instant_intent('$A1','$USER_ID',NULL,'{}','{}');
SELECT pg_sleep(2); COMMIT;
SQL
) & p1=$!
sleep 0.4
CLAIMED=$($PSQL -v ON_ERROR_STOP=1 -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT public_id FROM public.claim_pending_anchors('ordinary',10,true,NULL);")
[[ "$CLAIMED" == *"ARK-QUEUE"* && "$CLAIMED" != *"ARK-INSTANT"* ]]
wait "$p1"
POST=$($PSQL -v ON_ERROR_STOP=1 -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT count(*) FROM public.claim_pending_anchors('ordinary2',10,true,NULL);")
[[ "${POST##*$'\n'}" == "0" ]]
INTENT=$($PSQL -At -d "$DB" -c "SELECT id FROM anchor_instant_intents WHERE anchor_id='$A1'")
# Two exact workers race. Exactly one acquires and debits; the other observes
# PROCESSING after the row lock releases and returns no anchor.
( $PSQL -v ON_ERROR_STOP=1 -At -d "$DB" <<SQL >"$A_LOG"
BEGIN; SET LOCAL request.jwt.claim.role='service_role';
SELECT public_id FROM public.claim_anchor_instant_intent('$INTENT','worker-a');
SELECT pg_sleep(2); COMMIT;
SQL
) & p2=$!
sleep 0.4
SECOND=$($PSQL -v ON_ERROR_STOP=1 -At -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT count(*) FROM public.claim_anchor_instant_intent('$INTENT','worker-b');")
wait "$p2"
FIRST=$(cat "$A_LOG"); rm -f "$A_LOG"
[[ "$FIRST" == *"ARK-INSTANT"* && "${SECOND##*$'\n'}" == "0" ]]
DEBITS=$($PSQL -At -d "$DB" -c "SELECT count(*)||':'||(SELECT balance FROM credits WHERE user_id='$USER_ID') FROM credit_transactions WHERE transaction_type='DEDUCTION';")
[[ "$DEBITS" == "1:1" ]]
# Ambiguous evidence holds without refund; recovery adoption settles, and an
# ack-loss replay is idempotent for the same attempt.
$PSQL -v ON_ERROR_STOP=1 -At -d "$DB" <<SQL >"$SETTLE_LOG"
SET request.jwt.claim.role='service_role';
SELECT public.settle_anchor_instant_intent('$INTENT','HELD',1,'ambiguous');
UPDATE anchors SET status='SUBMITTED',chain_tx_id='tx-adopted' WHERE id='$A1';
SELECT public.settle_anchor_instant_intent('$INTENT','SUBMITTED',1,NULL);
SELECT public.settle_anchor_instant_intent('$INTENT','SUBMITTED',1,NULL);
SQL
grep -q '"idempotent" : true' "$SETTLE_LOG" || grep -q '"idempotent": true' "$SETTLE_LOG"
rm -f "$SETTLE_LOG"
REFUNDS=$($PSQL -At -d "$DB" -c "SELECT count(*) FROM credit_transactions WHERE transaction_type='REFUND';")
[[ "$REFUNDS" == "0" ]]

# Safe pre-broadcast refund: stale worker rejected, matching debit required,
# same-attempt replay returns idempotent success without minting a second unit.
$PSQL -v ON_ERROR_STOP=1 -At -d "$DB" <<SQL >"$SETTLE_LOG"
SET request.jwt.claim.role='service_role';
UPDATE anchors SET status='PENDING' WHERE id='$A3';
SELECT public.enqueue_existing_anchor_instant_intent('$A3','$USER_ID',NULL,'{}','{}');
SELECT public.claim_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$A3'),'refund-worker');
UPDATE anchors SET status='PENDING' WHERE id='$A3';
SELECT public.settle_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$A3'),'FAILED_SAFE',0,'stale');
SELECT public.settle_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$A3'),'FAILED_SAFE',1,'safe');
SELECT public.settle_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$A3'),'FAILED_SAFE',1,'safe-replay');
SQL
grep -q 'stale_attempt' "$SETTLE_LOG"
grep -q '"idempotent" : true' "$SETTLE_LOG" || grep -q '"idempotent": true' "$SETTLE_LOG"
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*)||':'||(SELECT balance FROM credits WHERE user_id='$USER_ID') FROM credit_transactions WHERE transaction_type='REFUND';")" == "1:1" ]]

# A forged PROCESSING row without its debit cannot mint a refund.
$PSQL -v ON_ERROR_STOP=1 -At -d "$DB" <<SQL >"$SETTLE_LOG"
SET request.jwt.claim.role='service_role';
INSERT INTO anchors(id,fingerprint,public_id,status,user_id,filename,credential_type) VALUES(gen_random_uuid(),repeat('e',64),'ARK-NODEBIT','PENDING','$USER_ID','nodebit.pdf','OTHER');
INSERT INTO anchor_instant_intents(anchor_id,user_id,status,attempt,debit_reason)
SELECT id,'$USER_ID','PROCESSING',1,'missing.debit' FROM anchors WHERE public_id='ARK-NODEBIT';
SELECT public.settle_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE debit_reason='missing.debit'),'FAILED_SAFE',1,'forged');
SQL
grep -q 'matching_debit_not_found' "$SETTLE_LOG"

# Child-org purchase/claim touches only the child pool and its exact ledger.
$PSQL -v ON_ERROR_STOP=1 -At -d "$DB" <<SQL >/dev/null
SET request.jwt.claim.role='service_role';
UPDATE anchors SET status='PENDING' WHERE id='$ORG_ANCHOR';
SELECT public.enqueue_existing_anchor_instant_intent('$ORG_ANCHOR','$USER_ID','$ORG_CHILD','{}','{}');
SELECT public.claim_anchor_instant_intent((SELECT id FROM anchor_instant_intents WHERE anchor_id='$ORG_ANCHOR'),'org-worker');
SQL
ORG_SCOPE=$($PSQL -At -d "$DB" -c "SELECT (SELECT balance FROM org_credits WHERE org_id='$ORG_PARENT')||':'||(SELECT balance FROM org_credits WHERE org_id='$ORG_CHILD')||':'||(SELECT count(*) FROM org_credit_deductions WHERE org_id='$ORG_CHILD' AND reference_id='$ORG_ANCHOR' AND entry_type='DEBIT');")
[[ "$ORG_SCOPE" == "5:1:1" ]]

# Paid fulfillment is session+event idempotent and grants the exact child pool.
$PSQL -v ON_ERROR_STOP=1 -At -d "$DB" <<SQL >/dev/null
SET request.jwt.claim.role='service_role';
SELECT public.grant_purchased_anchor_credits('evt-child','cs-child','$USER_ID',NULL,'$ORG_CHILD',3,600,'usd');
SELECT public.grant_purchased_anchor_credits('evt-child','cs-child','$USER_ID',NULL,'$ORG_CHILD',3,600,'usd');
SQL
PURCHASE_SCOPE=$($PSQL -At -d "$DB" -c "SELECT (SELECT balance FROM org_credits WHERE org_id='$ORG_PARENT')||':'||(SELECT balance FROM org_credits WHERE org_id='$ORG_CHILD')||':'||(SELECT count(*) FROM anchor_credit_purchases WHERE stripe_session_id='cs-child')||':'||(SELECT count(*) FROM org_credit_deductions WHERE entry_type='GRANT' AND reason='anchor.credit_purchase');")
[[ "$PURCHASE_SCOPE" == "5:4:1:1" ]]
echo "UAT12 native PG PASS database=$DB ordinary_race=isolated exact_claim=1 safe_refund=idempotent missing_debit=rejected org_scope=parent5:child1 paid_child=parent5:child4:one_grant held_adopt=idempotent"
