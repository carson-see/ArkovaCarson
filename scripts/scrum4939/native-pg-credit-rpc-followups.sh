#!/usr/bin/env bash
#
# SCRUM-4939 follow-ups (migration 0483) — native PostgreSQL proof.
#
# Runs the real migration files against a throwaway local database and proves
# the three SQL-level claims 0483 makes, RED-then-GREEN in one run:
#
#   1. 0467's `deduct_ai_credits` has NO lock_timeout, so a contended
#      `SELECT … FOR UPDATE` blocks until statement_timeout (SQLSTATE 57014).
#      After 0483 the same call aborts with 55P03 (lock_not_available) inside
#      the 5 s budget. No debit is recorded in either case — it fails CLOSED.
#   2. The four credit RPCs are service_role-only: anon and authenticated hold
#      no EXECUTE after the full replay (0467 → 0468 → 0483).
#   3. Concurrent debits conserve credits: N racers against an allocation of M
#      produce exactly M successes and used_this_month = M.
#
# Plus two characterization assertions that document current behaviour rather
# than assert a fix: `NOTIFY pgrst, 'reload schema'` really is delivered by
# 0483, and 0467's `p_amount <= 0` guard makes every REFUND call return false
# (see the "NOT changed here" note in 0483's header).
#
# Local PostgreSQL only. Creates and drops its own scratch database; never
# touches an existing one.
set -euo pipefail

PG_BIN="${SCRUM4939_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PSQL="$PG_BIN/psql"
CREATEDB="$PG_BIN/createdb"
DROPDB="$PG_BIN/dropdb"
[[ -x "$PSQL" ]] || { PSQL="$(command -v psql)"; CREATEDB="$(command -v createdb)"; DROPDB="$(command -v dropdb)"; }
export PGHOST="${PGHOST:-127.0.0.1}"
case "$PGHOST" in 127.0.0.1|localhost|::1|/tmp|/var/run/postgresql) ;; *) echo 'Native test requires local PostgreSQL' >&2; exit 2 ;; esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"

DB="arkova_scrum4939_0483_${$}_${RANDOM}"
WORK="$(mktemp -d)"
$CREATEDB "$DB"
trap '$DROPDB --if-exists "$DB" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "  ok — $*"; }
q()    { $PSQL -At -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }

# ---------------------------------------------------------------------------
# Minimal Supabase-shaped fixture: the roles, the auth shim and only the tables
# the three migrations touch.
# ---------------------------------------------------------------------------
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<'SQL' >/dev/null
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
  AS $fn$ SELECT coalesce(current_setting('request.jwt.claim.role', true), current_user::text) $fn$;

CREATE TABLE public.ai_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  user_id uuid,
  monthly_allocation integer NOT NULL DEFAULT 0,
  used_this_month integer NOT NULL DEFAULT 0,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- allocate_monthly_credits()'s working set (0468). Only its ACL is asserted
-- here, but the tables keep the replay honest.
CREATE TABLE public.plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, plan_id uuid, status text);
CREATE TABLE public.credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  balance integer NOT NULL DEFAULT 0, purchased integer NOT NULL DEFAULT 0,
  monthly_allocation integer NOT NULL DEFAULT 0,
  cycle_start timestamptz, cycle_end timestamptz, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  transaction_type text, amount integer, balance_after integer, reason text
);
SQL

# Both pre-0483 migrations, exactly as merged.
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$MIG/0467_scrum4939_atomic_ai_credit_periods.sql" >/dev/null
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$MIG/0468_allocate_monthly_credits_singleton.sql" >/dev/null

ORG_LOCK=11111111-1111-4111-8111-111111111111
ORG_RACE=22222222-2222-4222-8222-222222222222
ORG_REFUND=33333333-3333-4333-8333-333333333333

$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO public.ai_credits(org_id,monthly_allocation,used_this_month,period_start,period_end) VALUES
 ('$ORG_LOCK',  100, 0, date_trunc('month',now()), date_trunc('month',now())+interval '1 month'),
 ('$ORG_RACE',    5, 0, date_trunc('month',now()), date_trunc('month',now())+interval '1 month'),
 ('$ORG_REFUND', 10, 4, date_trunc('month',now()), date_trunc('month',now())+interval '1 month');
