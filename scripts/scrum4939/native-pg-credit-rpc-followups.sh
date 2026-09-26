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
#   4. The AI-credit refund regression from 0467: a refund issued the old way
#      (`deduct_ai_credits` with -1) returns false and changes nothing, and
#      `refund_ai_credits` does not exist. After 0484 the dedicated RPC
#      decrements by exactly the amount, floors at zero, is service_role-only,
#      aborts with 55P03 under contention, and interleaves with debits so that
#      used_this_month == debits - refunds >= 0.
#
# Plus one characterization assertion: `NOTIFY pgrst, 'reload schema'` really is
# delivered by 0483.
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
# `--force` (PG13+) terminates the backends still attached before dropping.
# Without it, every contended run of this harness LEAKED its scratch database:
# the concurrency sections fork psql sessions, and a `dropdb` racing a backend
# that has not finished disconnecting fails with 55006 (objects_in_use) — which
# the `|| true` then swallowed, leaving `arkova_scrum4939_0483_*` behind for
# good. Five had accumulated on the dev host by 2026-09-21. The terminate is
# belt-and-braces for a server too old for `--force`.
cleanup_db() {
  $PSQL -At -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid <> pg_backend_pid();" \
    >/dev/null 2>&1 || true
  $DROPDB --force --if-exists "$DB" >/dev/null 2>&1 \
    || $DROPDB --if-exists "$DB" >/dev/null 2>&1 \
    || echo "WARN: scratch database $DB could not be dropped — drop it by hand" >&2
  rm -rf "$WORK"
}
trap cleanup_db EXIT

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
-- Faithful to the baseline definition's first branch: the legacy PostgREST GUC,
-- returning NULL when claims are absent. 0484's guard must fail CLOSED on that
-- NULL, which is exactly what this harness exercises below.
CREATE FUNCTION public.get_caller_role() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public' AS $fn$
DECLARE role_val text;
BEGIN
  role_val := current_setting('request.jwt.claim.role', true);
  IF role_val IS NOT NULL AND role_val != '' THEN RETURN role_val; END IF;
  RETURN NULL;
END $fn$;

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
ORG_FLOOR=44444444-4444-4444-8444-444444444444
ORG_MIX=55555555-5555-4555-8555-555555555555
# 0485 only.
ORG_CLAMP=66666666-6666-4666-8666-666666666666
ORG_ROLL=77777777-7777-4777-8777-777777777777

$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO public.ai_credits(org_id,monthly_allocation,used_this_month,period_start,period_end) VALUES
 ('$ORG_LOCK',  100, 0, date_trunc('month',now()), date_trunc('month',now())+interval '1 month'),
 ('$ORG_RACE',    5, 0, date_trunc('month',now()), date_trunc('month',now())+interval '1 month'),
 ('$ORG_REFUND', 10, 4, date_trunc('month',now()), date_trunc('month',now())+interval '1 month'),
 ('$ORG_FLOOR',  10, 2, date_trunc('month',now()), date_trunc('month',now())+interval '1 month'),
 ('$ORG_MIX',    50, 0, date_trunc('month',now()), date_trunc('month',now())+interval '1 month'),
 ('$ORG_CLAMP', 10, 2, date_trunc('month',now()), date_trunc('month',now())+interval '1 month'),
 -- The rollover pair: one EXPIRED period carrying the debit, one CURRENT
 -- period the refund would land in if it were scoped by now(). 0467's
 -- exclusion constraint permits both because [a,b) and [b,c) do not overlap.
 ('$ORG_ROLL',  10, 7, date_trunc('month',now())-interval '1 month', date_trunc('month',now())),
 ('$ORG_ROLL',  10, 3, date_trunc('month',now()), date_trunc('month',now())+interval '1 month');
SQL

# Every call the worker makes arrives through PostgREST as service_role, which
# sets the request.jwt.claim.role GUC. `svc` reproduces that; `anonq` does not,
# so it is what an absent-claims caller looks like to 0484's guard.
svc()   { $PSQL -At -v ON_ERROR_STOP=1 -d "$DB" -c "SELECT set_config('request.jwt.claim.role','service_role',false); $1" | tail -1; }

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
  local org="$1" op="${2:-deduct}" holder_tag="holder_${RANDOM}"
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
SELECT set_config('request.jwt.claim.role','service_role',false);
SET statement_timeout='12s';
SELECT public.${op}_ai_credits('$org', NULL, 1);
PROBE
)"
  end="$(date +%s)"
  # Killing the psql CLIENT does not release the lock: the backend is inside
  # `pg_sleep(20)` and does not notice the disconnect until the sleep ends, so
  # the row stayed locked for the remainder of that budget and whatever ran
  # next against the same org failed with a spurious 55P03. Terminate the
  # BACKEND, then wait for it to actually leave pg_stat_activity.
  $PSQL -At -d "$DB" -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='$holder_tag';" \
    >/dev/null 2>&1 || true
  kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  for i in $(seq 1 100); do
    [[ "$(q "SELECT count(*) FROM pg_stat_activity WHERE application_name='$holder_tag';")" == 0 ]] && break
    sleep 0.05
  done

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

