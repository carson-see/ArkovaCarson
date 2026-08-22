#!/usr/bin/env bash
# scripts/staging/fullsoak-cron-exerciser.sh
#
# Daily CRON ROUTE EXERCISER for the 2026-08 7-day full-functionality soak.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
# `cron.ts` declares 110 routes. Cloud Scheduler binds 26 fullsoak jobs covering
# 25 distinct routes. The other 85 are DECLARED-UNTESTED — the single largest
# coverage gap in the soak (founder-coverage-checklist.md item 1, finding FD-13).
# "Untested" is not a synonym for "fine": FD-2 (`check-credential-expiry` 500s on
# every run in prod because it selects `anchors.not_after` / `anchors.document_
# title`, neither of which exists) was found by *invoking the route*, not by
# reading it. This script invokes the rest of them.
#
# It complements, and does not replace:
#   fullsoak-daily-check.sh   A1-A19  parity / integrity (has the rig DRIFTED?)
#   fullsoak-daily-probes.sh  P1-P10  product behaviour  (does the FEATURE work?)
#   fullsoak-cron-exerciser.sh        cron reachability   (does the JOB run?)
#
# ── CONSTITUTIONAL LIMITS (CLAUDE.md §1.11A, runbook §5.0) ───────────────────
# 1. Traffic only. Every invocation is an authenticated HTTP POST/GET to the rig
#    over the same path Cloud Scheduler uses. No service-role write, no direct
#    DML, no env/flag/secret/scheduler/revision/traffic change. Nothing here can
#    restart the worker, so nothing here can void the soak clock.
# 2. Reads may use the Supabase Management read path (a SELECT is not a write);
#    used only for guard preconditions and before/after row deltas.
# 3. The route set is computed LIVE from the rig's frozen git SHA and the live
#    Scheduler census. Nothing is hardcoded, so the unbound set cannot go stale.
# 4. FAIL CLOSED. A route present in cron.ts but absent from the policy table
#    below is DENIED (`unclassified`), never invoked. Adding a route to cron.ts
#    can therefore never cause this script to fire something nobody reviewed.
# 5. A 5xx is a FINDING, recorded and continued past — never a script failure.
#    An auth failure (401 on every route) IS a script failure and aborts.
#
# ── THE DENYLIST, AND WHY EACH ENTRY IS ON IT ────────────────────────────────
# Every DENY carries a code. Codes, not adjectives, so the list is auditable:
#
#  D1  EXTERNAL-REGISTRY INGESTION (42 routes). Each writes `public_records`.
#      `/jobs/anchor-public-records` IS Scheduler-bound on this rig (*/10) and
#      converts unlinked public_records rows into PENDING anchors. Fetching even
#      one page therefore mutates the controlled anchor cohort that BL-2's
#      evidence rests on (12 anchors / 12 proofs, 80 raw header bytes each) and
#      the Day-7 offline proof verification depends on. Secondary reasons: each
#      hits a live third-party registry from a soak rig, and this family is where
#      the 259k pending-anchoring backlog came from (prod's feeders are PAUSED).
#      Day-0 probe #26 declined them for the same reason. See RECONSIDER below.
#
#      *** D1 IS NOW COVERED ELSEWHERE — 2026-08-13. *** All 42 D1 routes were
#      force-run on the CONNECTOR SIDE-RIG (arkova-worker-connector-sidecar-
#      2026-08-staging / Supabase ehqqearcitrgloibtjqx), which runs the SAME
#      image digest but has NO Scheduler binding at all — so the anchor-public-
#      records cascade that motivates this DENY cannot happen there. 26,100
#      public_records were ingested across 15 registries with ZERO rows linked to
#      an anchor. Evidence + per-route root causes:
#        docs/staging/fullsoak-2026-08/side-rig-cron-coverage.md
#      The DENY below is STILL CORRECT for THIS frozen rig and must not be
#      relaxed: the cohort objection is specific to the Scheduler-bound rig, and
#      the frozen rig stayed at 12 anchors / 12 proofs / 0 public_records
#      throughout that exercise. Do not "re-enable" D1 here.
#  D2  RETENTION / PURGE. Deletes rows the soak is measuring.
#  D3  MAINNET. The rig must never touch mainnet (BTC9, checklist item 2).
#  D4  REAL BTC SPEND / RE-ANCHOR BACKFILL across the 2.97M backlog.
#  D5  WRITES `anchor_proofs` when armed — the table BL-2's evidence counts.
#      Its inertness depends on an env var whose value I will not verify by
#      experiment on a live soak.
#  D6  Persists a durable `job_queue` census checkpoint and advances a cursor
#      EVEN IN DRY-RUN (see the route's own header comment). That is queue state
#      the soak measures.
#  D7  Unbounded full-table export backfill; requires an explicit ?table= param.
#  D8  UPDATEs the seeded `org_integrations` google_drive row (failure counter,
#      last_renewal_error; on a successful renewal it ROTATES `channel_token`).
#      That row's channel token is the exact credential daily probe P9b addresses
#      when it proves a forged Drive channel token is rejected. Renewing it would
#      quietly invalidate another instrument's evidence.
#
#  *** D2 / D5 / D6 / D7 / D8 ARE NOW COVERED ELSEWHERE — 2026-08-13. *** Each was
#  force-run once on the connector side-rig (same image digest, disposable DB) and
#  all five returned 2xx: D5 in ARMED write mode inserted 9 anchor_proofs rows,
#  D6's dry-run checkpoint claim was empirically confirmed (job_queue +1 with zero
#  writes applied), D7 succeeded when bounded with ?table=audit_events, D8 was
#  inert there (no google_drive row to rotate), D2 deleted 0 rows. The two GUARD
#  routes whose preconditions fail on this rig (G2 report-metered-usage, G4
#  queue-reminders) were also run there. D3 and D4 remain DENIED EVERYWHERE and
#  were never invoked on any rig. Same evidence doc as D1 above. These DENY codes
#  remain correct for THIS frozen rig — do not relax them here.
#
# GUARDED routes (Gn) are neither allow nor deny standing: a read-only
# precondition is evaluated live each run, and the route is invoked ONLY if that
# precondition proves the run is inert. If the precondition cannot be read, the
# route is denied — an unevaluable guard is a failed guard.
#
#  G1  payment-recovery         0 expired active payment_grace_periods.
#                               Otherwise it CANCELS subscriptions, downgrades
#                               to Free and disables anchoring for that user.
#  G2  report-metered-usage     0 active/trialing subscriptions. Otherwise it
#                               fires Stripe meter events (billing side effects).
#  G3  credit-expiry            0 `credits` rows with cycle_end <= now().
#                               `allocate_monthly_credits` EXPIRES the non-
#                               purchased balance of every such row and rewrites
#                               the cycle — mid-soak that moves the credit
#                               numbers Day-0 probe #10 asserted.
#  G4  queue-reminders          0 enabled organization_rules with a
#                               SCHEDULED_CRON / QUEUE_DIGEST trigger. Otherwise
#                               it queues PENDING rule executions that the BOUND
#                               rule-action-dispatcher then really sends.
#  G5  monthly-allocation-      rig env ENABLE_ALLOCATION_ROLLOVER == 'false'.
#      rollover                 The job reads raw process.env !== 'false', so an
#                               UNSET var means enabled. Armed, it calls
#                               roll_over_monthly_allocation per org.
#
# ── COHORT INTEGRITY ─────────────────────────────────────────────────────────
# `anchors` and `anchor_proofs` are counted before and after the whole run. If
# either moves, that is recorded as a FINDING against this script itself — the
# instrument is not allowed to quietly contaminate the evidence it supports.
#
# ── RATE LIMIT ───────────────────────────────────────────────────────────────
# cronRouter's limiter is 30 requests / 60 s under ONE shared key ('cron-jobs')
# for the whole router — the 26 scheduled jobs draw from the same budget. This
# script paces at INTERVAL_SEC (default 6 s ≈ 10/min) and backs off on 429 so it
# can never starve a scheduled job into a 429 that would look like a soak defect.
#
# ── DEPENDENCIES ─────────────────────────────────────────────────────────────
#   gcloud (auth'd; Secret Manager read, identity token, scheduler+run list),
#   curl, python3, git. Bash 3.2 compatible (stock macOS /bin/bash).
#
# ── USAGE ────────────────────────────────────────────────────────────────────
#   ./scripts/staging/fullsoak-cron-exerciser.sh            # exercise + evidence
#   ./scripts/staging/fullsoak-cron-exerciser.sh --plan     # classify only, no
#                                                           # HTTP to any route
#   ./scripts/staging/fullsoak-cron-exerciser.sh --only /jobs-path
#   ./scripts/staging/fullsoak-cron-exerciser.sh --interval 10
#
# Exit: 0 no findings · 1 one or more findings · 2 harness/auth error.