SQL

# ---------------------------------------------------------------------------
# Helper: hold a real row lock on the org's ai_credits row, then probe.
# Echoes "<sqlstate|ok> <elapsed_seconds>".
#
# The SQLSTATE is read from psql's verbose error line rather than from a
# plpgsql EXCEPTION handler: `statement_timeout` raises query_canceled, which
# plpgsql deliberately does NOT let `WHEN OTHERS` swallow, so a handler-based
# probe cannot observe the pre-0483 case at all.
# ---------------------------------------------------------------------------
probe_under_lock() {
  local org="$1" holder_tag="holder_${RANDOM}"
  (
    PGAPPNAME="$holder_tag" $PSQL -At -v ON_ERROR_STOP=1 -d "$DB" \
      -c "BEGIN; SELECT id FROM public.ai_credits WHERE org_id='$org' FOR UPDATE; SELECT pg_sleep(20); COMMIT;" >/dev/null 2>&1
  ) & local holder_pid=$!
  local i
  for i in $(seq 1 100); do
    [[ "$(q "SELECT count(*) FROM pg_stat_activity WHERE application_name='$holder_tag' AND wait_event='PgSleep';")" == 1 ]] && break
    sleep 0.05
  done
  [[ "$(q "SELECT count(*) FROM pg_stat_activity WHERE application_name='$holder_tag' AND wait_event='PgSleep';")" == 1 ]] \
    || { kill "$holder_pid" 2>/dev/null || true; wait "$holder_pid" 2>/dev/null || true; fail "lock holder never acquired the row"; }

  local start end raw result
  start="$(date +%s)"
  raw="$($PSQL -At -q -d "$DB" <<PROBE 2>&1 || true
\set VERBOSITY verbose
SET statement_timeout='12s';
SELECT public.deduct_ai_credits('$org', NULL, 1);
PROBE
)"
  end="$(date +%s)"
  kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true

  result="$(grep -oE '^(psql:)?.*ERROR:  [0-9A-Z]{5}' <<<"$raw" | grep -oE '[0-9A-Z]{5}$' | head -1 || true)"
  if [[ -z "$result" ]]; then
    result="returned:$(grep -oE '^[tf]$' <<<"$raw" | head -1)"
  fi
  echo "$result $((end - start))"
}

echo "== RED: 0467 + 0468 only (no 0483) =="

