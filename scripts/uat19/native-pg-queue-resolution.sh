#!/usr/bin/env bash
set -euo pipefail

PG_BIN="${UAT19_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PSQL="$PG_BIN/psql"
CREATEDB="$PG_BIN/createdb"
DROPDB="$PG_BIN/dropdb"
export PGHOST="${PGHOST:-127.0.0.1}"
case "$PGHOST" in 127.0.0.1|localhost|::1|/tmp|/var/run/postgresql) ;; *) echo 'Native test requires local PostgreSQL' >&2; exit 2 ;; esac

DB="arkova_uat19_queue_${$}_${RANDOM}"
A_LOG="/tmp/uat19-queue-a-${$}-${RANDOM}"
B_LOG="/tmp/uat19-queue-b-${$}-${RANDOM}"
$CREATEDB "$DB"
trap '$DROPDB --if-exists "$DB" >/dev/null 2>&1 || true; rm -f "$A_LOG" "$B_LOG"' EXIT

$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<'SQL' >/dev/null
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth;
CREATE TYPE anchor_status AS ENUM ('PENDING','BROADCASTING','SUBMITTED','SECURED','REVOKED','SUPERSEDED','FAILED','PENDING_RESOLUTION');
CREATE TYPE org_member_role AS ENUM ('owner','admin','member');
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE organizations(id uuid PRIMARY KEY, parent_org_id uuid REFERENCES organizations, parent_approval_status text);
CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users, org_id uuid REFERENCES organizations, role text, is_platform_admin boolean, email text);
CREATE TABLE org_members(user_id uuid REFERENCES auth.users, org_id uuid REFERENCES organizations, role org_member_role NOT NULL, PRIMARY KEY(user_id,org_id));
CREATE TABLE anchors(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), public_id text UNIQUE, org_id uuid REFERENCES organizations, status anchor_status NOT NULL, metadata jsonb, deleted_at timestamptz, updated_at timestamptz DEFAULT now(), revoked_at timestamptz, revocation_reason text);
CREATE TABLE anchor_queue_resolutions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations, external_file_id text, selected_anchor_id uuid REFERENCES anchors, rejected_anchor_ids uuid[], reason text, resolved_by_user_id uuid REFERENCES auth.users, UNIQUE(org_id,external_file_id,selected_anchor_id));
CREATE TABLE audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text, event_category text, actor_id uuid, org_id uuid, target_type text, target_id text, details text);
SQL

$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0477_uat19_queue_resolve_authorization.sql >/dev/null

U1=11111111-1111-4111-8111-111111111111
U2=22222222-2222-4222-8222-222222222222
U3=33333333-3333-4333-8333-333333333333
U4=44444444-4444-4444-8444-444444444444
PRIMARY=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
SECONDARY=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
CHILD=cccccccc-cccc-4ccc-8ccc-cccccccccccc
OTHER=dddddddd-dddd-4ddd-8ddd-dddddddddddd

$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO auth.users VALUES ('$U1'),('$U2'),('$U3'),('$U4');
INSERT INTO organizations(id) VALUES ('$PRIMARY'),('$SECONDARY'),('$OTHER');
INSERT INTO organizations(id,parent_org_id,parent_approval_status) VALUES ('$CHILD','$PRIMARY','APPROVED');
INSERT INTO profiles(id,org_id,role,is_platform_admin) VALUES ('$U1','$PRIMARY','ORG_ADMIN',false),('$U2',NULL,'ORG_MEMBER',false),('$U3','$PRIMARY','ORG_ADMIN',false),('$U4',NULL,NULL,NULL);
INSERT INTO org_members VALUES ('$U1','$SECONDARY','owner'),('$U2','$SECONDARY','admin'),('$U3','$SECONDARY','member'),('$U1','$PRIMARY','admin');
INSERT INTO anchors(public_id,org_id,status,metadata) VALUES
 ('SEC-A','$SECONDARY','PENDING_RESOLUTION','{"external_file_id":"sec-file"}'),
 ('SEC-B','$SECONDARY','PENDING_RESOLUTION','{"external_file_id":"sec-file"}'),
 ('REPLAY-A','$SECONDARY','PENDING_RESOLUTION','{"external_file_id":"replay-file"}'),
 ('REPLAY-B','$SECONDARY','PENDING_RESOLUTION','{"external_file_id":"replay-file"}'),
 ('RACE-A','$SECONDARY','PENDING_RESOLUTION','{"external_file_id":"revocation-race"}'),
 ('RACE-B','$SECONDARY','PENDING_RESOLUTION','{"external_file_id":"revocation-race"}'),
 ('INDEP-A','$SECONDARY','PENDING_RESOLUTION','{"external_file_id":"independent-file"}'),
 ('INDEP-B','$SECONDARY','PENDING_RESOLUTION','{"external_file_id":"independent-file"}'),
 ('CHILD-A','$CHILD','PENDING_RESOLUTION','{"external_file_id":"child-file"}'),
 ('CHILD-B','$CHILD','PENDING_RESOLUTION','{"external_file_id":"child-file"}'),
 ('OTHER-A','$OTHER','PENDING_RESOLUTION','{"external_file_id":"other-file"}');