set -uo pipefail

# ═════════════════════════════════════════════════════════════════════════════
# CONFIG — expectations, not observations.
# ═════════════════════════════════════════════════════════════════════════════

GCP_PROJECT="${GCP_PROJECT:-arkova1}"
GCP_REGION="${GCP_REGION:-us-central1}"
RIG_SERVICE="${RIG_SERVICE:-arkova-worker-fullsoak-2026-08-staging}"
RIG_URL="${RIG_URL:-https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app}"
RIG_SUPABASE_REF="${RIG_SUPABASE_REF:-gnkuaywlpmsaezwvlvhk}"
CRON_SECRET_NAME="${CRON_SECRET_NAME:-cron-secret}"
SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
SUPABASE_ACCESS_TOKEN_SECRET="${SUPABASE_ACCESS_TOKEN_SECRET:-supabase_access}"
CRON_SRC="${CRON_SRC:-services/worker/src/routes/cron.ts}"
EVID_ROOT_REL="${EVID_ROOT_REL:-docs/staging/evidence/fullsoak-2026-08}"
INTERVAL_SEC="${INTERVAL_SEC:-6}"
BODY_TRUNC="${BODY_TRUNC:-220}"

# ─────────────────────────────────────────────────────────────────────────────
# POLICY TABLE — route|verdict|code|reason[|expected-status]
#   ALLOW  invoke
#   DENY   never invoke (code D1-D8)
#   GUARD  invoke only if the named precondition proves the run inert (G1-G5)
#
# The optional 5th field names a NON-2xx status that is the route's documented,
# by-design answer in this environment (a feature gate, not a defect). Matching
# it records BY-DESIGN instead of FINDING. It is deliberately a per-route exact
# status, never a range: softening a real 500 into "expected" is the one way this
# table could launder a defect, so each entry must cite the gate that produces it.
# Routes bound to Cloud Scheduler are skipped as BOUND regardless of this table
# (they are already exercised continuously). A route in cron.ts and NOT in this
# table is denied as `unclassified` — see limit 4.
# ─────────────────────────────────────────────────────────────────────────────
read -r -d '' POLICY <<'POLICY_EOF'
/fetch-edgar|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-uspto|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-federal-register|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-openalex|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-courtlistener|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-state-courts|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-state-bills|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-all-state-bills|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-dapip|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-acnc|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-calbar|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-finra|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-sec-iapd|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-edgar-form-adv|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-npi|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-cms-physicians|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-medical-boards|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-sam-entities|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-sam-exclusions|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-fcc|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-sos|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-licensing-board|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-insurance-licenses|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-cle|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-certifications|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-ipeds|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-kenya|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-australia|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-brazil-compliance|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-singapore-compliance|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-mexico-compliance|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-ecfr|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-enforcement|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-continuing-education|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-acra-sg|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-moh-sg|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/fetch-cnpj-br|DENY|D1|external registry ingestion -> public_records -> bound anchor-public-records -> anchors
/edgar-backfill|DENY|D1|historical backfill of the same ingestion family; unbounded
/edgar-bulk|DENY|D1|bulk ingestion of the same family; unbounded
/openalex-bulk|DENY|D1|bulk ingestion of the same family; unbounded
/embed-public-records|DENY|D1|embeds the ingested corpus; spends AI credits on rows the cohort must not gain
/regulatory-change-scan|DENY|D1|live external registry scan + AI spend
/cleanup-retention|DENY|D2|calls cleanup_expired_data() — GDPR retention purge, deletes rows the soak measures
/mainnet-migration|DENY|D3|mainnet migration must never run on a signet rig
/supplementary-proof-anchor|DENY|D4|only job in the repo that spends real mainnet BTC across the 2.97M backlog
/materialize-proof-backcatalog|DENY|D5|INSERTs anchor_proofs when armed; inertness rides on an env var
/classify-proof-backcatalog|DENY|D6|persists a durable job_queue checkpoint and advances the census cursor even in dry-run
/bq-export-backfill|DENY|D7|unbounded full-table export; needs an explicit ?table= param
/drive-subscription-renewal|DENY|D8|mutates the seeded google_drive org_integrations row P9b's daily probe addresses
/payment-recovery|GUARD|G1|expired active payment_grace_periods must be 0
/report-metered-usage|GUARD|G2|active/trialing subscriptions must be 0
/credit-expiry|GUARD|G3|credits rows with cycle_end <= now() must be 0
/queue-reminders|GUARD|G4|enabled SCHEDULED_CRON/QUEUE_DIGEST organization_rules must be 0
/monthly-allocation-rollover|GUARD|G5|rig env ENABLE_ALLOCATION_ROLLOVER must be exactly 'false'
/ai-credit-reconcile|ALLOW||drains ai-credit reconcile job_queue rows; no DML of its own
/bq-export-incremental|ALLOW||no BigQuery dataset wired to the rig; exercises the missing-config path
/bq-export-snapshot|ALLOW||no BigQuery dataset wired to the rig; exercises the missing-config path
/calibration-refit|ALLOW||reads calibration_features and RETURNS a proposal; writes nothing
/ce-key-expiry-check|ALLOW||read + alert only; no CE credentials on the rig
/ce-registry-drift-check|ALLOW||read + alert; no CE credentials on the rig
/check-attestation-expiry|ALLOW||expires attestations past their own expiry — the same lifecycle the bound anchor-expiry-sweep runs
/check-credential-expiry|ALLOW||FD-2: read-only up to the failing SELECT; this is the known prod-exposed 500
/connector-health-check|ALLOW||read + alert
/docusign-connect-failures-poll|ALLOW||no DocuSign tenant; exercises the unreachable-vendor path
/docusign-envelope-completed|ALLOW||drains job_queue rows of that type; bounded last_error, no bytes (§1.6A)
/docusign-listener-drift|ALLOW||detection only; no DocuSign listener writes
/docusign-notarization-completed|ALLOW||drains job_queue rows of that type
/docusign-queue-reconciliation|ALLOW||ENABLE_DOCUSIGN_QUEUE_RECONCILIATION off — exercises the skip path
/docusign-reconciliation|ALLOW||no tenant; gap detection only
/drive-file-changed|ALLOW||drains job_queue rows of that type
/financial-report|ALLOW||read-only aggregation over billing_events / x402_payments / anchors
/generate-reports|ALLOW||drains pending `reports` rows into report_artifacts — real product behaviour
/lock-wait|ALLOW||pg_locks observability read
/migration-status|ALLOW||GET; mainnet-migration STATUS read only, no migration
/pipeline-health|ALLOW||read + alert
/pipeline-throughput-monitor|ALLOW||read + alert
/professional-education-extraction|ALLOW||ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY off — exercises the 503 gate|503
/proof-coverage-monitor|ALLOW||read + alert over anchor_proofs; no writes
/queue-digest|ALLOW||ENABLE_QUEUE_DIGEST off — no-ops before enumerating admins or sending mail
/reconcile-credit-conservation|ALLOW||reconciler; read + alert
/reconcile-stripe|ALLOW||DB-only reconciliation; upserts one reconciliation_reports row
/smoke-test|ALLOW||read-only checks + one audit_events row
/smoke-test/history|ALLOW||GET; audit_events read
/treasury-alert-check|ALLOW||read + alert
/workspace-subscription-renewal|ALLOW||drive/graph renewers are wired to throw; exercises the not-configured path
POLICY_EOF

