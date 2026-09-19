#!/usr/bin/env bash
set -euo pipefail

PG_BIN="${UAT17_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PSQL="$PG_BIN/psql" CREATEDB="$PG_BIN/createdb" DROPDB="$PG_BIN/dropdb"
export PGHOST="${PGHOST:-127.0.0.1}"
case "$PGHOST" in 127.0.0.1|localhost|::1|/tmp|/var/run/postgresql) ;; *) exit 2 ;; esac
DB="arkova_uat17_${$}_${RANDOM}"
A_LOG="/tmp/uat17-a-${$}-${RANDOM}" B_LOG="/tmp/uat17-b-${$}-${RANDOM}" ROLE_CONFLICT_LOG="/tmp/uat17-role-conflict-${$}-${RANDOM}"
$CREATEDB "$DB"
trap '$DROPDB --if-exists "$DB" >/dev/null 2>&1 || true; rm -f "$A_LOG" "$B_LOG" "$ROLE_CONFLICT_LOG"' EXIT

$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<'SQL' >/dev/null
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth; CREATE SCHEMA private;
CREATE TYPE user_role AS ENUM ('INDIVIDUAL','ORG_MEMBER','ORG_ADMIN');
CREATE TYPE org_member_role AS ENUM ('owner','admin','member');
CREATE TYPE profile_status AS ENUM ('ACTIVE','PENDING_ACTIVATION','DEACTIVATED');
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb DEFAULT '{}');
CREATE TABLE organizations(id uuid PRIMARY KEY,display_name text,domain text,domain_verified boolean DEFAULT false,verification_status text,suspended boolean NOT NULL DEFAULT false,payment_state text);
CREATE TABLE profiles(id uuid PRIMARY KEY,email text NOT NULL,full_name text,org_id uuid,role user_role,role_set_at timestamptz,deleted_at timestamptz,is_platform_admin boolean DEFAULT false,status profile_status DEFAULT 'ACTIVE');
CREATE FUNCTION check_role_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role IS NOT NULL AND NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'User role cannot be changed once set' USING ERRCODE = '23514';
  END IF;
  IF OLD.role IS NULL AND NEW.role IS NOT NULL THEN NEW.role_set_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_role_immutability BEFORE UPDATE OF role ON profiles FOR EACH ROW EXECUTE FUNCTION check_role_immutability();