SQL

call_resolve() {
  local file_id="$1" public_id="$2" user_id="$3"
  $PSQL -At -v ON_ERROR_STOP=1 -d "$DB" -c "SET statement_timeout='5s'; SET ROLE service_role; SELECT resolve_anchor_queue_by_public_id('$file_id','$public_id',NULL,'$user_id');"
}

# Exact secondary owner and an admin whose profile has no primary org are both
# authorized by org_members. The second call is an idempotent replay.
first="$(call_resolve sec-file SEC-A "$U1" | tail -1)"
replay="$(call_resolve sec-file SEC-A "$U2" | tail -1)"
[[ "$first" == "$replay" ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchor_queue_resolutions WHERE org_id='$SECONDARY';")" == 1 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT string_agg(public_id||':'||status,',' ORDER BY public_id) FROM anchors WHERE org_id='$SECONDARY' AND metadata->>'external_file_id'='sec-file';")" == 'SEC-A:PENDING,SEC-B:REVOKED' ]]

# Concurrent same-selection replay returns the same durable receipt twice and
# emits one audit row.
( call_resolve replay-file REPLAY-A "$U1" >"$A_LOG" ) & a_pid=$!
( call_resolve replay-file REPLAY-A "$U2" >"$B_LOG" ) & b_pid=$!
wait "$a_pid" "$b_pid"
a_id="$(tail -1 "$A_LOG")"; b_id="$(tail -1 "$B_LOG")"
[[ -n "$a_id" && "$a_id" == "$b_id" ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchor_queue_resolutions WHERE org_id='$SECONDARY' AND external_file_id='replay-file';")" == 1 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM audit_events WHERE org_id='$SECONDARY' AND details::jsonb->>'external_file_id'='replay-file';")" == 1 ]]

# A held collision-set lock must not serialize an unrelated set in the same org.
(
  PGAPPNAME=uat19_unrelated_lock $PSQL -At -v ON_ERROR_STOP=1 -d "$DB" -c "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('$SECONDARY:blocked-file',0)); SELECT pg_sleep(2); COMMIT;" >/dev/null
) & independent_lock_pid=$!
for _ in {1..40}; do
  [[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='uat19_unrelated_lock' AND wait_event='PgSleep';")" == 1 ]] && break
  sleep 0.05
done
independent_id="$(call_resolve independent-file INDEP-A "$U1" | tail -1)"
[[ -n "$independent_id" ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='uat19_unrelated_lock' AND state='active';")" == 1 ]]
wait "$independent_lock_pid"

# Authorization is rechecked after waiting for the collision lock. The waiter
# is proven blocked in pg_stat_activity before its exact membership is demoted.
(
  $PSQL -At -v ON_ERROR_STOP=1 -d "$DB" -c "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('$SECONDARY:revocation-race',0)); SELECT pg_sleep(2); COMMIT;" >/dev/null
) & lock_pid=$!
( PGAPPNAME=uat19_revoked_waiter call_resolve revocation-race RACE-A "$U2" >"$A_LOG" 2>&1 ) & waiter_pid=$!
waiting=''
for _ in {1..40}; do
  waiting="$($PSQL -At -d "$DB" -c "SELECT wait_event FROM pg_stat_activity WHERE application_name='uat19_revoked_waiter';")"
  [[ "$waiting" == 'advisory' || "$waiting" == 'AdvisoryLock' ]] && break
  sleep 0.05