# route|table  — before/after count captured for these exercised routes.
read -r -d '' DELTA_TABLES <<'DELTA_EOF'
/check-attestation-expiry|attestations
/generate-reports|report_artifacts
/queue-digest|audit_events
/smoke-test|audit_events
/reconcile-stripe|reconciliation_reports
/docusign-envelope-completed|job_queue
/docusign-notarization-completed|job_queue
/drive-file-changed|job_queue
/ai-credit-reconcile|job_queue
/professional-education-extraction|job_queue
/credit-expiry|credit_transactions
/queue-reminders|organization_rule_executions
/payment-recovery|payment_grace_periods
/monthly-allocation-rollover|org_monthly_allocation
DELTA_EOF

# ═════════════════════════════════════════════════════════════════════════════
# End of config.
# ═════════════════════════════════════════════════════════════════════════════

MODE="run"; ONLY=""
_next=""
for arg in "$@"; do
  if [ -n "$_next" ]; then
    case "$_next" in only) ONLY="$arg" ;; interval) INTERVAL_SEC="$arg" ;; esac
    _next=""; continue
  fi
  case "$arg" in
    --plan)     MODE="plan" ;;
    --only)     _next="only" ;;
    --interval) _next="interval" ;;
    -h|--help)  sed -n '2,120p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "cannot cd to repo root" >&2; exit 2; }

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/fullsoak-cron.XXXXXX")" || exit 2
cleanup() { rm -rf "$TMPD"; }
trap cleanup EXIT INT TERM
chmod 700 "$TMPD"

