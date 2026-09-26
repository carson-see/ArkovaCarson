#!/usr/bin/env bash
set -euo pipefail

# Isolated native PostgreSQL proof for migrations 0488-0489. This script starts its
# own throwaway cluster and never accepts a hosted DATABASE_URL.
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
scratch="$(mktemp -d)"
port="$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()
PY
)"
trap 'pg_ctl -D "$scratch/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"' EXIT

initdb -D "$scratch/data" --auth=trust --no-locale >/dev/null
pg_ctl -D "$scratch/data" -o "-h 127.0.0.1 -p $port" -w start >/dev/null
db_url="postgresql://127.0.0.1:$port/postgres"

psql "$db_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TYPE public.user_role AS ENUM ('INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER');
CREATE TABLE public.organizations(id uuid PRIMARY KEY);
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES public.organizations(id),
  role public.user_role NOT NULL DEFAULT 'INDIVIDUAL'
);
SQL

# Exercise the exact squashed-baseline enum/table bodies for every row the RPC
# mutates. Only organization/profile authority is a minimal fixture. Foreign
# keys added later in the baseline are recreated after the extracted bodies.
python3 - "$repo_root" "$scratch/baseline-agent-tables.sql" <<'PYEXTRACT'
import re, sys
from pathlib import Path
root, output = Path(sys.argv[1]), Path(sys.argv[2])
baseline = (root / 'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql').read_text()
pieces = []
for enum in ('agent_type', 'agent_status', 'api_key_rate_limit_tier'):
    match = re.search(r'CREATE TYPE "public"\."' + enum + r'" AS ENUM \(.*?\);', baseline, re.S)
    if not match: raise SystemExit(f'missing baseline enum {enum}')
    pieces.append(match.group())
for table in ('agents', 'api_keys'):
    match = re.search(r'CREATE TABLE IF NOT EXISTS "public"\."' + table + r'" \(.*?\n\);', baseline, re.S)
    if not match: raise SystemExit(f'missing baseline table {table}')
    pieces.append(match.group())
match = re.search(r'CREATE TABLE IF NOT EXISTS "public"\."audit_events" \(.*?WITH \(.*?\);', baseline, re.S)
if not match: raise SystemExit('missing baseline audit_events table')
pieces.append(match.group())
output.write_text('\n'.join(pieces) + '''
ALTER TABLE public.agents ADD CONSTRAINT fixture_agents_pk PRIMARY KEY(id);
ALTER TABLE public.api_keys ADD CONSTRAINT fixture_keys_pk PRIMARY KEY(id);
ALTER TABLE public.audit_events ADD CONSTRAINT fixture_audit_pk PRIMARY KEY(id);
ALTER TABLE public.agents ADD CONSTRAINT fixture_agents_org_fk FOREIGN KEY(org_id) REFERENCES public.organizations(id);
ALTER TABLE public.api_keys ADD CONSTRAINT fixture_keys_org_fk FOREIGN KEY(org_id) REFERENCES public.organizations(id);
ALTER TABLE public.api_keys ADD CONSTRAINT fixture_keys_agent_fk FOREIGN KEY(agent_id) REFERENCES public.agents(id);
ALTER TABLE public.audit_events ADD CONSTRAINT fixture_audit_actor_fk FOREIGN KEY(actor_id) REFERENCES public.profiles(id);
ALTER TABLE public.audit_events ADD CONSTRAINT fixture_audit_org_fk FOREIGN KEY(org_id) REFERENCES public.organizations(id);
''')
PYEXTRACT
psql "$db_url" -v ON_ERROR_STOP=1 -f "$scratch/baseline-agent-tables.sql" >/dev/null

# Load the exact 0448 trigger definitions used by main rather than copying them
# into this harness. The extraction begins at the key-authority function and
# ends at the terminal-status trigger, so source drift changes the exercised SQL.
awk '
  /^CREATE OR REPLACE FUNCTION public\.enforce_agent_key_active_authority\(\)/ { emit=1 }
  emit { print }
  /^FOR EACH ROW EXECUTE FUNCTION public\.enforce_agent_revocation_terminal\(\);/ { exit }
' "$repo_root/supabase/migrations/0448_computeid_agent_key_transition_atomic.sql" \
  >"$scratch/0448-agent-locks.sql"