proconfig_before="$(q "SELECT coalesce(array_to_string(proconfig,','),'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='deduct_ai_credits';")"
echo "  deduct_ai_credits proconfig = [$proconfig_before]"
[[ "$proconfig_before" == *"lock_timeout"* ]] && fail "0467 already sets lock_timeout — premise of this test is wrong"
ok "0467's deduct_ai_credits has NO lock_timeout (finding 2 reproduced)"

ensure_proconfig="$(q "SELECT coalesce(array_to_string(proconfig,','),'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ensure_ai_credits_period';")"
[[ "$ensure_proconfig" == *"lock_timeout=5s"* ]] \
  || fail "ensure_ai_credits_period should carry lock_timeout=5s in 0467; got [$ensure_proconfig]"
ok "the sibling ensure_ai_credits_period DOES set lock_timeout=5s — the asymmetry is real"

read -r before_state before_secs <<<"$(probe_under_lock "$ORG_LOCK")"
echo "  contended debit => SQLSTATE=$before_state after ${before_secs}s"
[[ "$before_state" == "57014" ]] \
  || fail "expected a statement_timeout (57014) before 0483; got $before_state"
[[ "$before_secs" -ge 10 ]] \
  || fail "expected the pre-0483 debit to block for the full statement_timeout; took ${before_secs}s"
ok "pre-0483 the debit blocks ~12s to statement_timeout instead of failing fast"

[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_LOCK';")" == 0 ]] \
  || fail "a timed-out debit must not record a charge"
ok "no debit recorded on the timed-out call (fails CLOSED either way)"

echo
echo "== apply 0483 =="
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$MIG/0483_scrum4939_credit_rpc_followups.sql" >/dev/null
ok "0483 applied"

echo
echo "== GREEN: after 0483 =="

proconfig_after="$(q "SELECT array_to_string(proconfig,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='deduct_ai_credits';")"
echo "  deduct_ai_credits proconfig = [$proconfig_after]"
[[ "$proconfig_after" == *"lock_timeout=5s"* ]] || fail "0483 must set lock_timeout=5s; got [$proconfig_after]"
[[ "$proconfig_after" == *"search_path=public"* ]] || fail "SECURITY DEFINER must keep search_path=public; got [$proconfig_after]"
ok "proconfig now has lock_timeout=5s AND search_path=public"

[[ "$(q "SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='deduct_ai_credits';")" == "t" ]] \
  || fail "deduct_ai_credits must stay SECURITY DEFINER"
ok "still SECURITY DEFINER"

read -r after_state after_secs <<<"$(probe_under_lock "$ORG_LOCK")"
echo "  contended debit => SQLSTATE=$after_state after ${after_secs}s"
[[ "$after_state" == "55P03" ]] || fail "expected lock_not_available (55P03) after 0483; got $after_state"
[[ "$after_secs" -le 9 ]] || fail "expected the 5s lock budget to fire well before statement_timeout; took ${after_secs}s"
ok "contended debit aborts with 55P03 inside the 5s budget"

[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_LOCK';")" == 0 ]] \
  || fail "a lock-timed-out debit must not record a charge"
ok "still no debit recorded — 55P03 fails CLOSED, no hollow success"

# --- grants -----------------------------------------------------------------
for fn in "deduct_ai_credits(uuid,uuid,integer)" "ensure_ai_credits_period(uuid,integer,timestamptz)" "check_ai_credits(uuid,uuid)" "allocate_monthly_credits()"; do
  acl="$(q "SELECT has_function_privilege('anon','public.$fn','EXECUTE')::text||' '||has_function_privilege('authenticated','public.$fn','EXECUTE')::text||' '||has_function_privilege('service_role','public.$fn','EXECUTE')::text;")"
  [[ "$acl" == "false false true" ]] || fail "public.$fn ACL is [$acl], expected [false false true] (anon authenticated service_role)"
  ok "public.$fn — anon:no authenticated:no service_role:yes"
done

# --- concurrent conservation -------------------------------------------------
for i in $(seq 1 8); do
  ( $PSQL -At -d "$DB" -c "SELECT public.deduct_ai_credits('$ORG_RACE',NULL,1);" >"$WORK/race-$i.out" 2>/dev/null ) &
done
wait
wins="$(cat "$WORK"/race-*.out | grep -c '^t$' || true)"
used="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_RACE';")"
rows="$(q "SELECT count(*) FROM public.ai_credits WHERE org_id='$ORG_RACE';")"
echo "  8 concurrent debits against an allocation of 5 => $wins successes, used_this_month=$used, rows=$rows"
[[ "$wins" == 5 && "$used" == 5 && "$rows" == 1 ]] \
  || fail "credit conservation broken: wins=$wins used=$used rows=$rows (expected 5/5/1)"
ok "concurrent debits conserve credits exactly (no over-debit, no free credit)"

# --- NOTIFY is really delivered ---------------------------------------------
cat >"$WORK/notify.sql" <<SQL
LISTEN pgrst;
\i $MIG/0483_scrum4939_credit_rpc_followups.sql
SELECT 1;
SQL
notify_out="$($PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$WORK/notify.sql" 2>&1)"
grep -q 'Asynchronous notification "pgrst" .*received' <<<"$notify_out" \
  || fail "0483 did not deliver NOTIFY pgrst (finding 1 fix missing). psql said: $notify_out"
ok "NOTIFY pgrst, 'reload schema' is delivered on COMMIT (and 0483 re-applies cleanly — idempotent)"

# --- characterization: the refund regression 0483 deliberately does NOT fix ---
refund="$(q "SELECT public.deduct_ai_credits('$ORG_REFUND',NULL,-1);")"
refund_used="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")"
[[ "$refund" == "f" && "$refund_used" == 4 ]] \
  || fail "unexpected refund behaviour: returned '$refund', used_this_month=$refund_used"
ok "CHARACTERIZATION — a refund (p_amount=-1) returns false and refunds nothing under 0467's guard; unchanged by 0483, reported separately"

echo
echo "PASS — scripts/scrum4939/native-pg-credit-rpc-followups.sh"