CREATE TABLE org_members(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,user_id uuid NOT NULL,org_id uuid NOT NULL,role org_member_role NOT NULL DEFAULT 'member',invited_by uuid,CONSTRAINT org_members_unique_membership UNIQUE(user_id,org_id));
CREATE TABLE audit_events(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,event_type text,event_category text,actor_id uuid,target_type text,target_id text,org_id uuid,details text);
CREATE FUNCTION public.get_caller_role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
CREATE FUNCTION private.requires_oauth_email_confirmation(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
SQL
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0470_uat17_verified_domain_and_atomic_member_add.sql >/dev/null

ACTOR=11111111-1111-4111-8111-111111111111
TARGET=22222222-2222-4222-8222-222222222222
ORG=33333333-3333-4333-8333-333333333333
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO auth.users VALUES ('$ACTOR','admin@example.invalid',now(),'{}'),('$TARGET','member@example.invalid',now(),'{}');
INSERT INTO organizations(id,display_name,domain,domain_verified,verification_status) VALUES ('$ORG','Verified','verified.invalid',true,'VERIFIED');
INSERT INTO profiles(id,email,org_id,role) VALUES ('$ACTOR','admin@example.invalid','$ORG','ORG_ADMIN'),('$TARGET','member@example.invalid',NULL,'INDIVIDUAL');
SQL

call_add() { $PSQL -At -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT idempotent FROM add_existing_org_member('$ACTOR','$ORG','member@example.invalid','INDIVIDUAL');"; }
(call_add >"$A_LOG") & a=$!; (call_add >"$B_LOG") & b=$!; wait "$a" "$b"
race_results="$(cat "$A_LOG"; cat "$B_LOG")"
[[ "$(grep -c '^f$' <<<"$race_results")" == 1 ]]
[[ "$(grep -c '^t$' <<<"$race_results")" == 1 ]]
member_count="$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_members WHERE user_id='$TARGET' AND org_id='$ORG';")"
audit_count="$($PSQL -At -d "$DB" -c "SELECT count(*) FROM audit_events WHERE event_type='MEMBER_ADDED';")"
[[ "$member_count" == 1 ]]
[[ "$audit_count" == 1 ]]

# Exact-role replay is idempotent; a different requested role is an explicit
# conflict and cannot mutate membership, profile backfill, or audit state.
[[ "$(call_add | tail -n1)" == t ]]
before_role_state="$($PSQL -At -d "$DB" -c "SELECT om.role||'|'||p.role||'|'||p.org_id||'|'||(SELECT count(*) FROM audit_events WHERE event_type='MEMBER_ADDED') FROM org_members om JOIN profiles p ON p.id=om.user_id WHERE om.user_id='$TARGET' AND om.org_id='$ORG';")"
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT * FROM add_existing_org_member('$ACTOR','$ORG','member@example.invalid','ORG_ADMIN');" >"$ROLE_CONFLICT_LOG" 2>&1; then exit 1; fi
grep -q 'membership_role_conflict' "$ROLE_CONFLICT_LOG"
after_role_state="$($PSQL -At -d "$DB" -c "SELECT om.role||'|'||p.role||'|'||p.org_id||'|'||(SELECT count(*) FROM audit_events WHERE event_type='MEMBER_ADDED') FROM org_members om JOIN profiles p ON p.id=om.user_id WHERE om.user_id='$TARGET' AND om.org_id='$ORG';")"
[[ "$after_role_state" == "$before_role_state" ]]

# Per-organization authority belongs to org_members. Adding an existing
# INDIVIDUAL as an admin must not rewrite the immutable legacy profile role.
ADMIN_TARGET=12121212-1212-4212-8212-121212121212
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "INSERT INTO auth.users VALUES ('$ADMIN_TARGET','org-admin@example.invalid',now(),'{}'); INSERT INTO profiles(id,email,role) VALUES ('$ADMIN_TARGET','org-admin@example.invalid','INDIVIDUAL');" >/dev/null
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT * FROM add_existing_org_member('$ACTOR','$ORG','org-admin@example.invalid','ORG_ADMIN');" >/dev/null
[[ "$($PSQL -At -d "$DB" -c "SELECT om.role||'|'||p.role||'|'||p.org_id FROM org_members om JOIN profiles p ON p.id=om.user_id WHERE om.user_id='$ADMIN_TARGET' AND om.org_id='$ORG';")" == "admin|INDIVIDUAL|$ORG" ]]

# Missing caller authority (including NULL claims) fails before target lookup.
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "RESET request.jwt.claim.role; SELECT * FROM add_existing_org_member('$ACTOR','$ORG','missing@example.invalid','INDIVIDUAL');" >/dev/null 2>&1; then exit 1; fi
OUTSIDER=88888888-8888-4888-8888-888888888888
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "INSERT INTO auth.users VALUES ('$OUTSIDER','outsider@example.invalid',now(),'{}'); INSERT INTO profiles(id,email) VALUES ('$OUTSIDER','outsider@example.invalid');" >/dev/null
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT * FROM add_existing_org_member('$OUTSIDER','$ORG','missing@example.invalid','INDIVIDUAL');" >/dev/null 2>&1; then exit 1; fi

# Unverified and ambiguous verified domains never acquire membership.
U1=44444444-4444-4444-8444-444444444444
U2=55555555-5555-4555-8555-555555555555
O2=66666666-6666-4666-8666-666666666666
O3=77777777-7777-4777-8777-777777777777
U3=99999999-9999-4999-8999-999999999999
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO auth.users VALUES ('$U1','one@unverified.invalid',now(),'{}'),('$U2','two@duplicate.invalid',now(),'{}'),('$U3','three@verified.invalid',NULL,'{}');
INSERT INTO profiles(id,email) VALUES ('$U1','one@unverified.invalid'),('$U2','two@duplicate.invalid'),('$U3','three@verified.invalid');
INSERT INTO organizations(id,display_name,domain,domain_verified,verification_status) VALUES
('$O2','Unverified','unverified.invalid',false,'PENDING'),
('$O3','Duplicate A','duplicate.invalid',true,'VERIFIED'),
(gen_random_uuid(),'Duplicate B','duplicate.invalid',true,'VERIFIED'),
(gen_random_uuid(),'Confirmed target','verified.invalid',true,'VERIFIED');
SELECT auto_associate_profile_to_org_by_email_domain('$U1','one@unverified.invalid');
SELECT auto_associate_profile_to_org_by_email_domain('$U2','two@duplicate.invalid');
SELECT auto_associate_profile_to_org_by_email_domain('$U3','three@verified.invalid');
SQL
domain_member_count="$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_members WHERE user_id IN ('$U1','$U2');")"
[[ "$domain_member_count" == 0 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_members WHERE user_id='$U3';")" == 0 ]]
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE auth.users SET email_confirmed_at=now() WHERE id='$U3'; SELECT auto_associate_profile_to_org_by_email_domain('$U3','three@verified.invalid');" >/dev/null
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_members WHERE user_id='$U3';")" == 1 ]]