# --- the refund regression, before the fix ----------------------------------
[[ "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refund_ai_credits';")" == 0 ]] \
  || fail "refund_ai_credits already exists before 0484 — premise of this test is wrong"
ok "no refund_ai_credits RPC exists yet"

red_refund="$(q "SELECT public.deduct_ai_credits('$ORG_REFUND',NULL,-1);")"
red_used="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")"
[[ "$red_refund" == "f" && "$red_used" == 4 ]] \
  || fail "expected the old refund path to no-op; returned '$red_refund', used=$red_used"
ok "the old refund path (deduct with -1) returns false and refunds NOTHING — regression reproduced"

echo
echo "== apply 0483 + 0484 =="
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$MIG/0483_scrum4939_credit_rpc_followups.sql" >/dev/null
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$MIG/0484_scrum4939_refund_ai_credits.sql" >/dev/null
ok "0483 + 0484 applied"

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
for fn in "deduct_ai_credits(uuid,uuid,integer)" "refund_ai_credits(uuid,uuid,integer)" "ensure_ai_credits_period(uuid,integer,timestamptz)" "check_ai_credits(uuid,uuid)" "allocate_monthly_credits()"; do
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

# --- GREEN: the dedicated refund RPC ----------------------------------------
refund_proconfig="$(q "SELECT array_to_string(proconfig,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refund_ai_credits';")"
[[ "$refund_proconfig" == *"lock_timeout=5s"* && "$refund_proconfig" == *"search_path=public"* ]] \
  || fail "refund_ai_credits proconfig is [$refund_proconfig]"
[[ "$(q "SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refund_ai_credits';")" == "t" ]] \
  || fail "refund_ai_credits must be SECURITY DEFINER"
ok "refund_ai_credits: SECURITY DEFINER, search_path=public, lock_timeout=5s"

# The in-body guard must fail CLOSED when request claims are absent, i.e. when
# get_caller_role() returns NULL. A bare `<> 'service_role'` would fall through.
noclaims="$($PSQL -At -q -d "$DB" -c "SELECT public.refund_ai_credits('$ORG_REFUND',NULL,1);" 2>&1 || true)"
grep -q 'Only service_role can refund AI credits' <<<"$noclaims" \
  || fail "refund with absent role claims must RAISE insufficient_privilege; got: $noclaims"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")" == 4 ]] \
  || fail "a refused refund must not move credit"
ok "absent role claims => insufficient_privilege, nothing refunded (NULL fails CLOSED)"

[[ "$(svc "SELECT public.refund_ai_credits('$ORG_REFUND',NULL,1);")" == "t" ]] || fail "service_role refund should succeed"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")" == 3 ]] \
  || fail "refund of 1 should take used_this_month 4 -> 3"
ok "refund of 1 decrements used_this_month by exactly 1 (4 -> 3)"

# Bounds: <=0, over the 1000 cap, and both-ids-NULL are refused without moving credit.
for bad in "0" "-5" "1001"; do
  [[ "$(svc "SELECT public.refund_ai_credits('$ORG_REFUND',NULL,$bad);")" == "f" ]] \
    || fail "refund with p_amount=$bad must return false"
done
[[ "$(svc "SELECT public.refund_ai_credits(NULL,NULL,1);")" == "f" ]] || fail "refund with no org and no user must return false"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")" == 3 ]] \
  || fail "a refused refund must not move credit"
ok "p_amount <=0 / >1000 and both-ids-NULL are refused, credit unmoved"

# Floor: used=2, refund 7 -> 0, never negative. A second refund at 0 stays 0.
[[ "$(svc "SELECT public.refund_ai_credits('$ORG_FLOOR',NULL,7);")" == "t" ]] || fail "over-refund should still report a credited row"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_FLOOR';")" == 0 ]] \
  || fail "refund larger than used must floor at 0"