RUN_DATE="$(date -u +%F)"
RUN_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_STAMP="$(date -u +%H%M%SZ)"
OUT_DIR="$REPO_ROOT/$EVID_ROOT_REL/$RUN_DATE"
mkdir -p "$OUT_DIR" || exit 2
OUT_MD="$OUT_DIR/cron-exerciser.md"
OUT_RUN_MD="$OUT_DIR/cron-exerciser-$RUN_STAMP.md"
OUT_JSON="$OUT_DIR/cron-exerciser-$RUN_STAMP.json"

die() { echo "FATAL: $*" >&2; exit 2; }
secret() { gcloud secrets versions access latest --secret="$1" --project="$GCP_PROJECT" 2>/dev/null; }

pyjson() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

# ── Read-only SQL over the Supabase Management API (a SELECT is not a write) ──
SQL_AVAILABLE=0
[ -z "$SUPABASE_ACCESS_TOKEN" ] && SUPABASE_ACCESS_TOKEN="$(secret "$SUPABASE_ACCESS_TOKEN_SECRET")"
[ -n "$SUPABASE_ACCESS_TOKEN" ] && SQL_AVAILABLE=1

sql1() { # project_ref | query | key -> scalar ('<error>' on any failure)
  [ "$SQL_AVAILABLE" -eq 1 ] || { echo '<no-token>'; return 1; }
  local q rc
  q="$(python3 -c 'import json,sys; print(json.dumps({"query":sys.argv[1]}))' "$2")"
  rc="$TMPD/mgmt.rc"
  ( umask 077; {
      printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ACCESS_TOKEN"
      printf 'header = "Content-Type: application/json"\n'
      printf 'silent\nshow-error\nmax-time = 45\n'
    } > "$rc" )
  printf '%s' "$q" | curl -K "$rc" -X POST \
    "https://api.supabase.com/v1/projects/$1/database/query" --data-binary @- 2>/dev/null \
  | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print((d[0] if isinstance(d,list) and d else {}).get(sys.argv[1],'<none>'))
except Exception:
    print('<error>')
" "$3"
  rm -f "$rc"
}