psql "$db_url" -v ON_ERROR_STOP=1 -f "$scratch/0448-agent-locks.sql" >/dev/null
psql "$db_url" -v ON_ERROR_STOP=1 -f \
  "$repo_root/supabase/migrations/0488_atomic_admin_agent_revoke.sql" >/dev/null
psql "$db_url" -v ON_ERROR_STOP=1 -f \
  "$repo_root/supabase/migrations/0489_scrum3980_agent_lifecycle_api_key_revoke.sql" >/dev/null

org=11111111-1111-1111-1111-111111111111
other_org=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
actor=33333333-3333-3333-3333-333333333333
other_actor=77777777-7777-7777-7777-777777777777
member=88888888-8888-8888-8888-888888888888
missing_actor=99999999-9999-9999-9999-999999999999
agent=22222222-2222-2222-2222-222222222222
key=44444444-4444-4444-4444-444444444444
machine_key=12121212-1212-1212-1212-121212121212
minted=55555555-5555-5555-5555-555555555555
inactive=66666666-6666-6666-6666-666666666666
revoke_rpc="${REVOKE_RPC:-revoke_agent_and_keys}"
if test "$revoke_rpc" = revoke_agent_and_keys_as_api_key; then
  revoke_actor="$machine_key"
else
  revoke_actor="$actor"
fi

reset_fixture() {
  psql "$db_url" -v ON_ERROR_STOP=1 -v org="$org" -v other_org="$other_org" \
    -v actor="$actor" -v agent="$agent" -v key="$key" <<'SQL' >/dev/null
TRUNCATE public.audit_events, public.api_keys, public.agents, public.profiles, public.organizations CASCADE;
INSERT INTO public.organizations(id) VALUES (:'org'), (:'other_org');
INSERT INTO public.profiles(id,org_id,role) VALUES
  (:'actor',:'org','ORG_ADMIN'),
  ('77777777-7777-7777-7777-777777777777',:'other_org','ORG_ADMIN'),
  ('88888888-8888-8888-8888-888888888888',:'org','ORG_MEMBER');
INSERT INTO public.agents(id,org_id,name,status,registered_by) VALUES (:'agent',:'org','fixture','active',:'actor');
INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,agent_id,is_active,scopes) VALUES (:'key',:'org','fixture01','hash','fixture',:'actor',:'agent',true,ARRAY['verify']);
INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,is_active,scopes) VALUES ('12121212-1212-1212-1212-121212121212',:'org','machine01','machinehash','machine caller',:'actor',true,ARRAY['agents:manage','verify']);
INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,agent_id,is_active,revoked_at,revocation_reason)
VALUES ('66666666-6666-6666-6666-666666666666',:'org','fixture02','hash','inactive',:'actor',:'agent',false,now(),'manual:compromise');
SQL
}

assert_revoked() {
  test "$(psql "$db_url" -At -v agent="$agent" -c \
    "SELECT status || ':' || count(*) FILTER (WHERE k.is_active) FROM public.agents a LEFT JOIN public.api_keys k ON k.agent_id=a.id WHERE a.id='$agent' GROUP BY status")" = "revoked:0"
  test "$(psql "$db_url" -Atc "SELECT revocation_reason FROM public.api_keys WHERE id='$inactive'")" = 'manual:compromise'
}

# A controller session owns an advisory gate. The first transaction acquires
# its agent/key lock and then blocks on that gate. Only after pg_stat_activity
# proves that state do we launch the second transaction, prove it is blocked on
# a PostgreSQL lock, and release the gate. Polling is bounded and emits activity
# evidence on failure; elapsed time never establishes ordering.
wait_for_lock() {
  local app_name="$1"
  local i
  for i in $(seq 1 100); do
    if test "$(psql "$db_url" -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name='$app_name' AND wait_event_type='Lock'")" = 1; then
      return 0
    fi
    sleep 0.05
  done
  psql "$db_url" -x -c "SELECT application_name,state,wait_event_type,wait_event,query FROM pg_stat_activity WHERE application_name='$app_name'" >&2
  echo "timed out waiting for $app_name to block on a lock" >&2
  return 1
}