[[ "$(svc "SELECT public.refund_ai_credits('$ORG_FLOOR',NULL,1);")" == "t" ]] || fail "refund at used=0 should still report a row"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_FLOOR';")" == 0 ]] \
  || fail "refund at used=0 must stay 0 — a refund can never mint credit"
ok "GREATEST floor holds: over-refund lands on 0, refund at 0 stays 0 (double refund cannot mint)"

# No covering period row -> false, nothing to refund.
[[ "$(svc "SELECT public.refund_ai_credits('99999999-9999-4999-8999-999999999999',NULL,1);")" == "f" ]] \
  || fail "refund for an org with no period row must return false"
ok "no covering period row => false"

# Contended refund aborts with 55P03 inside the 5s budget and changes nothing.
read -r refund_state refund_secs <<<"$(probe_under_lock "$ORG_REFUND" refund)"
echo "  contended refund => SQLSTATE=$refund_state after ${refund_secs}s"
[[ "$refund_state" == "55P03" ]] || fail "expected 55P03 on a contended refund; got $refund_state"
[[ "$refund_secs" -le 9 ]] || fail "refund lock budget did not fire inside 5s; took ${refund_secs}s"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")" == 3 ]] \
  || fail "a lock-timed-out refund must not move credit"
ok "contended refund aborts with 55P03 in ~5s and refunds nothing"

# Interleaved debits and refunds across 8 sessions must conserve:
# used_this_month == debits_applied - refunds_applied, and never go negative.
for i in $(seq 1 5); do
  ( svc "SELECT public.deduct_ai_credits('$ORG_MIX',NULL,1);" >"$WORK/mix-d-$i.out" 2>/dev/null ) &
done
for i in $(seq 1 3); do
  ( svc "SELECT public.refund_ai_credits('$ORG_MIX',NULL,1);" >"$WORK/mix-r-$i.out" 2>/dev/null ) &
done
wait
mix_d="$(cat "$WORK"/mix-d-*.out | grep -c '^t$' || true)"
mix_r="$(cat "$WORK"/mix-r-*.out | grep -c '^t$' || true)"
mix_used="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_MIX';")"
echo "  8 interleaved sessions => $mix_d debits applied, $mix_r refunds applied, used_this_month=$mix_used"
[[ "$mix_d" == 5 && "$mix_r" == 3 ]] || fail "expected all 5 debits and all 3 refunds to apply; got $mix_d/$mix_r"
[[ "$mix_used" -ge 0 ]] || fail "used_this_month went negative: $mix_used"
[[ "$mix_used" == "$((mix_d - mix_r))" ]] \
  || fail "conservation broken: used=$mix_used, expected debits-refunds=$((mix_d - mix_r))"
ok "interleaved debits/refunds conserve exactly (used = debits - refunds, never negative)"

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

# --- the debit RPC stays closed to negative amounts --------------------------
[[ "$(svc "SELECT public.deduct_ai_credits('$ORG_REFUND',NULL,-1);")" == "f" ]] \
  || fail "deduct_ai_credits must stay closed to negative amounts"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")" == 3 ]] \
  || fail "a negative deduct must not move credit"
ok "deduct_ai_credits still refuses negative amounts (0467's guard kept; refunds have their own RPC)"

# ===========================================================================
# 0485 — S1 (how much came back) and S2 (which period it came back to)
# ===========================================================================
echo
echo "== RED: 0484's refund cannot report a clamped no-op, and ignores the debit's period =="

# S1 RED. ORG_FLOOR is already at used=0 from the floor test above. 0484 answers
# `true` for a refund that moved NOTHING, so the caller logs "reconciled".
[[ "$(svc "SELECT public.refund_ai_credits('$ORG_FLOOR',NULL,1);")" == "t" ]] \
  || fail "premise wrong: 0484 should answer true for a fully-clamped refund"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_FLOOR';")" == 0 ]] \
  || fail "the clamped refund must not have moved credit"
ok "0484 answers TRUE for a refund that returned zero credits — S1 reproduced"

# S2 RED. The debit sits in the EXPIRED period (used=7); 0484 has no way to be
# told that, so its now()-scoped lookup decrements the CURRENT period instead.
[[ "$(svc "SELECT public.refund_ai_credits('$ORG_ROLL',NULL,1);")" == "t" ]] \
  || fail "premise wrong: 0484 should refund ORG_ROLL against its current period"
roll_expired_red="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_ROLL' AND period_end<=now();")"
roll_current_red="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_ROLL' AND period_end>now();")"
[[ "$roll_expired_red" == 7 && "$roll_current_red" == 2 ]] \
  || fail "expected 0484 to hit the CURRENT period (7/2); got expired=$roll_expired_red current=$roll_current_red"