count_of() { # table -> integer or '<error>'
  sql1 "$RIG_SUPABASE_REF" "select count(*)::int as n from public.\"$1\"" n
}

# ═════════════════════════════════════════════════════════════════════════════
# 1. Route enumeration — from the SHA the rig is actually running, not HEAD.
# ═════════════════════════════════════════════════════════════════════════════
RIG_ID_TOKEN="$(gcloud auth print-identity-token --audiences="$RIG_URL" 2>/dev/null)"
[ -n "$RIG_ID_TOKEN" ] || die "cannot mint a Cloud Run identity token for $RIG_URL"

curl -s --max-time 30 "$RIG_URL/health" -H "Authorization: Bearer $RIG_ID_TOKEN" > "$TMPD/health.json" 2>/dev/null
RIG_SHA="$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1])).get('git_sha',''))
except Exception: print('')
" "$TMPD/health.json")"
RIG_UPTIME="$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1])).get('uptime',''))
except Exception: print('')
" "$TMPD/health.json")"

SRC_ORIGIN="worktree ($(git rev-parse --short HEAD 2>/dev/null))"
if [ -n "$RIG_SHA" ] && git cat-file -e "${RIG_SHA}^{commit}" 2>/dev/null; then
  if git show "$RIG_SHA:$CRON_SRC" > "$TMPD/cron.ts" 2>/dev/null; then
    SRC_ORIGIN="rig frozen SHA ${RIG_SHA}"
  fi
fi
[ -s "$TMPD/cron.ts" ] || cp "$CRON_SRC" "$TMPD/cron.ts" || die "cannot read $CRON_SRC"

python3 - "$TMPD/cron.ts" > "$TMPD/routes.txt" <<'PY'
import re,sys
src=open(sys.argv[1]).read()
seen=[]
for m in re.finditer(r"cronRouter\.(get|post)\(\s*'([^']+)'", src):
    verb,path=m.group(1).upper(),m.group(2)
    if not any(p==path for _,p in seen): seen.append((verb,path))
for verb,path in sorted(seen,key=lambda x:x[1]):
    print(f"{path}\t{verb}")
PY
ROUTE_TOTAL="$(wc -l < "$TMPD/routes.txt" | tr -d ' ')"
[ "$ROUTE_TOTAL" -gt 0 ] || die "route enumeration produced nothing — refusing to run"

# ── Live Scheduler census, filtered to this rig's service ────────────────────
gcloud scheduler jobs list --project="$GCP_PROJECT" --location="$GCP_REGION" \
  --format='value(httpTarget.uri)' 2>/dev/null \
  | grep -F "$RIG_SERVICE" \
  | sed -E 's#.*/jobs/([^?]*).*#/\1#' | sort -u > "$TMPD/bound.txt"
BOUND_TOTAL="$(wc -l < "$TMPD/bound.txt" | tr -d ' ')"
[ "$BOUND_TOTAL" -gt 0 ] || die "Scheduler census empty for $RIG_SERVICE — refusing to treat every route as unbound"

# ═════════════════════════════════════════════════════════════════════════════
# 2. Guard preconditions (read-only). An unevaluable guard is a failed guard.
# ═════════════════════════════════════════════════════════════════════════════
guard_result() { # code -> "PASS|detail" or "FAIL|detail"
  local code="$1" n=""
  case "$code" in
    G1) n="$(sql1 "$RIG_SUPABASE_REF" "select count(*)::int as n from public.payment_grace_periods where status='active' and grace_end < now()" n)"
        [ "$n" = "0" ] && echo "PASS|0 expired active grace periods" || echo "FAIL|expired active grace periods = $n" ;;
    G2) n="$(sql1 "$RIG_SUPABASE_REF" "select count(*)::int as n from public.subscriptions where status in ('active','trialing')" n)"
        [ "$n" = "0" ] && echo "PASS|0 active/trialing subscriptions" || echo "FAIL|active/trialing subscriptions = $n" ;;
    G3) n="$(sql1 "$RIG_SUPABASE_REF" "select count(*)::int as n from public.credits where cycle_end <= now()" n)"
        [ "$n" = "0" ] && echo "PASS|0 credits rows due for cycle rollover" || echo "FAIL|credits rows with cycle_end<=now() = $n" ;;
    G4) n="$(sql1 "$RIG_SUPABASE_REF" "select count(*)::int as n from public.organization_rules where enabled = true and trigger_type in ('SCHEDULED_CRON','QUEUE_DIGEST')" n)"
        [ "$n" = "0" ] && echo "PASS|0 enabled scheduled/digest rules" || echo "FAIL|enabled scheduled/digest rules = $n" ;;
    G5) n="$(gcloud run services describe "$RIG_SERVICE" --project="$GCP_PROJECT" --region="$GCP_REGION" \
             --format='value(spec.template.spec.containers[0].env.filter("name:ENABLE_ALLOCATION_ROLLOVER").extract("value"))' 2>/dev/null \
             | tr -d "[]' " )"
        [ "$n" = "false" ] && echo "PASS|ENABLE_ALLOCATION_ROLLOVER=false on the rig" || echo "FAIL|ENABLE_ALLOCATION_ROLLOVER='${n:-<unset>}' — job is ARMED" ;;
    *)  echo "FAIL|unknown guard code $code" ;;
  esac
}