start_gate() {
  local app_name="$1" gate_key="$2"
  PGAPPNAME="$app_name" psql "$db_url" -v ON_ERROR_STOP=1 -c \
    "SELECT pg_advisory_lock($gate_key); SELECT pg_sleep(30);" >/dev/null 2>&1 &
  gate_pid=$!
  wait_for_lock_owner "$app_name" "$gate_key"
}

wait_for_lock_owner() {
  local app_name="$1" gate_key="$2"
  local i
  for i in $(seq 1 100); do
    if test "$(psql "$db_url" -Atc "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='$app_name' AND l.locktype='advisory' AND l.objid=$gate_key AND l.granted")" = 1; then
      return 0
    fi
    sleep 0.05
  done
  echo "timed out establishing advisory gate $app_name" >&2
  return 1
}

release_gate() {
  local app_name="$1"
  psql "$db_url" -v ON_ERROR_STOP=1 -Atc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='$app_name'" >/dev/null
  wait "$gate_pid" 2>/dev/null || true
}

# Lock order 1: mint owns the trigger's parent SHARE lock first; revoke is
# observed waiting, then sweeps the newly committed key.
reset_fixture
start_gate gate_mint_first 4801
PGAPPNAME=mint_first psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "BEGIN; INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,agent_id,is_active,scopes) VALUES ('$minted','$org','fixture03','hash','minted','$actor','$agent',true,ARRAY['verify']); SELECT pg_advisory_lock(4801); COMMIT;" >/dev/null & mint_pid=$!
wait_for_lock mint_first
PGAPPNAME=revoke_after_mint psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "SET ROLE service_role; SELECT public.$revoke_rpc('$org','$agent','$revoke_actor');" >/dev/null & revoke_pid=$!
wait_for_lock revoke_after_mint
release_gate gate_mint_first
wait "$mint_pid"; wait "$revoke_pid"; assert_revoked

# Lock order 2: revoke owns UPDATE first; mint is observed waiting and then
# fails 0448's authority constraint after revocation commits.
reset_fixture
start_gate gate_revoke_first 4802
PGAPPNAME=revoke_first psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "BEGIN; SET LOCAL ROLE service_role; SELECT public.$revoke_rpc('$org','$agent','$revoke_actor'); SELECT pg_advisory_lock(4802); COMMIT;" >/dev/null & revoke_pid=$!
wait_for_lock revoke_first
PGAPPNAME=mint_after_revoke psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,agent_id,is_active,scopes) VALUES ('$minted','$org','fixture03','hash','minted','$actor','$agent',true,ARRAY['verify']);" >"$scratch/mint.out" 2>&1 & mint_pid=$!
wait_for_lock mint_after_revoke
release_gate gate_revoke_first
wait "$revoke_pid"
if wait "$mint_pid"; then echo 'mint unexpectedly succeeded after revoke lock' >&2; exit 1; fi
grep -Eq 'agent_key_inactive(_or_wrong_org|_wrong_org_or_scope)' "$scratch/mint.out"; assert_revoked

# Resume-first: status/key restoration owns the lock first; revoke is observed
# waiting and then disables the restored key.
reset_fixture
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.api_keys SET is_active=false, revocation_reason='admin:agent.suspended' WHERE id='$key'; UPDATE public.agents SET status='suspended' WHERE id='$agent';" >/dev/null
start_gate gate_resume_first 4803
PGAPPNAME=resume_first psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "BEGIN; UPDATE public.agents SET status='active' WHERE id='$agent'; UPDATE public.api_keys SET is_active=true, revoked_at=NULL, revocation_reason=NULL WHERE id='$key'; SELECT pg_advisory_lock(4803); COMMIT;" >/dev/null & resume_pid=$!
wait_for_lock resume_first
PGAPPNAME=revoke_after_resume psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "SET ROLE service_role; SELECT public.$revoke_rpc('$org','$agent','$revoke_actor');" >/dev/null & revoke_pid=$!
wait_for_lock revoke_after_resume
release_gate gate_resume_first
wait "$resume_pid"; wait "$revoke_pid"; assert_revoked