ok "0484 refunds a last-month debit against THIS month's period (7 -> stays 7, 3 -> 2) — S2 reproduced"

# Put ORG_ROLL back so the 0485 assertions start from the documented fixture.
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c \
  "UPDATE public.ai_credits SET used_this_month=3 WHERE org_id='$ORG_ROLL' AND period_end>now();" >/dev/null

echo
echo "== apply 0485 =="
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$MIG/0485_scrum4939_refund_ai_credits_period_and_amount.sql" >/dev/null
ok "0485 applied"

echo
echo "== GREEN: after 0485 =="

# The 3-argument boolean function is GONE, not shadowed by an ambiguous overload.
[[ "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refund_ai_credits';")" == 1 ]] \
  || fail "exactly one refund_ai_credits must exist after 0485 (no defaulted-arg overload)"
sig="$(q "SELECT pg_get_function_identity_arguments(p.oid)||' -> '||pg_get_function_result(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refund_ai_credits';")"
[[ "$sig" == "p_org_id uuid, p_user_id uuid, p_amount integer, p_debited_at timestamp with time zone -> integer" ]] \
  || fail "unexpected 0485 signature: [$sig]"
ok "signature is (uuid,uuid,integer,timestamptz) -> integer"

refund485_proconfig="$(q "SELECT array_to_string(proconfig,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refund_ai_credits';")"
[[ "$refund485_proconfig" == *"lock_timeout=5s"* && "$refund485_proconfig" == *"search_path=public"* ]] \
  || fail "0485 refund_ai_credits proconfig is [$refund485_proconfig]"
[[ "$(q "SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refund_ai_credits';")" == "t" ]] \
  || fail "0485 refund_ai_credits must stay SECURITY DEFINER"
ok "still SECURITY DEFINER, search_path=public, lock_timeout=5s"

# The DROP took the old ACL with it; the GRANT/REVOKE must be re-issued AFTER
# the CREATE or anon/authenticated inherit EXECUTE from ALTER DEFAULT PRIVILEGES.
acl485="$(q "SELECT has_function_privilege('anon','public.refund_ai_credits(uuid,uuid,integer,timestamptz)','EXECUTE')::text||' '||has_function_privilege('authenticated','public.refund_ai_credits(uuid,uuid,integer,timestamptz)','EXECUTE')::text||' '||has_function_privilege('service_role','public.refund_ai_credits(uuid,uuid,integer,timestamptz)','EXECUTE')::text;")"
[[ "$acl485" == "false false true" ]] || fail "0485 ACL is [$acl485], expected [false false true]"
ok "ACL re-issued after the CREATE — anon:no authenticated:no service_role:yes"

# Absent role claims still fail CLOSED (get_caller_role() -> NULL).
noclaims485="$($PSQL -At -q -d "$DB" -c "SELECT public.refund_ai_credits('$ORG_REFUND',NULL,1);" 2>&1 || true)"
grep -q 'Only service_role can refund AI credits' <<<"$noclaims485" \
  || fail "0485 refund with absent role claims must RAISE; got: $noclaims485"
ok "absent role claims => insufficient_privilege (NULL still fails CLOSED)"

# --- S1: the return value now says how much actually came back --------------
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_CLAMP';")" == 2 ]] \
  || fail "ORG_CLAMP fixture should start at used=2"
[[ "$(svc "SELECT public.refund_ai_credits('$ORG_CLAMP',NULL,5);")" == 2 ]] \
  || fail "a refund of 5 against used=2 must report 2 credits returned"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_CLAMP';")" == 0 ]] \
  || fail "the partial refund must land the period on 0"
ok "over-refund returns the amount ACTUALLY returned (2 of 5), period floors at 0"

[[ "$(svc "SELECT public.refund_ai_credits('$ORG_CLAMP',NULL,1);")" == 0 ]] \
  || fail "a fully-clamped refund must return 0, not a success value"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_CLAMP';")" == 0 ]] \
  || fail "a clamped refund must not move credit"
ok "clamped refund returns 0 — S1 fixed (0484 answered true for this)"

[[ "$(svc "SELECT public.refund_ai_credits('$ORG_REFUND',NULL,1);")" == 1 ]] \
  || fail "an ordinary refund of 1 must return 1"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")" == 2 ]] \
  || fail "ordinary refund should take used_this_month 3 -> 2"
ok "ordinary refund of 1 returns 1 and decrements by exactly 1 (3 -> 2)"

# NULL — nothing attempted — is distinct from 0 — attempted, moved nothing.
for bad in "0" "-5" "1001"; do
  [[ -z "$(svc "SELECT public.refund_ai_credits('$ORG_REFUND',NULL,$bad);")" ]] \
    || fail "refund with p_amount=$bad must return NULL"
done
[[ -z "$(svc "SELECT public.refund_ai_credits(NULL,NULL,1);")" ]] \
  || fail "refund with no org and no user must return NULL"
[[ -z "$(svc "SELECT public.refund_ai_credits('99999999-9999-4999-8999-999999999999',NULL,1);")" ]] \
  || fail "refund for an org with no covering period row must return NULL"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")" == 2 ]] \
  || fail "a refused refund must not move credit"
ok "invalid args and no-covering-row return NULL (distinct from a clamped 0), credit unmoved"

# --- S2: the period is the DEBIT's, not the refund's ------------------------
last_month="$(q "SELECT (date_trunc('month',now())-interval '10 days')::text;")"
[[ "$(svc "SELECT public.refund_ai_credits('$ORG_ROLL',NULL,1,timestamptz '$last_month');")" == 1 ]] \
  || fail "a refund carrying p_debited_at must land on the expired period and return 1"
roll_expired="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_ROLL' AND period_end<=now();")"
roll_current="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_ROLL' AND period_end>now();")"
[[ "$roll_expired" == 6 && "$roll_current" == 3 ]] \
  || fail "expected expired 7->6 and current untouched at 3; got expired=$roll_expired current=$roll_current"
