#!/usr/bin/env bash
set -euo pipefail

# Full-lineage concurrency proof for the generic agent revoke path. The caller
# must provide the already-reset, disposable local Supabase database. This
# script never starts a database, applies a migration, or accepts a remote URL.

database_url="${UAT03_DATABASE_URL:-}"
if [[ -z "$database_url" ]]; then
  echo "UAT03_DATABASE_URL is required" >&2
  exit 2
fi

database_host="$(python3 - "$database_url" <<'PY'
import ipaddress
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
host = parsed.hostname
if parsed.scheme not in {"postgres", "postgresql"} or not host:
    raise SystemExit("UAT03_DATABASE_URL must be a PostgreSQL URL")
if parsed.query or parsed.fragment:
    raise SystemExit("UAT03_DATABASE_URL must not contain query parameters or a fragment")
try:
    is_loopback = ipaddress.ip_address(host).is_loopback
except ValueError:
    is_loopback = host == "localhost"
if not is_loopback:
    raise SystemExit("UAT03_DATABASE_URL must target loopback")
print(host)
PY
)"
readonly database_host
# A URI host must remain authoritative. In particular, inherited PGHOSTADDR or
# PGSERVICE values must not redirect a verified loopback URL to another server.
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE
export PGCONNECT_TIMEOUT=5