# Revoke-first: stale resume is observed waiting, then terminal enforcement
# rejects it. Suspended keys must carry the permanent marker.
reset_fixture
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.api_keys SET is_active=false, revocation_reason='admin:agent.suspended' WHERE id='$key'; UPDATE public.agents SET status='suspended' WHERE id='$agent';" >/dev/null
start_gate gate_revoke_before_resume 4804
PGAPPNAME=revoke_before_resume psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "BEGIN; SET LOCAL ROLE service_role; SELECT public.$revoke_rpc('$org','$agent','$revoke_actor'); SELECT pg_advisory_lock(4804); COMMIT;" >/dev/null & revoke_pid=$!
wait_for_lock revoke_before_resume
PGAPPNAME=resume_after_revoke psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.agents SET status='active' WHERE id='$agent';" >"$scratch/resume.out" 2>&1 & resume_pid=$!
wait_for_lock resume_after_revoke
release_gate gate_revoke_before_resume
wait "$revoke_pid"
if wait "$resume_pid"; then echo 'resume unexpectedly succeeded after revoke lock' >&2; exit 1; fi
grep -q 'agent_revocation_is_terminal' "$scratch/resume.out"; assert_revoked
test "$(psql "$db_url" -Atc "SELECT revocation_reason FROM public.api_keys WHERE id='$key'")" = 'admin:agent.revoked'

if test "$revoke_rpc" = revoke_agent_and_keys_as_api_key; then
  # A caller that expires while waiting for its row lock is rejected. An advisory
  # gate proves the owner has acquired the key row before the revoke starts.
  reset_fixture
  psql "$db_url" -v ON_ERROR_STOP=1 -c \
    "UPDATE public.api_keys SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id='$machine_key';" >/dev/null
  start_gate gate_expiry_owner 4805
  PGAPPNAME=expiry_lock_owner psql "$db_url" -v ON_ERROR_STOP=1 -c \
    "BEGIN; SELECT id FROM public.api_keys WHERE id='$machine_key' FOR UPDATE; SELECT pg_advisory_lock(4805); COMMIT;" >/dev/null & expiry_owner_pid=$!
  wait_for_lock expiry_lock_owner
  test "$(psql "$db_url" -Atc "SELECT expires_at > clock_timestamp() FROM public.api_keys WHERE id='$machine_key'")" = t
  PGAPPNAME=expiry_waiter psql "$db_url" -v ON_ERROR_STOP=1 -c \
    "SET ROLE service_role; SELECT public.revoke_agent_and_keys_as_api_key('$org','$agent','$machine_key');" >"$scratch/expiry.out" 2>&1 & expiry_waiter_pid=$!
  wait_for_lock expiry_waiter
  psql "$db_url" -v ON_ERROR_STOP=1 -c "SELECT pg_sleep(4);" >/dev/null
  release_gate gate_expiry_owner
  wait "$expiry_owner_pid"
  if wait "$expiry_waiter_pid"; then echo 'key expiring during caller-lock wait unexpectedly authorized' >&2; exit 1; fi
  grep -q 'agent revocation requires an active agents:manage API key' "$scratch/expiry.out"
  test "$(psql "$db_url" -Atc "SELECT status FROM public.agents WHERE id='$agent'")" = active

fi

# Provider-owned suspension remains a database authority boundary even for
# legacy metadata that predates provider_suspended. Reinstatement clears the
# durable provider state before activation.
reset_fixture
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.agents SET status='suspended', metadata=jsonb_build_object('computeid',jsonb_build_object('issuer','computeid','last_event','passport.suspended')) WHERE id='$agent';" >/dev/null
if psql "$db_url" -v ON_ERROR_STOP=1 -c "UPDATE public.agents SET status='active' WHERE id='$agent';" >"$scratch/provider-resume.out" 2>&1; then
  echo 'legacy provider-suspended agent unexpectedly resumed' >&2; exit 1
fi
grep -q 'computeid_provider_suspension_active' "$scratch/provider-resume.out"
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.agents SET status='active', metadata=jsonb_build_object('computeid',jsonb_build_object('issuer','computeid','last_event','passport.reinstated')) WHERE id='$agent';" >/dev/null

# The parent lock checks the current scope ceiling on INSERT and scope UPDATE,
# so a mint that read a stale broader ceiling cannot commit.
reset_fixture
if psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,agent_id,is_active,scopes) VALUES ('$minted','$org','broad','broad-hash','broad','$actor','$agent',true,ARRAY['verify','read:search']);" >"$scratch/scope-insert.out" 2>&1; then
  echo 'over-ceiling attached key insert unexpectedly succeeded' >&2; exit 1