# ═════════════════════════════════════════════════════════════════════════════
# 3. Exercise
# ═════════════════════════════════════════════════════════════════════════════
CRON_SECRET="$(secret "$CRON_SECRET_NAME")"
[ -n "$CRON_SECRET" ] || die "cannot read secret $CRON_SECRET_NAME"

invoke() { # verb | path -> writes $TMPD/r.{status,body,ms}
  local verb="$1" path="$2" rc="$TMPD/curl.rc" attempt=0 code
  while [ "$attempt" -lt 3 ]; do
    ( umask 077; {
        printf 'url = "%s/jobs%s"\n' "$RIG_URL" "$path"
        printf 'request = "%s"\n' "$verb"
        printf 'header = "Authorization: Bearer %s"\n' "$RIG_ID_TOKEN"
        printf 'header = "X-Cron-Secret: %s"\n' "$CRON_SECRET"
        printf 'header = "Content-Type: application/json"\n'
        printf 'silent\nshow-error\nmax-time = 120\n'
        printf 'write-out = "%%{http_code} %%{time_total}"\n'
        printf 'output = "%s/r.body"\n' "$TMPD"
      } > "$rc" )
    curl -K "$rc" > "$TMPD/r.raw" 2>"$TMPD/r.err"; local crc=$?
    rm -f "$rc"
    if [ $crc -ne 0 ]; then echo "000" > "$TMPD/r.status"; echo "0" > "$TMPD/r.ms"; return; fi
    code="$(cut -d' ' -f1 < "$TMPD/r.raw")"
    python3 -c "
import sys
try: print(int(float(sys.argv[1])*1000))
except Exception: print(0)
" "$(cut -d' ' -f2 < "$TMPD/r.raw")" > "$TMPD/r.ms"
    echo "$code" > "$TMPD/r.status"
    # 429 is the shared cron limiter, not the route. Back off and retry so a
    # rate-limited call is never recorded as a route finding.
    [ "$code" != "429" ] && return
    attempt=$((attempt+1)); sleep 30
  done
}

trunc_body() {
  python3 -c "
import sys
try: s=open(sys.argv[1],'r',errors='replace').read()
except Exception: s=''
s=' '.join(s.split())
n=int(sys.argv[2])
print(s[:n]+('…' if len(s)>n else '') if s else '<empty>')
" "$TMPD/r.body" "$BODY_TRUNC"
}

# Cohort integrity — before.
ANCHORS_BEFORE="$(count_of anchors)"
PROOFS_BEFORE="$(count_of anchor_proofs)"

OK=0; FINDINGS=0; DENIED=0; BOUND=0; BYDESIGN=0
ROWS=""      # md table rows
JROWS=""     # json rows
FIND_DETAIL=""
DENY_DETAIL=""

policy_for() { printf '%s\n' "$POLICY" | awk -F'|' -v r="$1" '$1==r {print; exit}'; }
delta_table_for() { printf '%s\n' "$DELTA_TABLES" | awk -F'|' -v r="$1" '$1==r {print $2; exit}'; }

echo "fullsoak-cron-exerciser — $RUN_TS — $ROUTE_TOTAL routes, $BOUND_TOTAL bound — src: $SRC_ORIGIN"

while IFS="$(printf '\t')" read -r ROUTE VERB; do
  [ -n "$ROUTE" ] || continue
  [ -n "$ONLY" ] && [ "$ONLY" != "$ROUTE" ] && continue

  if grep -qxF "$ROUTE" "$TMPD/bound.txt"; then
    BOUND=$((BOUND+1))
    ROWS="$ROWS| \`$ROUTE\` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
"
    JROWS="$JROWS{\"route\":$(pyjson "$ROUTE"),\"verdict\":\"BOUND\"},"
    continue
  fi

  P="$(policy_for "$ROUTE")"
  if [ -z "$P" ]; then
    DENIED=$((DENIED+1))
    DENY_DETAIL="$DENY_DETAIL- \`$ROUTE\` — **unclassified**: present in cron.ts, absent from the policy table. Denied by the fail-closed rule (limit 4). Classify it before the next run.
"
    ROWS="$ROWS| \`$ROUTE\` | DENIED | — | — | — | unclassified (fail-closed) |