scratch="$(mktemp -d)"
run_uuid="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
run_slug="${run_uuid//-/}"
app_prefix="ar20_${run_slug:0:8}"
gate_base=$((16#${run_slug:0:7}))
org_id="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
actor_id="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
email="agent-revoke-${run_slug}@example.test"
trigger_name="fail_agent_revoke_${run_slug}"
trigger_function="fail_agent_revoke_${run_slug}"
gate_pid=""
background_pids=()
fixture_agents=()

psql_base=(psql "$database_url" -X -q -v ON_ERROR_STOP=1)

scalar() {
  "${psql_base[@]}" -A -t -c "$1"
}

terminate_fixture_backends() {
  "${psql_base[@]}" -v prefix="${app_prefix}_" <<'SQL' >/dev/null 2>&1 || true
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND left(application_name,length(:'prefix'))=:'prefix';
SQL
}

cleanup() {
  local status=$?
  set +e
  terminate_fixture_backends
  for pid in "${background_pids[@]:-}"; do
    [[ -n "$pid" ]] && wait "$pid" >/dev/null 2>&1
  done
  cleanup_ok=1
  if ! "${psql_base[@]}" -v trigger_name="$trigger_name" -v trigger_function="$trigger_function" \
    <<'SQL' >/dev/null 2>&1
SELECT format('DROP TRIGGER %I ON public.audit_events', tgname)
FROM pg_trigger WHERE tgname=:'trigger_name' \gexec
SELECT format('DROP FUNCTION public.%I()', p.proname)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname=:'trigger_function' \gexec
SQL
  then
    cleanup_ok=0
  fi
  # Run data cleanup independently so a failed test-only DDL cleanup cannot
  # prevent removal of operational fixtures.
  if ! "${psql_base[@]}" -v org="$org_id" <<'SQL' >/dev/null 2>&1
DELETE FROM public.webhook_delivery_logs
 WHERE agent_event_outbox_id IN (SELECT id FROM public.agent_webhook_outbox WHERE org_id=:'org');
DELETE FROM public.agent_webhook_outbox WHERE org_id=:'org';
DELETE FROM public.api_keys WHERE org_id=:'org';
DELETE FROM public.agents WHERE org_id=:'org';
SQL
  then
    cleanup_ok=0
  fi
  # audit_events are append-only by contract, and their immutable UPDATE guard
  # prevents ON DELETE SET NULL from removing the referenced org/profile. Those
  # three identity rows therefore remain in this disposable database with the
  # audits. Remove every operational fixture row and emit counts, never details.
  remaining="$(scalar "SELECT
    (SELECT count(*) FROM public.agents WHERE org_id='$org_id')+
    (SELECT count(*) FROM public.api_keys WHERE org_id='$org_id')+
    (SELECT count(*) FROM public.agent_webhook_outbox WHERE org_id='$org_id');" 2>/dev/null || echo cleanup-error)"
  audit_count="$(scalar "SELECT count(*) FROM public.audit_events WHERE target_id = ANY(ARRAY[$(printf "'%s'," "${fixture_agents[@]}" | sed 's/,$//')]::text[]);" 2>/dev/null || echo unknown)"
  identity_count="$(scalar "SELECT
    (SELECT count(*) FROM auth.users WHERE id='$actor_id')+
    (SELECT count(*) FROM public.profiles WHERE id='$actor_id')+
    (SELECT count(*) FROM public.organizations WHERE id='$org_id');" 2>/dev/null || echo unknown)"
  rm -rf "$scratch"
  if [[ $cleanup_ok -ne 1 || "$remaining" != "0" ]]; then
    echo "agent revoke full-schema cleanup failed (remaining operation rows: $remaining)" >&2
    exit 1
  fi
  if [[ $status -ne 0 ]]; then
    echo "agent revoke full-schema concurrency contract failed; fixture output withheld (append-only audit rows: $audit_count; required identity rows: $identity_count)" >&2
    exit "$status"
  fi
  echo "agent revoke full-schema cleanup passed (append-only audit rows: $audit_count; required identity rows: $identity_count)"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v email="$email" <<'SQL' >/dev/null
BEGIN;
INSERT INTO auth.users(id,email) VALUES (:'actor',:'email');
INSERT INTO public.organizations(id,legal_name,display_name)
VALUES (:'org','Agent revoke concurrency fixture','Agent revoke concurrency fixture');
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.profiles(id,email,role,org_id)
VALUES (:'actor',:'email','ORG_ADMIN',:'org')
ON CONFLICT(id) DO UPDATE SET email=excluded.email,role=excluded.role,org_id=excluded.org_id;
RESET ROLE;
SELECT set_config('request.jwt.claim.role','',true);
COMMIT;
SQL

# Ratchet the repaired lock contract itself. The behavioral cases below prove
# both parent-lock orderings; this definition check ensures an API-key caller
# cannot reintroduce the former caller-key -> target-agent inversion.
"${psql_base[@]}" <<'SQL' >/dev/null
DO $$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.create_agent_key_with_outbox(uuid,uuid,text,uuid,text,text)'::regprocedure
  ) INTO v_definition;
  IF position('SELECT * INTO v_agent FROM public.agents' IN v_definition) = 0
     OR position('v_actor:=public.resolve_agent_manager' IN v_definition) = 0
     OR position('SELECT * INTO v_agent FROM public.agents' IN v_definition)
        > position('v_actor:=public.resolve_agent_manager' IN v_definition) THEN
    RAISE EXCEPTION 'create-agent-key lock order is not target-agent then caller';
  END IF;
END;
$$;
SQL

new_agent() {
  local agent_id key_id label
  agent_id="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
  key_id="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
  label="$1"
  fixture_agents+=("$agent_id")
  "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v agent="$agent_id" \
    -v key="$key_id" -v label="$label" <<'SQL' >/dev/null
INSERT INTO public.agents(id,org_id,name,status,registered_by,allowed_scopes)
VALUES (:'agent',:'org',:'label','active',:'actor',ARRAY['verify']);
INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,agent_id,is_active,scopes)
VALUES (:'key',:'org','ak_live_base',repeat('a',64),:'label',:'actor',:'agent',true,ARRAY['verify']);
SQL
  current_agent="$agent_id"
  current_key="$key_id"
}

wait_for_advisory_owner() {
  local app_name=$1 gate_key=$2 i
  for i in $(seq 1 120); do
    if [[ "$(scalar "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='$app_name' AND l.locktype='advisory' AND l.objid=$gate_key AND l.granted")" == 1 ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "advisory owner was not observed" >&2
  return 1
}

wait_for_blocked_lock() {
  local app_name=$1 i
  for i in $(seq 1 120); do
    if [[ "$(scalar "SELECT count(*) FROM pg_stat_activity WHERE application_name='$app_name' AND wait_event_type='Lock'")" == 1 ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "bounded lock wait was not observed for $app_name" >&2
  return 1
}

start_gate() {
  local suffix=$1 gate_key=$2 app_name
  app_name="${app_prefix}_gate_${suffix}"
  PGAPPNAME="$app_name" "${psql_base[@]}" -c \
    "SELECT pg_advisory_lock($gate_key); SELECT pg_sleep(120);" >/dev/null 2>&1 &
  gate_pid=$!
  background_pids+=("$gate_pid")
  wait_for_advisory_owner "$app_name" "$gate_key"
}

release_gate() {
  local suffix=$1 app_name
  app_name="${app_prefix}_gate_${suffix}"
  "${psql_base[@]}" -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='$app_name';" >/dev/null
  wait "$gate_pid" >/dev/null 2>&1 || true
  gate_pid=""
}

assert_revoked() {
  local agent_id=$1 expected_audits=${2:-1}
  [[ "$(scalar "SELECT status||':'||(SELECT count(*) FROM public.api_keys WHERE agent_id='$agent_id' AND is_active) FROM public.agents WHERE id='$agent_id'")" == "revoked:0" ]]
  [[ "$(scalar "SELECT count(*) FROM public.audit_events WHERE event_type='AGENT_REVOKED' AND target_id='$agent_id'")" == "$expected_audits" ]]
}

# Mint owns the real parent lock first; revoke waits and then sweeps the key.
new_agent mint_first
agent="$current_agent"; key="$current_key"
prefix="ak_live_$(printf '%s' "$run_slug" | cut -c1-4)"
gate=$((gate_base+1))
start_gate mint_first "$gate"
first_app="${app_prefix}_mint_first"
PGAPPNAME="$first_app" "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" \
  -v agent="$agent" -v prefix="$prefix" -v gate="$gate" <<'SQL' >"$scratch/mint-first.out" 2>&1 &
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.create_agent_key_with_outbox(:'org',:'agent','user',:'actor',repeat('b',64),:'prefix');
SELECT pg_advisory_lock(:'gate');
COMMIT;
SQL
mint_pid=$!; background_pids+=("$mint_pid")
wait_for_blocked_lock "$first_app"
second_app="${app_prefix}_revoke_after_mint"
PGAPPNAME="$second_app" "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v agent="$agent" \
  >"$scratch/revoke-after-mint.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT public.revoke_agent_and_keys_with_outbox(:'org',:'agent',:'actor');
SQL
revoke_pid=$!; background_pids+=("$revoke_pid")
wait_for_blocked_lock "$second_app"
release_gate mint_first
wait "$mint_pid"; wait "$revoke_pid"
assert_revoked "$agent"
[[ "$(scalar "SELECT count(*) FROM public.api_keys WHERE agent_id='$agent' AND key_prefix='$prefix' AND NOT is_active")" == 1 ]]

# Revoke owns the lock first; the real mint RPC waits and then returns inactive
# without inserting another key.
new_agent revoke_first
agent="$current_agent"; key="$current_key"
prefix="ak_live_$(printf '%s' "$run_slug" | cut -c5-8)"
gate=$((gate_base+2))
start_gate revoke_first "$gate"
first_app="${app_prefix}_revoke_first"
PGAPPNAME="$first_app" "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" \
  -v agent="$agent" -v gate="$gate" <<'SQL' >"$scratch/revoke-first.out" 2>&1 &
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.revoke_agent_and_keys_with_outbox(:'org',:'agent',:'actor');
SELECT pg_advisory_lock(:'gate');
COMMIT;
SQL
revoke_pid=$!; background_pids+=("$revoke_pid")
wait_for_blocked_lock "$first_app"
second_app="${app_prefix}_mint_after_revoke"
PGAPPNAME="$second_app" "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" \
  -v agent="$agent" -v prefix="$prefix" >"$scratch/mint-after-revoke.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT public.create_agent_key_with_outbox(:'org',:'agent','user',:'actor',repeat('c',64),:'prefix');
SQL
mint_pid=$!; background_pids+=("$mint_pid")
wait_for_blocked_lock "$second_app"
release_gate revoke_first
wait "$revoke_pid"; wait "$mint_pid"
assert_revoked "$agent"
[[ "$(scalar "SELECT count(*) FROM public.api_keys WHERE agent_id='$agent' AND key_prefix='$prefix'")" == 0 ]]
grep -q '"inactive": true' "$scratch/mint-after-revoke.out"

# Exercise the former API-key-specific inversion with two real backends. The
# revoke transaction owns the target agent before it proceeds to its attached
# caller key. A concurrent mint must wait on that target without first owning
# the caller key; revoke can then complete, and mint observes terminal state.
new_agent machine_lock_inversion
agent="$current_agent"; key="$current_key"
"${psql_base[@]}" -v agent="$agent" -v key="$key" <<'SQL' >/dev/null
UPDATE public.agents SET allowed_scopes=ARRAY['agents:manage','verify'] WHERE id=:'agent';
UPDATE public.api_keys SET scopes=ARRAY['agents:manage','verify'] WHERE id=:'key';
SQL
prefix="ak_live_$(printf '%s' "$run_slug" | cut -c9-12)"
gate=$((gate_base+5))
start_gate machine_lock_inversion "$gate"
first_app="${app_prefix}_machine_revoke"
PGAPPNAME="$first_app" "${psql_base[@]}" -v org="$org_id" -v agent="$agent" \
  -v key="$key" -v gate="$gate" <<'SQL' >"$scratch/machine-revoke.out" 2>&1 &
BEGIN;
SET LOCAL ROLE service_role;
SELECT 1 FROM public.agents WHERE id=:'agent' AND org_id=:'org' FOR UPDATE;
SELECT pg_advisory_lock(:'gate');
SELECT public.revoke_agent_and_keys_as_api_key_with_outbox(:'org',:'agent',:'key');
COMMIT;
SQL
revoke_pid=$!; background_pids+=("$revoke_pid")
wait_for_blocked_lock "$first_app"
second_app="${app_prefix}_machine_mint"
PGAPPNAME="$second_app" "${psql_base[@]}" -v org="$org_id" -v actor="$key" \
  -v agent="$agent" -v prefix="$prefix" >"$scratch/machine-mint.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT public.create_agent_key_with_outbox(:'org',:'agent','api_key',:'actor',repeat('9',64),:'prefix');
SQL
mint_pid=$!; background_pids+=("$mint_pid")
wait_for_blocked_lock "$second_app"
release_gate machine_lock_inversion
wait "$revoke_pid"
if wait "$mint_pid"; then
  grep -q '"inactive": true' "$scratch/machine-mint.out"
else
  # The revocation includes the attached caller key. Depending on the row
  # version observed after the wait, mint may revalidate that caller and deny.
  grep -q 'agent manager required' "$scratch/machine-mint.out"
fi
assert_revoked "$agent"
if grep -qi 'deadlock detected' "$scratch/machine-revoke.out" "$scratch/machine-mint.out" \
  || [[ "$(scalar "SELECT count(*) FROM public.api_keys WHERE agent_id='$agent' AND key_prefix='$prefix'")" != 0 ]]; then
  echo "machine mint/revoke lock order deadlocked or minted after revoke" >&2
  exit 1
fi

# The actual current resume wrapper commits first; revoke then sweeps its key.
new_agent resume_first
agent="$current_agent"; key="$current_key"
"${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v agent="$agent" <<'SQL' >/dev/null
SET ROLE service_role;
SELECT public.apply_admin_agent_status_transition_with_outbox(:'org',:'agent','suspended','{}','user',:'actor');
SQL
gate=$((gate_base+3))
start_gate resume_first "$gate"
first_app="${app_prefix}_resume_first"
PGAPPNAME="$first_app" "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" \
  -v agent="$agent" -v gate="$gate" <<'SQL' >"$scratch/resume-first.out" 2>&1 &
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.apply_admin_agent_status_transition_with_outbox(:'org',:'agent','active','{}','user',:'actor');
SELECT pg_advisory_lock(:'gate');
COMMIT;
SQL
resume_pid=$!; background_pids+=("$resume_pid")
wait_for_blocked_lock "$first_app"
second_app="${app_prefix}_revoke_after_resume"
PGAPPNAME="$second_app" "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v agent="$agent" \
  >"$scratch/revoke-after-resume.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT public.revoke_agent_and_keys_with_outbox(:'org',:'agent',:'actor');
SQL
revoke_pid=$!; background_pids+=("$revoke_pid")
wait_for_blocked_lock "$second_app"
release_gate resume_first
wait "$resume_pid"; wait "$revoke_pid"
assert_revoked "$agent"

# Revoke commits first; the actual resume wrapper waits and then fails on the
# terminal-state constraint, leaving no live key.
new_agent revoke_before_resume
agent="$current_agent"; key="$current_key"
"${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v agent="$agent" <<'SQL' >/dev/null
SET ROLE service_role;
SELECT public.apply_admin_agent_status_transition_with_outbox(:'org',:'agent','suspended','{}','user',:'actor');
SQL
gate=$((gate_base+4))
start_gate revoke_before_resume "$gate"
first_app="${app_prefix}_revoke_before_resume"
PGAPPNAME="$first_app" "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" \
  -v agent="$agent" -v gate="$gate" <<'SQL' >"$scratch/revoke-before-resume.out" 2>&1 &
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.revoke_agent_and_keys_with_outbox(:'org',:'agent',:'actor');
SELECT pg_advisory_lock(:'gate');
COMMIT;
SQL
revoke_pid=$!; background_pids+=("$revoke_pid")
wait_for_blocked_lock "$first_app"
second_app="${app_prefix}_resume_after_revoke"
PGAPPNAME="$second_app" "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v agent="$agent" \
  >"$scratch/resume-after-revoke.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT public.apply_admin_agent_status_transition_with_outbox(:'org',:'agent','active','{}','user',:'actor');
SQL
resume_pid=$!; background_pids+=("$resume_pid")
wait_for_blocked_lock "$second_app"
release_gate revoke_before_resume
wait "$revoke_pid"
if wait "$resume_pid"; then
  echo "resume unexpectedly succeeded after terminal revoke" >&2
  exit 1
fi
grep -q 'agent_revocation_is_terminal' "$scratch/resume-after-revoke.out"
assert_revoked "$agent"

# A failing audit insert rolls back agent, keys and outbox as one transaction.
new_agent audit_rollback
agent="$current_agent"; key="$current_key"
"${psql_base[@]}" -v trigger_name="$trigger_name" -v trigger_function="$trigger_function" \
  -v agent="$agent" <<'SQL' >/dev/null
SELECT format(
  'CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION ''forced fixture audit failure''; END $fn$',
  :'trigger_function') \gexec
SELECT format(
  'CREATE TRIGGER %I BEFORE INSERT ON public.audit_events FOR EACH ROW WHEN (NEW.event_type=''AGENT_REVOKED'' AND NEW.target_id=%L) EXECUTE FUNCTION public.%I()',
  :'trigger_name', :'agent', :'trigger_function') \gexec
SQL
if "${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v agent="$agent" \
  >"$scratch/audit-rollback.out" 2>&1 <<'SQL'
SET ROLE service_role;
SELECT public.revoke_agent_and_keys_with_outbox(:'org',:'agent',:'actor');
SQL
then
  echo "forced audit failure unexpectedly committed" >&2
  exit 1
fi
grep -q 'forced fixture audit failure' "$scratch/audit-rollback.out"
[[ "$(scalar "SELECT status||':'||(SELECT count(*) FROM public.api_keys WHERE agent_id='$agent' AND is_active) FROM public.agents WHERE id='$agent'")" == "active:1" ]]
[[ "$(scalar "SELECT count(*) FROM public.audit_events WHERE event_type='AGENT_REVOKED' AND target_id='$agent'")" == 0 ]]
[[ "$(scalar "SELECT count(*) FROM public.agent_webhook_outbox WHERE event_type='agent.revoked' AND agent_id='$agent'")" == 0 ]]
"${psql_base[@]}" -v trigger_name="$trigger_name" -v trigger_function="$trigger_function" <<'SQL' >/dev/null
SELECT format('DROP TRIGGER %I ON public.audit_events', :'trigger_name') \gexec
SELECT format('DROP FUNCTION public.%I()', :'trigger_function') \gexec
SQL

# A clean retry is terminal and creates exactly one audit/outbox event.
new_agent idempotent
agent="$current_agent"; key="$current_key"
"${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v agent="$agent" <<'SQL' >/dev/null
SET ROLE service_role;
SELECT public.revoke_agent_and_keys_with_outbox(:'org',:'agent',:'actor');
SELECT public.revoke_agent_and_keys_with_outbox(:'org',:'agent',:'actor');
SQL
assert_revoked "$agent"
[[ "$(scalar "SELECT count(*) FROM public.agent_webhook_outbox WHERE event_type='agent.revoked' AND agent_id='$agent'")" == 1 ]]

# The physical-delete guard is atomic too. If its required audit cannot be
# written, neither the agent delete nor its key rewrite may commit.
new_agent service_delete_rollback
agent="$current_agent"; key="$current_key"
"${psql_base[@]}" -v trigger_name="$trigger_name" -v trigger_function="$trigger_function" \
  -v agent="$agent" <<'SQL' >/dev/null
SELECT format(
  'CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION ''forced physical-delete audit failure''; END $fn$',
  :'trigger_function') \gexec
SELECT format(
  'CREATE TRIGGER %I BEFORE INSERT ON public.audit_events FOR EACH ROW WHEN (NEW.event_type=''AGENT_REVOKED'' AND NEW.target_id=%L) EXECUTE FUNCTION public.%I()',
  :'trigger_name', :'agent', :'trigger_function') \gexec
SQL
if "${psql_base[@]}" -v org="$org_id" -v agent="$agent" >"$scratch/delete-audit-rollback.out" 2>&1 <<'SQL'
SET ROLE service_role;
DELETE FROM public.agents WHERE id=:'agent' AND org_id=:'org';
SQL
then
  echo "forced physical-delete audit failure unexpectedly committed" >&2
  exit 1
fi
grep -q 'forced physical-delete audit failure' "$scratch/delete-audit-rollback.out"
if [[ "$(scalar "SELECT count(*) FROM public.agents WHERE id='$agent'")" != 1 ]] \
  || [[ "$(scalar "SELECT is_active||':'||COALESCE(revocation_reason,'') FROM public.api_keys WHERE id='$key'")" != "true:" ]] \
  || [[ "$(scalar "SELECT count(*) FROM public.audit_events WHERE event_type='AGENT_REVOKED' AND target_id='$agent'")" != 0 ]]; then
  echo "physical-delete audit failure did not roll back agent and key state" >&2
  exit 1
fi
"${psql_base[@]}" -v trigger_name="$trigger_name" -v trigger_function="$trigger_function" <<'SQL' >/dev/null
SELECT format('DROP TRIGGER %I ON public.audit_events', :'trigger_name') \gexec
SELECT format('DROP FUNCTION public.%I()', :'trigger_function') \gexec
SQL

# An internal physical delete may remove the agent row, but it must never leave
# a live or resumable credential behind when the FK clears agent_id.
new_agent service_delete
agent="$current_agent"; key="$current_key"
compromised_key="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
admin_resumable_key="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
provider_resumable_key="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
"${psql_base[@]}" -v org="$org_id" -v actor="$actor_id" -v agent="$agent" \
  -v compromised_key="$compromised_key" -v admin_key="$admin_resumable_key" \
  -v provider_key="$provider_resumable_key" <<'SQL' >/dev/null
INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,created_by,agent_id,is_active,revoked_at,revocation_reason,scopes)
VALUES (:'compromised_key',:'org','ak_live_dead',repeat('d',64),'compromised fixture',:'actor',
    :'agent',false,clock_timestamp(),'security:compromised',ARRAY['verify']),
  (:'admin_key',:'org','ak_live_admn',repeat('e',64),'admin-resumable fixture',:'actor',
    :'agent',false,clock_timestamp(),'admin:agent.suspended',ARRAY['verify']),
  (:'provider_key',:'org','ak_live_comp',repeat('f',64),'provider-resumable fixture',:'actor',
    :'agent',false,clock_timestamp(),'computeid:passport.suspended',ARRAY['verify']);
SET ROLE service_role;
DELETE FROM public.agents WHERE id=:'agent' AND org_id=:'org';
SQL
if [[ "$(scalar "SELECT count(*) FROM public.agents WHERE id='$agent'")" != 0 ]] \
  || [[ "$(scalar "SELECT is_active||':'||COALESCE(revocation_reason,'')||':'||(agent_id IS NULL) FROM public.api_keys WHERE id='$key'")" != "false:system:agent.deleted:true" ]] \
  || [[ "$(scalar "SELECT is_active||':'||COALESCE(revocation_reason,'')||':'||(agent_id IS NULL) FROM public.api_keys WHERE id='$compromised_key'")" != "false:security:compromised:true" ]] \
  || [[ "$(scalar "SELECT string_agg(is_active||':'||COALESCE(revocation_reason,'')||':'||(agent_id IS NULL),',' ORDER BY id) FROM public.api_keys WHERE id IN ('$admin_resumable_key','$provider_resumable_key')")" != "false:system:agent.deleted:true,false:system:agent.deleted:true" ]] \
  || [[ "$(scalar "SELECT count(*) FROM public.audit_events WHERE event_type='AGENT_REVOKED' AND target_id='$agent' AND details::jsonb->>'reason'='physical_delete'")" != 1 ]]; then
  echo "physical agent delete left an active/resumable key or lacked its audit" >&2
  exit 1
fi

echo "agent revoke full-schema concurrency contract passed"