fi
grep -q 'agent_key_inactive_wrong_org_or_scope' "$scratch/scope-insert.out"
if psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.api_keys SET scopes=ARRAY['verify','read:search'] WHERE id='$key';" >"$scratch/scope-update.out" 2>&1; then
  echo 'over-ceiling active key scope update unexpectedly succeeded' >&2; exit 1
fi
grep -q 'agent_key_inactive_wrong_org_or_scope' "$scratch/scope-update.out"

# Direct authenticated-table writes cannot forge provider metadata or bypass
# atomic lifecycle status handling. Descriptive fields remain writable.
reset_fixture
psql "$db_url" -v ON_ERROR_STOP=1 -c "GRANT SELECT,INSERT,UPDATE ON public.agents TO authenticated;" >/dev/null
for direct_sql in \
  "INSERT INTO public.agents(id,org_id,name,status,registered_by,metadata) VALUES ('$minted','$org','forged','active','$actor','{\"computeid\":{\"issuer\":\"computeid\"}}')" \
  "UPDATE public.agents SET status='suspended' WHERE id='$agent'"; do
  if psql "$db_url" -v ON_ERROR_STOP=1 -c "SET ROLE authenticated; $direct_sql;" >"$scratch/direct.out" 2>&1; then
    echo 'direct authenticated lifecycle write unexpectedly succeeded' >&2; exit 1
  fi
done
psql "$db_url" -v ON_ERROR_STOP=1 -c "SET ROLE authenticated; UPDATE public.agents SET description='allowed', allowed_scopes=ARRAY['verify'] WHERE id='$agent';" >/dev/null
psql "$db_url" -v ON_ERROR_STOP=1 -c "UPDATE public.agents SET metadata=jsonb_build_object('computeid',jsonb_build_object('issuer','computeid','passport_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')) WHERE id='$agent';" >/dev/null
for direct_sql in \
  "UPDATE public.agents SET metadata='{}'::jsonb WHERE id='$agent'" \
  "UPDATE public.agents SET metadata=jsonb_set(metadata,'{computeid,passport_id}','\"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\"') WHERE id='$agent'" \
  "UPDATE public.agents SET allowed_scopes=ARRAY['webhooks:manage'] WHERE id='$agent'"; do
  if psql "$db_url" -v ON_ERROR_STOP=1 -c "SET ROLE authenticated; $direct_sql;" >"$scratch/direct-bound.out" 2>&1; then
    echo 'direct authenticated provider-bound mutation unexpectedly succeeded' >&2; exit 1
  fi
done