ok "p_debited_at in the EXPIRED period decrements that row (7 -> 6) and leaves the current one at 3 — S2 fixed"

[[ "$(svc "SELECT public.refund_ai_credits('$ORG_ROLL',NULL,1);")" == 1 ]] \
  || fail "a refund without p_debited_at must still work"
roll_expired2="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_ROLL' AND period_end<=now();")"
roll_current2="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_ROLL' AND period_end>now();")"
[[ "$roll_expired2" == 6 && "$roll_current2" == 2 ]] \
  || fail "expected the now()-scoped refund to hit the current period (6/2); got expired=$roll_expired2 current=$roll_current2"
ok "omitting p_debited_at behaves exactly as 0484 did (current period, 3 -> 2) — already-enqueued jobs keep working"

# A contended refund still aborts inside the 5 s budget with nothing moved.
read -r refund485_state refund485_secs <<<"$(probe_under_lock "$ORG_REFUND" refund)"
echo "  contended 0485 refund => SQLSTATE=$refund485_state after ${refund485_secs}s"
[[ "$refund485_state" == "55P03" ]] || fail "expected 55P03 on a contended 0485 refund; got $refund485_state"
[[ "$refund485_secs" -le 9 ]] || fail "0485 refund lock budget did not fire inside 5s; took ${refund485_secs}s"
[[ "$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_REFUND';")" == 2 ]] \
  || fail "a lock-timed-out 0485 refund must not move credit"
ok "contended refund still aborts with 55P03 in ~5s and refunds nothing"

# Conservation across interleaved debits and refunds, on the new signature.
for i in $(seq 1 5); do
  ( svc "SELECT public.deduct_ai_credits('$ORG_MIX',NULL,1);" >"$WORK/mix485-d-$i.out" 2>/dev/null ) &
done
for i in $(seq 1 3); do
  ( svc "SELECT public.refund_ai_credits('$ORG_MIX',NULL,1);" >"$WORK/mix485-r-$i.out" 2>/dev/null ) &
done
wait
mix485_before=2  # used_this_month left by the 0484 section above (5 debits - 3 refunds)
mix485_d="$(cat "$WORK"/mix485-d-*.out | grep -c '^t$' || true)"
mix485_r="$(awk '{s+=$1} END {print s+0}' "$WORK"/mix485-r-*.out)"
mix485_used="$(q "SELECT used_this_month FROM public.ai_credits WHERE org_id='$ORG_MIX';")"
echo "  8 interleaved sessions on 0485 => $mix485_d debits applied, $mix485_r credits returned, used_this_month=$mix485_used"
[[ "$mix485_used" -ge 0 ]] || fail "used_this_month went negative: $mix485_used"
[[ "$mix485_used" == "$((mix485_before + mix485_d - mix485_r))" ]] \
  || fail "conservation broken: used=$mix485_used, expected $mix485_before + $mix485_d - $mix485_r"
ok "interleaved debits/refunds conserve exactly on the integer signature (sum of returned amounts, never negative)"

echo
echo "PASS — scripts/scrum4939/native-pg-credit-rpc-followups.sh"