"
    JROWS="$JROWS{\"route\":$(pyjson "$ROUTE"),\"verdict\":\"DENIED\",\"code\":\"unclassified\"},"
    continue
  fi

  VERDICT="$(printf '%s' "$P" | cut -d'|' -f2)"
  CODE="$(printf '%s' "$P" | cut -d'|' -f3)"
  REASON="$(printf '%s' "$P" | cut -d'|' -f4)"
  EXPECT="$(printf '%s' "$P" | cut -d'|' -f5)"

  if [ "$VERDICT" = "GUARD" ]; then
    G="$(guard_result "$CODE")"
    GS="${G%%|*}"; GD="${G#*|}"
    if [ "$GS" != "PASS" ]; then
      DENIED=$((DENIED+1))
      DENY_DETAIL="$DENY_DETAIL- \`$ROUTE\` — **$CODE guard failed**: $GD. Policy: $REASON.
"
      ROWS="$ROWS| \`$ROUTE\` | DENIED | — | — | — | $CODE guard failed — $GD |
"
      JROWS="$JROWS{\"route\":$(pyjson "$ROUTE"),\"verdict\":\"DENIED\",\"code\":$(pyjson "$CODE"),\"guard\":$(pyjson "$GD")},"
      continue
    fi
    VERDICT="ALLOW"; REASON="$CODE guard passed ($GD)"
  fi

  if [ "$VERDICT" = "DENY" ]; then
    DENIED=$((DENIED+1))
    DENY_DETAIL="$DENY_DETAIL- \`$ROUTE\` — **$CODE**: $REASON
"
    ROWS="$ROWS| \`$ROUTE\` | DENIED | — | — | — | $CODE — $REASON |
"
    JROWS="$JROWS{\"route\":$(pyjson "$ROUTE"),\"verdict\":\"DENIED\",\"code\":$(pyjson "$CODE"),\"reason\":$(pyjson "$REASON")},"
    continue
  fi

  # ALLOW
  if [ "$MODE" = "plan" ]; then
    ROWS="$ROWS| \`$ROUTE\` | PLAN-ALLOW | $VERB | — | — | $REASON |
"
    JROWS="$JROWS{\"route\":$(pyjson "$ROUTE"),\"verdict\":\"PLAN-ALLOW\"},"
    continue
  fi

  DT="$(delta_table_for "$ROUTE")"
  BEFORE=""; AFTER=""; DELTA="—"
  [ -n "$DT" ] && BEFORE="$(count_of "$DT")"

  invoke "$VERB" "$ROUTE"
  HTTP="$(cat "$TMPD/r.status")"; MS="$(cat "$TMPD/r.ms")"; BODY="$(trunc_body)"

  if [ -n "$DT" ]; then
    AFTER="$(count_of "$DT")"
    if [ "$BEFORE" = "$AFTER" ]; then DELTA="\`$DT\` $BEFORE → $AFTER (0)"
    else DELTA="\`$DT\` **$BEFORE → $AFTER**"; fi
  fi

  case "$HTTP" in
    2*) OK=$((OK+1)); RES="OK" ;;
    401) die "HTTP 401 on $ROUTE — cron auth is broken for this run; aborting rather than recording 85 false findings" ;;
    "$EXPECT") OK=$((OK+1)); BYDESIGN=$((BYDESIGN+1)); RES="BY-DESIGN" ;;
    *)  FINDINGS=$((FINDINGS+1)); RES="FINDING"
        FIND_DETAIL="$FIND_DETAIL
#### \`$ROUTE\` — HTTP $HTTP (${MS} ms)