done
[[ "$waiting" == 'advisory' || "$waiting" == 'AdvisoryLock' ]]
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE org_members SET role='member' WHERE user_id='$U2' AND org_id='$SECONDARY';" >/dev/null
wait "$lock_pid"
if wait "$waiter_pid"; then echo 'revoked lock waiter unexpectedly resolved' >&2; exit 1; fi
rg -q 'Only organization administrators' "$A_LOG"
[[ "$($PSQL -At -d "$DB" -c "SELECT string_agg(public_id||':'||status,',' ORDER BY public_id) FROM anchors WHERE metadata->>'external_file_id'='revocation-race';")" == 'RACE-A:PENDING_RESOLUTION,RACE-B:PENDING_RESOLUTION' ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchor_queue_resolutions WHERE external_file_id='revocation-race';")" == 0 ]]

# An ORG_ADMIN of their primary org who is only a member of the selected org is
# denied before any anchor, receipt, or audit mutation.
before="$($PSQL -At -d "$DB" -c "SELECT string_agg(public_id||':'||status,',' ORDER BY public_id)||':'||(SELECT count(*) FROM anchor_queue_resolutions)||':'||(SELECT count(*) FROM audit_events) FROM anchors;")"
if call_resolve other-file OTHER-A "$U3" >"$A_LOG" 2>&1; then echo 'cross-org profile role unexpectedly authorized' >&2; exit 1; fi
rg -q 'Only organization administrators' "$A_LOG"
after="$($PSQL -At -d "$DB" -c "SELECT string_agg(public_id||':'||status,',' ORDER BY public_id)||':'||(SELECT count(*) FROM anchor_queue_resolutions)||':'||(SELECT count(*) FROM audit_events) FROM anchors;")"
[[ "$before" == "$after" ]]
if call_resolve other-file OTHER-A "$U4" >"$A_LOG" 2>&1; then echo 'NULL authorization fields unexpectedly authorized' >&2; exit 1; fi
rg -q 'Only organization administrators' "$A_LOG"
if $PSQL -At -v ON_ERROR_STOP=1 -d "$DB" -c "SET ROLE service_role; SELECT resolve_anchor_queue_by_public_id(NULL,'OTHER-A',NULL,'$U1');" >"$A_LOG" 2>&1; then echo 'NULL collision key unexpectedly accepted' >&2; exit 1; fi
rg -q 'external_file_id must be 1-255 characters' "$A_LOG"
long_file_id="$(printf 'x%.0s' {1..256})"
if call_resolve "$long_file_id" OTHER-A "$U1" >"$A_LOG" 2>&1; then echo 'oversized collision key unexpectedly accepted' >&2; exit 1; fi
rg -q 'external_file_id must be 1-255 characters' "$A_LOG"

# Approved direct-parent administration is supported; two concurrent identical
# calls serialize and return one durable receipt ID rather than double-writing.
( if call_resolve child-file CHILD-A "$U1" >"$A_LOG" 2>&1; then echo success >>"$A_LOG"; else echo failure >>"$A_LOG"; fi ) & a_pid=$!
( if call_resolve child-file CHILD-B "$U1" >"$B_LOG" 2>&1; then echo success >>"$B_LOG"; else echo failure >>"$B_LOG"; fi ) & b_pid=$!
wait "$a_pid" "$b_pid"
[[ "$(rg -c '^success$' "$A_LOG" "$B_LOG" | awk -F: '{n+=$2} END{print n+0}')" == 1 ]]
[[ "$(rg -c '^failure$' "$A_LOG" "$B_LOG" | awk -F: '{n+=$2} END{print n+0}')" == 1 ]]
rg -q 'Anchor is not awaiting resolution' "$A_LOG" "$B_LOG"
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM anchor_queue_resolutions WHERE org_id='$CHILD';")" == 1 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM audit_events WHERE org_id='$CHILD';")" == 1 ]]

# Caller-declared collision keys never retarget the selected anchor.
if call_resolve forged-file OTHER-A "$U1" >"$A_LOG" 2>&1; then echo 'mismatched collision key unexpectedly resolved' >&2; exit 1; fi
rg -q 'external_file_id does not match' "$A_LOG"
[[ "$($PSQL -At -d "$DB" -c "SELECT status FROM anchors WHERE public_id='OTHER-A';")" == 'PENDING_RESOLUTION' ]]

echo 'UAT-19 native queue resolution PASS exact-secondary=no-primary parent=approved replay=one-receipt-one-audit contenders=one-winner-no-deadlock revoked-waiter=denied-zero-mutation collision-key=server-bound'