# Provider-first -> explicit org suspension -> provider reinstatement retains
# org ownership and dead keys; only a later explicit org resume restores the
# still-within-ceiling admin-marked key.
reset_fixture
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.agents SET status='suspended', metadata=jsonb_build_object('computeid',jsonb_build_object('issuer','computeid','passport_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','suspended_by','computeid','provider_suspended',true,'last_event','passport.suspended')) WHERE id='$agent'; UPDATE public.api_keys SET is_active=false,revoked_at=now(),revocation_reason='computeid:passport.suspended' WHERE id='$key'; SET ROLE service_role; SELECT public.apply_admin_agent_status_transition('$org','$agent','suspended','{}','user','$actor');" >/dev/null
test "$(psql "$db_url" -Atc "SELECT metadata #>> '{computeid,suspended_by}' IS NULL AND metadata->>'admin_suspended'='true' FROM public.agents WHERE id='$agent'")" = t
test "$(psql "$db_url" -Atc "SELECT revocation_reason FROM public.api_keys WHERE id='$key'")" = 'admin:agent.suspended'
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.agents SET metadata=jsonb_set((metadata #- '{computeid,provider_suspended}'),'{computeid,last_event}','\"passport.reinstated\"') WHERE id='$agent';" >/dev/null
test "$(psql "$db_url" -Atc "SELECT status FROM public.agents WHERE id='$agent'")" = suspended
test "$(psql "$db_url" -Atc "SELECT count(*) FROM public.api_keys WHERE agent_id='$agent' AND is_active")" = 0
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "SET ROLE service_role; SELECT public.apply_admin_agent_status_transition('$org','$agent','active','{}','user','$actor');" >/dev/null
test "$(psql "$db_url" -Atc "SELECT status FROM public.agents WHERE id='$agent'")" = active

# Narrowing allowed scopes during atomic suspension leaves broader historical
# keys inactive on resume while restoring a still-eligible key.
reset_fixture
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.agents SET allowed_scopes=ARRAY['verify','read:search'] WHERE id='$agent'; INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,agent_id,is_active,scopes) VALUES ('$minted','$org','broad001','broad2','broad','$actor','$agent',true,ARRAY['verify','read:search']); SET ROLE service_role; SELECT public.apply_admin_agent_status_transition('$org','$agent','suspended','{\"allowed_scopes\":[\"verify\"]}','user','$actor'); SELECT public.apply_admin_agent_status_transition('$org','$agent','active','{}','user','$actor');" >/dev/null
test "$(psql "$db_url" -Atc "SELECT is_active FROM public.api_keys WHERE id='$key'")" = t
test "$(psql "$db_url" -Atc "SELECT is_active FROM public.api_keys WHERE id='$minted'")" = f
test "$(psql "$db_url" -Atc "SELECT revocation_reason FROM public.api_keys WHERE id='$inactive'")" = 'manual:compromise'

# Mixed resume+scope changes use the post-update ceiling in the same RPC.
# Narrowing restores only the eligible key; widening makes a previously
# over-ceiling admin-suspended key eligible for restoration.
reset_fixture
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.agents SET status='suspended',allowed_scopes=ARRAY['verify','read:search'],metadata=jsonb_build_object('admin_suspended',true) WHERE id='$agent'; UPDATE public.api_keys SET is_active=false,revocation_reason='admin:agent.suspended' WHERE id='$key'; INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,agent_id,is_active,scopes,revocation_reason) VALUES ('$minted','$org','broad001','broad3','broad','$actor','$agent',false,ARRAY['verify','read:search'],'admin:agent.suspended'); SET ROLE service_role; SELECT public.apply_admin_agent_status_transition('$org','$agent','active','{\"allowed_scopes\":[\"verify\"]}','user','$actor');" >/dev/null
test "$(psql "$db_url" -Atc "SELECT is_active FROM public.api_keys WHERE id='$key'")" = t
test "$(psql "$db_url" -Atc "SELECT is_active FROM public.api_keys WHERE id='$minted'")" = f
psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "UPDATE public.agents SET status='suspended',metadata=jsonb_build_object('admin_suspended',true) WHERE id='$agent'; SET ROLE service_role; SELECT public.apply_admin_agent_status_transition('$org','$agent','active','{\"allowed_scopes\":[\"verify\",\"read:search\"]}','user','$actor');" >/dev/null
test "$(psql "$db_url" -Atc "SELECT is_active FROM public.api_keys WHERE id='$minted'")" = t

# Audit failure rolls back agent and key changes together.
reset_fixture
psql "$db_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE FUNCTION public.fail_revoke_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.event_type IN ('AGENT_REVOKED','AGENT_SUSPENDED') THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER fail_revoke_audit BEFORE INSERT ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.fail_revoke_audit();
SQL
if psql "$db_url" -v ON_ERROR_STOP=1 -c \
  "SET ROLE service_role; SELECT public.apply_admin_agent_status_transition('$org','$agent','suspended','{}','user','$actor');" >"$scratch/status-rollback.out" 2>&1; then
  echo 'forced status audit failure unexpectedly committed' >&2; exit 1
fi
grep -q 'forced audit failure' "$scratch/status-rollback.out"
test "$(psql "$db_url" -Atc "SELECT status FROM public.agents WHERE id='$agent'")" = active
test "$(psql "$db_url" -Atc "SELECT is_active FROM public.api_keys WHERE id='$key'")" = t

if psql "$db_url" -v ON_ERROR_STOP=1 -v org="$org" -v agent="$agent" -v actor="$actor" -c \
  "SET ROLE service_role; SELECT public.$revoke_rpc('$org','$agent','$revoke_actor');" >"$scratch/rollback.out" 2>&1; then
  echo 'forced audit failure unexpectedly committed' >&2; exit 1