\`\`\`
$BODY
\`\`\`
"
        ;;
  esac

  ROWS="$ROWS| \`$ROUTE\` | $RES | $VERB | $HTTP | ${MS} ms | $DELTA · $BODY |
"
  JROWS="$JROWS{\"route\":$(pyjson "$ROUTE"),\"verdict\":$(pyjson "$RES"),\"verb\":$(pyjson "$VERB"),\"http\":$(pyjson "$HTTP"),\"ms\":$(pyjson "$MS"),\"delta_table\":$(pyjson "${DT:-}"),\"before\":$(pyjson "${BEFORE:-}"),\"after\":$(pyjson "${AFTER:-}"),\"body\":$(pyjson "$BODY")},"
  printf '  %-9s %-38s http %-3s %6s ms\n' "$RES" "$ROUTE" "$HTTP" "$MS"
  sleep "$INTERVAL_SEC"
done < "$TMPD/routes.txt"

# Cohort integrity — after.
ANCHORS_AFTER="$(count_of anchors)"
PROOFS_AFTER="$(count_of anchor_proofs)"
COHORT="intact"
if [ "$ANCHORS_BEFORE" != "$ANCHORS_AFTER" ] || [ "$PROOFS_BEFORE" != "$PROOFS_AFTER" ]; then
  COHORT="MOVED"
  FINDINGS=$((FINDINGS+1))
  FIND_DETAIL="$FIND_DETAIL
#### COHORT INTEGRITY — the exerciser moved the anchor cohort

\`anchors\` $ANCHORS_BEFORE → $ANCHORS_AFTER · \`anchor_proofs\` $PROOFS_BEFORE → $PROOFS_AFTER.
A bound job may have fired mid-run, or a policy entry is wrong. Reconcile before citing this run.
"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 4. Evidence
# ═════════════════════════════════════════════════════════════════════════════
{
cat <<MD
# Cron route exerciser — $RUN_DATE

> Run \`$RUN_TS\` · rig \`$RIG_SERVICE\` · Supabase \`$RIG_SUPABASE_REF\`
> Route source: **$SRC_ORIGIN** · rig \`git_sha\` \`${RIG_SHA:-<unknown>}\` · uptime \`${RIG_UPTIME}s\`
> Host \`$(hostname)\` · repo HEAD \`$(git rev-parse HEAD 2>/dev/null)\` · mode \`$MODE\`
> Mgmt SQL reads: $([ "$SQL_AVAILABLE" -eq 1 ] && echo available || echo UNAVAILABLE)

**What this measures.** Every cron route declared in \`cron.ts\` that Cloud Scheduler does *not*
bind on this rig, invoked once over the same authenticated HTTP path Scheduler uses, with its
status, latency, response body and (where a table is obvious from the handler) its row delta.

**What this does NOT assert.** That a 2xx means the job did useful work — most of these have
nothing to act on. It asserts reachability, auth, and the absence of a crash. A non-2xx is a
FINDING; a 2xx is evidence the route is not FD-2-class broken.

## Census

| | count |
|---|---|
| Routes declared in \`cron.ts\` | **$ROUTE_TOTAL** |
| Scheduler-bound on this rig | **$BOUND_TOTAL** |
| Unbound (this script's scope) | **$((ROUTE_TOTAL - BOUND_TOTAL))** |
| Exercised OK | **$OK** (of which **$BYDESIGN** are a documented gate answering non-2xx by design) |
| Findings | **$FINDINGS** |
| Denied (never invoked) | **$DENIED** |

## Cohort integrity

\`anchors\` $ANCHORS_BEFORE → $ANCHORS_AFTER · \`anchor_proofs\` $PROOFS_BEFORE → $PROOFS_AFTER — **$COHORT**.
The exerciser is not permitted to move the BL-2 cohort; this row is the proof it did not.

## Results

| route | verdict | verb | http | ms | delta · body |
|---|---|---|---|---|---|
$ROWS
MD

if [ "$FINDINGS" -gt 0 ]; then
  echo "## Findings"
  echo "$FIND_DETAIL"
fi

if [ "$DENIED" -gt 0 ]; then
  echo "## Denied — never invoked, with the reason"
  echo
  echo "$DENY_DETAIL"
fi

cat <<MD

---

\`CRON_EXERCISER: $OK ok / $FINDINGS findings / $DENIED denied\`

_Produced by \`scripts/staging/fullsoak-cron-exerciser.sh\`. No rig env, flag, secret, scheduler job,
revision or traffic split was modified; the soak clock was not touched._
MD
} > "$OUT_RUN_MD"

# Only a FULL run may claim the canonical daily path. A --plan or --only run is
# a partial view of the day and must never be mistaken for the day's evidence.
if [ "$MODE" = "run" ] && [ -z "$ONLY" ]; then
  cp "$OUT_RUN_MD" "$OUT_MD"
else
  OUT_MD="$OUT_RUN_MD"
fi

{
  printf '{\n'
  printf '  "run_ts": "%s",\n' "$RUN_TS"
  printf '  "rig_service": "%s",\n' "$RIG_SERVICE"
  printf '  "rig_git_sha": "%s",\n' "$RIG_SHA"
  printf '  "route_source": %s,\n' "$(pyjson "$SRC_ORIGIN")"
  printf '  "routes_total": %s, "bound": %s,\n' "$ROUTE_TOTAL" "$BOUND_TOTAL"
  printf '  "ok": %s, "findings": %s, "denied": %s,\n' "$OK" "$FINDINGS" "$DENIED"
  printf '  "cohort": {"anchors_before": "%s", "anchors_after": "%s", "proofs_before": "%s", "proofs_after": "%s", "state": "%s"},\n' \
    "$ANCHORS_BEFORE" "$ANCHORS_AFTER" "$PROOFS_BEFORE" "$PROOFS_AFTER" "$COHORT"
  printf '  "routes": [%s]\n' "$(printf '%s' "$JROWS" | sed 's/,$//')"
  printf '}\n'
} > "$OUT_JSON"

echo "----------------------------------------------------------------------"
echo "CRON_EXERCISER: $OK ok / $FINDINGS findings / $DENIED denied"
echo "artifact: $OUT_MD"
[ "$FINDINGS" -eq 0 ] && exit 0 || exit 1