# Normalized duplicate profile email is an explicit conflict with no write.
DUP=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "INSERT INTO auth.users VALUES ('$DUP','MEMBER@example.invalid',now(),'{}'); INSERT INTO profiles(id,email) VALUES ('$DUP','MEMBER@example.invalid');" >/dev/null
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT * FROM add_existing_org_member('$ACTOR','$ORG','member@example.invalid','INDIVIDUAL');" >/dev/null 2>&1; then exit 1; fi

# Any audit failure rolls back the membership and profile backfill atomically.
ROLLBACK_USER=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "INSERT INTO auth.users VALUES ('$ROLLBACK_USER','rollback@example.invalid',now(),'{}'); INSERT INTO profiles(id,email,role) VALUES ('$ROLLBACK_USER','rollback@example.invalid','INDIVIDUAL'); ALTER TABLE audit_events ADD CONSTRAINT reject_member_added CHECK(event_type <> 'MEMBER_ADDED') NOT VALID;" >/dev/null
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT * FROM add_existing_org_member('$ACTOR','$ORG','rollback@example.invalid','INDIVIDUAL');" >/dev/null 2>&1; then exit 1; fi
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM org_members WHERE user_id='$ROLLBACK_USER';")" == 0 ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM profiles WHERE id='$ROLLBACK_USER' AND org_id IS NOT NULL;")" == 0 ]]

# Catalog signature must expose the same additive RPC shape checked into both
# generated client type surfaces.
catalog="$($PSQL -At -d "$DB" -c "SELECT pg_get_function_identity_arguments(oid)||' -> '||pg_get_function_result(oid) FROM pg_proc WHERE oid='public.add_existing_org_member(uuid,uuid,text,text)'::regprocedure;")"
[[ "$catalog" == 'p_actor_id uuid, p_org_id uuid, p_email text, p_role text -> TABLE(user_id uuid, email text, full_name text, idempotent boolean)' ]]
root_type_block="$(sed -n '/add_existing_org_member:/,+9p' src/types/database.types.ts)"
worker_type_block="$(sed -n '/add_existing_org_member:/,+9p' services/worker/src/types/database.types.ts)"
[[ "$root_type_block" == "$worker_type_block" ]]
[[ "$root_type_block" == *'Args: { p_actor_id: string; p_email: string; p_org_id: string; p_role: string }'* ]]
[[ "$root_type_block" == *'email: string'* && "$root_type_block" == *'full_name: string | null'* && "$root_type_block" == *'idempotent: boolean'* && "$root_type_block" == *'user_id: string'* ]]

echo 'UAT-17 native PostgreSQL PASS verified-only=failclosed concurrent-add=one-audit replay=idempotent role-conflict=no-mutation null-role=denied'
