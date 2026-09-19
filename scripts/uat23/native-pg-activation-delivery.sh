#!/usr/bin/env bash
set -euo pipefail

PG_BIN="${UAT23_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PSQL="$PG_BIN/psql"
CREATEDB="$PG_BIN/createdb"
DROPDB="$PG_BIN/dropdb"
export PGHOST="${PGHOST:-127.0.0.1}"
case "$PGHOST" in 127.0.0.1|localhost|::1|/tmp|/var/run/postgresql) ;; *) echo 'Native test requires a local PostgreSQL host' >&2; exit 2 ;; esac

DB="arkova_uat23_activation_${$}_${RANDOM}"
A_LOG="/tmp/uat23-activation-a-${$}-${RANDOM}"
B_LOG="/tmp/uat23-activation-b-${$}-${RANDOM}"
"$CREATEDB" "$DB"
trap '"$DROPDB" --if-exists "$DB" >/dev/null 2>&1 || true; rm -f "$A_LOG" "$B_LOG"' EXIT

"$PSQL" -v ON_ERROR_STOP=1 -d "$DB" <<'SQL' >/dev/null
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE TYPE user_role AS ENUM ('INDIVIDUAL','ORG_MEMBER','ORG_ADMIN');
CREATE TYPE org_member_role AS ENUM ('owner','admin','member');
CREATE TABLE auth.users(
  id uuid PRIMARY KEY,
  email text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE public.organizations(id uuid PRIMARY KEY,display_name text,domain text,domain_verified boolean,verification_status text,created_at timestamptz DEFAULT now());
CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),email text NOT NULL,full_name text,org_id uuid,role user_role,role_set_at timestamptz,status text DEFAULT 'ACTIVE',activation_token text,activation_token_expires_at timestamptz,deleted_at timestamptz);
CREATE TABLE public.org_members(user_id uuid REFERENCES auth.users(id),org_id uuid,role org_member_role DEFAULT 'member',UNIQUE(user_id,org_id));
CREATE TABLE public.audit_events(event_type text,event_category text,actor_id uuid,target_type text,target_id text,org_id uuid,details text);
CREATE FUNCTION private.requires_oauth_email_confirmation(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.get_caller_role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
SQL

# Execute the actual pre-UAT17 function and actual Auth confirmation trigger.
"$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -f <(sed -n \
  '/CREATE OR REPLACE FUNCTION "public"\."auto_associate_profile_to_org_by_email_domain"/,/GRANT EXECUTE ON FUNCTION public\.auto_associate_profile_to_org_by_email_domain(uuid,text) TO service_role;/p' \
  supabase/migrations/0439_scrum3873_atomic_org_provisioning.sql) >/dev/null
"$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -f <(sed -n \
  '/CREATE OR REPLACE FUNCTION "public"\."handle_auth_user_email_verified_org_join"/,/ALTER FUNCTION "public"\."handle_auth_user_email_verified_org_join"() OWNER TO "postgres";/p' \
  supabase/migrations/00000000000000_baseline_at_main_HEAD.sql) >/dev/null
"$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -c 'CREATE TRIGGER zz_auth_user_auto_associate_org AFTER INSERT OR UPDATE OF email,email_confirmed_at ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_email_verified_org_join();' >/dev/null
"$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0471_uat23_activation_delivery_claim.sql >/dev/null

PROFILE=11111111-1111-4111-8111-111111111111
TOKEN_HASH=$(printf 'a%.0s' {1..64})
"$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -c "INSERT INTO auth.users(id,email) VALUES ('$PROFILE','claim@invalid.test'); INSERT INTO profiles(id,email) VALUES ('$PROFILE','claim@invalid.test');" >/dev/null

( "$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -c "INSERT INTO recipient_activation_deliveries(profile_id,token_hash) VALUES ('$PROFILE','$TOKEN_HASH');" >"$A_LOG" 2>&1 ) & a_pid=$!
( "$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -c "INSERT INTO recipient_activation_deliveries(profile_id,token_hash) VALUES ('$PROFILE','$TOKEN_HASH');" >"$B_LOG" 2>&1 ) & b_pid=$!
set +e
wait "$a_pid"; a_status=$?
wait "$b_pid"; b_status=$?
set -e
if [[ "$a_status" -ne 0 && "$b_status" -ne 0 ]]; then cat "$A_LOG" "$B_LOG" >&2; exit 1; fi
[[ "$a_status" -eq 0 && "$b_status" -ne 0 || "$a_status" -ne 0 && "$b_status" -eq 0 ]]
if [[ "$a_status" -ne 0 ]]; then grep -q 'duplicate key value violates unique constraint' "$A_LOG"; fi
if [[ "$b_status" -ne 0 ]]; then grep -q 'duplicate key value violates unique constraint' "$B_LOG"; fi
[[ "$("$PSQL" -At -d "$DB" -c "SELECT count(*) FROM recipient_activation_deliveries;")" == 1 ]]
[[ "$("$PSQL" -At -d "$DB" -c "SELECT status FROM recipient_activation_deliveries;")" == sending ]]
[[ "$("$PSQL" -At -d "$DB" -c "SELECT has_table_privilege('anon','recipient_activation_deliveries','SELECT') OR has_table_privilege('authenticated','recipient_activation_deliveries','SELECT');")" == f ]]
[[ "$("$PSQL" -At -d "$DB" -c "SELECT has_table_privilege('service_role','recipient_activation_deliveries','INSERT');")" == t ]]
if "$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -c "SET ROLE authenticated; SELECT * FROM recipient_activation_deliveries;" >/dev/null 2>&1; then exit 1; fi

BULK_PROFILE=22222222-2222-4222-8222-222222222222
ORDINARY_PROFILE=33333333-3333-4333-8333-333333333333
ORG=44444444-4444-4444-8444-444444444444
"$PSQL" -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO organizations(id,display_name,domain,domain_verified,verification_status) VALUES ('$ORG','Example','example.test',true,'VERIFIED');
INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES
  ('$BULK_PROFILE','bulk@example.test','{"arkova_bulk_recipient":true,"admin_provisioned":true}'),
  ('$ORDINARY_PROFILE','ordinary@example.test','{}');
INSERT INTO profiles(id,email) VALUES ('$BULK_PROFILE','bulk@example.test'), ('$ORDINARY_PROFILE','ordinary@example.test');
UPDATE auth.users SET email_confirmed_at=now() WHERE id IN ('$BULK_PROFILE','$ORDINARY_PROFILE');
SQL
[[ "$("$PSQL" -At -d "$DB" -c "SELECT count(*) FROM org_members WHERE user_id='$BULK_PROFILE';")" == 0 ]]
[[ "$("$PSQL" -At -d "$DB" -c "SELECT count(*) FROM org_members WHERE user_id='$ORDINARY_PROFILE' AND org_id='$ORG';")" == 1 ]]

RECOVERED=55555555-5555-4555-8555-555555555555
UNMARKED=66666666-6666-4666-8666-666666666666
CONFIRMED=77777777-7777-4777-8777-777777777777
MEMBER=88888888-8888-4888-8888-888888888888
ORPHAN_MEMBER=99999999-9999-4999-8999-999999999999
RACE_MEMBER=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
RECOVERY_TOKEN=$(printf 'b%.0s' {1..64})
REPLAY_TOKEN=$(printf 'c%.0s' {1..64})
"$PSQL" -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES
 ('$RECOVERED','recover@example.invalid','{"arkova_bulk_recipient":true,"admin_provisioned":true}'),
 ('$UNMARKED','unmarked@example.invalid','{}'),
 ('$CONFIRMED','confirmed@example.invalid','{"arkova_bulk_recipient":true,"admin_provisioned":true}'),
 ('$MEMBER','member@example.invalid','{"arkova_bulk_recipient":true,"admin_provisioned":true}'),
 ('$ORPHAN_MEMBER','orphan-member@example.invalid','{"arkova_bulk_recipient":true,"admin_provisioned":true}'),
 ('$RACE_MEMBER','race-member@example.invalid','{"arkova_bulk_recipient":true,"admin_provisioned":true}');
UPDATE auth.users SET email_confirmed_at=now() WHERE id='$CONFIRMED';
INSERT INTO profiles(id,email) VALUES ('$MEMBER','member@example.invalid');
INSERT INTO profiles(id,email) VALUES ('$RACE_MEMBER','race-member@example.invalid');
INSERT INTO org_members(user_id,org_id) VALUES ('$MEMBER','$ORG');
INSERT INTO org_members(user_id,org_id) VALUES ('$ORPHAN_MEMBER','$ORG');
SET request.jwt.claim.role='service_role';
SELECT * FROM recover_bulk_recipient_profile('recover@example.invalid','Recovered','$RECOVERY_TOKEN',now()+interval '7 days',NULL);
SELECT * FROM recover_bulk_recipient_profile('recover@example.invalid','Changed','$REPLAY_TOKEN',now()+interval '7 days',NULL);
SQL
[[ "$("$PSQL" -At -d "$DB" -c "SELECT count(*) FROM profiles WHERE id='$RECOVERED' AND org_id IS NULL AND role IS NULL AND activation_token='$RECOVERY_TOKEN';")" == 1 ]]
for denied_email in unmarked@example.invalid confirmed@example.invalid member@example.invalid orphan-member@example.invalid; do
  if "$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT * FROM recover_bulk_recipient_profile('$denied_email','Denied','$RECOVERY_TOKEN',now()+interval '7 days',NULL);" >/dev/null 2>&1; then exit 1; fi
done
[[ "$("$PSQL" -At -d "$DB" -c "SELECT count(*) FROM profiles WHERE id IN ('$UNMARKED','$CONFIRMED') OR (id='$MEMBER' AND activation_token IS NOT NULL);")" == 0 ]]

# Deterministic membership/recovery race using the production-shaped FK to
# auth.users: recovery waits for the in-flight membership, then the post-lock
# recheck refuses to arm the now-member profile.
( "$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -c "BEGIN; INSERT INTO org_members(user_id,org_id) VALUES ('$RACE_MEMBER','$ORG'); SELECT pg_sleep(1); COMMIT;" >"$A_LOG" 2>&1 ) & membership_pid=$!
sleep 0.1
set +e
"$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT * FROM recover_bulk_recipient_profile('race-member@example.invalid','Race','$RECOVERY_TOKEN',now()+interval '7 days',NULL);" >"$B_LOG" 2>&1
recovery_status=$?
set -e
wait "$membership_pid"
[[ "$recovery_status" -ne 0 ]]
grep -q 'recipient_recovery_conflict' "$B_LOG"
[[ "$("$PSQL" -At -d "$DB" -c "SELECT count(*) FROM profiles WHERE id='$RACE_MEMBER' AND activation_token IS NOT NULL;")" == 0 ]]

# SQL NULLs cannot bypass request validation.
for null_args in \
  "NULL,now()+interval '7 days'" \
  "'$RECOVERY_TOKEN',NULL"; do
  if "$PSQL" -v ON_ERROR_STOP=1 -d "$DB" -c "SET request.jwt.claim.role='service_role'; SELECT * FROM recover_bulk_recipient_profile('recover@example.invalid','Recovered',$null_args,NULL);" >/dev/null 2>&1; then exit 1; fi
done

catalog=$("$PSQL" -At -d "$DB" -c "SELECT pg_get_function_identity_arguments(oid)||' -> '||pg_get_function_result(oid) FROM pg_proc WHERE oid='public.recover_bulk_recipient_profile(text,text,text,timestamptz,uuid)'::regprocedure;")
[[ "$catalog" == 'p_email text, p_full_name text, p_activation_token text, p_activation_token_expires_at timestamp with time zone, p_expected_user_id uuid -> TABLE(profile_id uuid, activation_token text)' ]]
root_type=$(sed -n '/recover_bulk_recipient_profile:/,+10p' src/types/database.types.ts)
worker_type=$(sed -n '/recover_bulk_recipient_profile:/,+10p' services/worker/src/types/database.types.ts)
[[ "$root_type" == "$worker_type" ]]
[[ "$root_type" == *'p_expected_user_id?: string'* && "$root_type" == *'activation_token: string; profile_id: string'* ]]

echo 'UAT-23 native activation delivery PASS concurrency=exactly-one-claim replay=pending anon-auth=denied service-role=allowed actual-0439-trigger=bulk-blocked+ordinary-preserved orphan-recovery=marker-only+membership-denied membership-race=serialized-denial'