fi
grep -q 'forced audit failure' "$scratch/rollback.out"
test "$(psql "$db_url" -At -v agent="$agent" -c "SELECT status FROM public.agents WHERE id='$agent'")" = active
test "$(psql "$db_url" -At -v key="$key" -c "SELECT is_active FROM public.api_keys WHERE id='$key'")" = t
psql "$db_url" -v ON_ERROR_STOP=1 -c 'DROP TRIGGER fail_revoke_audit ON public.audit_events; DROP FUNCTION public.fail_revoke_audit();' >/dev/null

if test "$revoke_rpc" = revoke_agent_and_keys_as_api_key; then
  reset_fixture
  psql "$db_url" -v ON_ERROR_STOP=1 -c \
    "SET ROLE service_role; SELECT public.apply_admin_agent_status_transition('$org','$agent','suspended','{\"allowed_scopes\":[\"anchor:read\"]}','api_key','$machine_key');" >/dev/null
  test "$(psql "$db_url" -Atc "SELECT allowed_scopes=ARRAY['anchor:read']::text[] FROM public.agents WHERE id='$agent'")" = t

  # Self-revoke validates the caller before the sweep, then atomically revokes
  # that same caller key and attributes the audit to it.
  reset_fixture
  psql "$db_url" -v ON_ERROR_STOP=1 -c \
    "UPDATE public.agents SET allowed_scopes=ARRAY['verify','agents:manage'] WHERE id='$agent'; UPDATE public.api_keys SET agent_id='$agent' WHERE id='$machine_key'; SET ROLE service_role; SELECT public.revoke_agent_and_keys_as_api_key('$org','$agent','$machine_key');" >/dev/null
  test "$(psql "$db_url" -Atc "SELECT is_active FROM public.api_keys WHERE id='$machine_key'")" = f
  test "$(psql "$db_url" -Atc "SELECT actor_id IS NULL AND details::jsonb->>'actor_api_key_id'='$machine_key' FROM public.audit_events WHERE event_type='AGENT_REVOKED'")" = t
  assert_revoked
  reset_fixture
fi

# Tenant isolation, privilege boundary, and clean-retry idempotency.
test "$(psql "$db_url" -qAt -v other_org="$other_org" -v agent="$agent" -v actor="$actor" -c \
  "SET ROLE service_role; SELECT public.revoke_agent_and_keys('$other_org','$agent','$other_actor')->>'found';")" = false
for denied_role in anon authenticated; do
  if psql "$db_url" -v ON_ERROR_STOP=1 -v role="$denied_role" -v org="$org" -v agent="$agent" -v actor="$actor" -c \
    "SET ROLE $denied_role; SELECT public.revoke_agent_and_keys('$org','$agent','$actor');" >/dev/null 2>&1; then
    echo "$denied_role unexpectedly executed revoke RPC" >&2; exit 1
  fi
done

# The SECURITY DEFINER function independently enforces the route's actor rule
# before any write: same-org ORG_ADMIN only.
for denied_actor in "$other_actor" "$member" "$missing_actor"; do
  if psql "$db_url" -v ON_ERROR_STOP=1 -c \
    "SET ROLE service_role; SELECT public.revoke_agent_and_keys('$org','$agent','$denied_actor');" >"$scratch/actor.out" 2>&1; then
    echo "actor $denied_actor unexpectedly authorized" >&2; exit 1
  fi
  grep -q 'agent revocation requires an organization admin actor' "$scratch/actor.out"
  test "$(psql "$db_url" -Atc "SELECT status FROM public.agents WHERE id='$agent'")" = active
  test "$(psql "$db_url" -Atc "SELECT is_active FROM public.api_keys WHERE id='$key'")" = t
done
psql "$db_url" -v ON_ERROR_STOP=1 -v org="$org" -v agent="$agent" -v actor="$actor" -c \
  "SET ROLE service_role; SELECT public.revoke_agent_and_keys('$org','$agent','$actor'); SELECT public.revoke_agent_and_keys('$org','$agent','$actor');" >/dev/null
test "$(psql "$db_url" -At -c "SELECT count(*) FROM public.audit_events WHERE event_type='AGENT_REVOKED'")" = 1
assert_revoked

echo "agent revoke native PostgreSQL concurrency tests passed ($revoke_rpc)"
