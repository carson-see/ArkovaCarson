#!/usr/bin/env bash
# scripts/staging/fullsoak-e2e-daily.sh
#
# Daily Playwright E2E run for the 2026-08 7-day full-functionality soak.
#
# WHY THIS EXISTS
# ---------------
# The repo's 46-spec Playwright suite is gated in CI by the `e2e-changed` path
# filter (.github/workflows/ci.yml, job `e2e`): a docs-only PR reports the
# "E2E Tests" check GREEN without ever launching a browser. Every commit of the
# 2026-08 soak window has been docs-only, so the suite — including
# `e2e/cross-tenant.spec.ts`, which is the G4 / CC6.1 tenant-isolation evidence
# — has NOT run once during the soak. A green CI check is not proof the suite
# ran (e2e/agents.md says exactly this). This script closes that gap by running
# the suite on a schedule, against a rig, and writing dated evidence.
#
# WHAT IT TOUCHES
# ---------------
# It is WRITE-heavy by nature (Playwright seeds and tears down fixtures), so it
# is hard-wired to the throwaway SIDE-RIG and refuses anything else:
#   Supabase : ehqqearcitrgloibtjqx  (connector-sidecar-2026-08-staging)
#   Worker   : a LOCAL worker on 127.0.0.1:3001 backed by that same Supabase
#              (CI parity — the CI e2e job starts the worker the same way)
# It NEVER touches the fullsoak rig (gnkuaywlpmsaezwvlvhk /
# arkova-worker-fullsoak-2026-08-staging), shared staging (ujtlwnoqfhtitcmsnrpq)
# or prod (vzwyaatejekddvltxyye): those three are exported in
# SOAKING_PROJECT_REFS and e2e/helpers/soaking-ref-guard.ts hard-refuses them.
#
# DEPENDENCIES
#   gcloud (auth'd; export CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.14/bin/python3.14)
#   node >= 20 for the frontend; a node with a matching @sentry/node-cpu-profiler
#   prebuild for the worker (node 25 has none — NODE_BIN below pins node@22),
#   npx/playwright + chromium already installed, curl, python3.
#
# SECRET HYGIENE
#   Secrets are read from Secret Manager into shell variables and exported to
#   child processes only. They are never written to an artifact and never
#   passed in argv. The generated evidence files contain no secret values.
#
# USAGE
#   ./scripts/staging/fullsoak-e2e-daily.sh
#   SPECS_OVERRIDE="e2e/cross-tenant.spec.ts" ./scripts/staging/fullsoak-e2e-daily.sh
#
# Exit code: 0 when every spec in the runnable subset passes, 1 on any test
# failure, 2 on a harness/precondition error (secrets, dev server, worker).

set -euo pipefail

# ═════════════════════════════════════════════════════════════════════════════
# CONFIG
# ═════════════════════════════════════════════════════════════════════════════

GCP_PROJECT="${GCP_PROJECT:-arkova1}"

# The ONLY Supabase project this script may write to.
SIDE_RIG_REF="${SIDE_RIG_REF:-ehqqearcitrgloibtjqx}"
SB_URL_SECRET="${SB_URL_SECRET:-supabase-url-connector-sidecar-2026-08-staging}"
SB_SERVICE_KEY_SECRET="${SB_SERVICE_KEY_SECRET:-supabase-service-role-key-connector-sidecar-2026-08-staging}"
SB_ANON_KEY_SECRET="${SB_ANON_KEY_SECRET:-supabase-anon-key-connector-sidecar-2026-08-staging}"
SEED_PASSWORD_SECRET="${SEED_PASSWORD_SECRET:-arkova-fullsoak-2026-08-e2e-seed-password}"

# Protected refs the soaking-ref guard must refuse (§1.11A, #1147 scar).
PROTECTED_REFS="${PROTECTED_REFS:-gnkuaywlpmsaezwvlvhk,ujtlwnoqfhtitcmsnrpq,vzwyaatejekddvltxyye}"

FRONTEND_PORT="${FRONTEND_PORT:-5173}"
WORKER_PORT="${WORKER_PORT:-3001}"
FRONTEND_URL="http://localhost:${FRONTEND_PORT}"
WORKER_URL="http://127.0.0.1:${WORKER_PORT}"

# The worker's @sentry/node-cpu-profiler ships no darwin-arm64 prebuild for the
# node 25 ABI (141); node@22 (ABI 127) has one. Override for other machines.
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@22/bin/node}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVID_ROOT="${EVID_ROOT:-$REPO_ROOT/docs/staging/evidence/fullsoak-2026-08}"

# ═════════════════════════════════════════════════════════════════════════════
# THE RUNNABLE SUBSET
#
# Verified 2026-08-13 by running all 46 specs one-at-a-time (chromium,
# workers=1) against the side rig + a local CI-parity worker. Only specs that
# passed clean are listed here; every exclusion is named below with its reason,
# so a spec is never silently dropped.
# ═════════════════════════════════════════════════════════════════════════════

RUNNABLE_SPECS=(
  e2e/a11y.spec.ts
  e2e/anchor-creation.spec.ts
  e2e/api-keys.spec.ts
  e2e/api-verify-flow.spec.ts
  e2e/attestation-verification.spec.ts
  e2e/auth.spec.ts
  e2e/billing.spec.ts
  e2e/cross-tenant.spec.ts
  e2e/csv-upload.spec.ts
  e2e/ctdl-registry-import.spec.ts
  e2e/dashboard.spec.ts
  e2e/data-retention.spec.ts
  e2e/error-states.spec.ts
  e2e/extraction-csp-fail-closed.spec.ts
  e2e/identity-entitlement.spec.ts
  e2e/integrations-docusign.spec.ts
  e2e/integrations-docusign-member.spec.ts
  e2e/integrations-drive.spec.ts
  e2e/legal-pages.spec.ts
  e2e/member-invite.spec.ts
  e2e/mobile-viewport.spec.ts
  e2e/org-admin.spec.ts
  e2e/performance.spec.ts
  e2e/pipeline-admin-errors.spec.ts
  e2e/professional-education-cpe-cle.spec.ts
  e2e/proof-download.spec.ts
  e2e/provenance-timeline.spec.ts
  e2e/public-org.spec.ts
  e2e/public-org-page.spec.ts
  e2e/public-proof-gate.spec.ts
  e2e/public-search.spec.ts
  e2e/public-verification.spec.ts
  e2e/record-detail.spec.ts
  e2e/revocation.spec.ts
  e2e/route-screenshot-baseline.spec.ts
  e2e/secure-document.spec.ts
  e2e/semantic-search.spec.ts
  e2e/settings.spec.ts
  e2e/template-review.spec.ts
  e2e/treasury-errors.spec.ts
  e2e/treasury-observability.spec.ts
  e2e/version-conflicts.spec.ts
)

# ── EXCLUDED TESTS inside otherwise-runnable specs ──────────────────────────
#
# Applied as a Playwright --grep-invert. Two entries, both evidence-backed:
#
#   "User-to-User Isolation|Org-to-Org Isolation"
#     The five UI legs of cross-tenant.spec.ts. They fail on ANY environment
#     whose anchors query is slower than the first paint, because
#     src/hooks/useAnchor.ts sets `loading=false` on its `!user` branch while
#     useAuth is still resolving, so RecordDetailPage renders the
#     "Record Not Found" empty state for ~20ms BEFORE the real fetch. Measured
#     on 2026-08-13 against the side rig: headings went [] -> ["My Records",
#     "Record Not Found"] @783ms -> ["My Records"] @806ms -> ["My Records",
#     "Record Details", ...] @942ms. `observeRecordPage()` resolves its
#     waitForFunction on that transient and then re-queries visibility inside
#     the 806-942ms hole, so `assertOwnRecordReadable()` fails with
#     "precondition: <label> session did not render its own record within
#     budget". Worse, the same transient can satisfy `expectRecordBlocked()`
#     on a record the accessor CAN read, which is the hollow pass DEG-4 exists
#     to prevent. Re-enable these five the moment useAnchor gates on
#     `authLoading` — they are the point of this script.
#     The spec's other two legs (direct PostgREST/RLS and the public API with a
#     cross-tenant org API key) DO run and DO pass; they are the G4 / CC6.1
#     evidence this artifact carries today.
#
#   "signup stops on the email-confirmation screen"
#     Hosted Supabase throttles confirmation email. The signup POST returns
#     {"code":429,"error_code":"over_email_send_rate_limit"}, so the
#     "Check your email" screen never renders. CI does not hit this because it
#     runs a LOCAL Supabase with Inbucket. Nothing about the product is wrong;
#     the spec needs custom SMTP or a raised rate limit on the target project.
GREP_INVERT="${GREP_INVERT:-User-to-User Isolation|Org-to-Org Isolation|signup stops on the email-confirmation screen}"

# ── EXCLUDED SPEC FILES — each with the reason it cannot run daily here ─────
#
# e2e/identity.spec.ts, e2e/onboarding.spec.ts, e2e/route-guards.spec.ts
#     All three drive `withProfileSession()` from e2e/helpers/profile-session.ts,
#     which injects the session under a HARDCODED localStorage key,
#     `sb-127-auth-token`. supabase-js derives that key from the project host:
#     it is right for a LOCAL Supabase (127.0.0.1) and wrong for every hosted
#     project — the side rig's real key is `sb-ehqqearcitrgloibtjqx-auth-token`.
#     The app therefore boots unauthenticated, every page lands on /login, and
#     the specs fail (onboarding 9/9, identity 5/8, route-guards 1/10). This is
#     a harness defect, not a product defect: fix it by deriving the key from
#     E2E_SUPABASE_URL and these three specs come back.
#
# e2e/verify-ratelimit-contract.spec.ts
#     Written RED on purpose (SCRUM-2603) and still red: a verify burst of 11
#     (< the §1.10 anon 100/min contract) took 2x 429 advertising
#     X-RateLimit-Limit: 60, because adminRouter's checkout limiter is mounted
#     at /api ahead of the verify router. The mount-order fix is deliberately
#     WITHHELD, so including this spec would make the daily artifact
#     permanently red for a known, tracked defect. It also drives a 100+
#     request burst at one worker, which is not a thing to schedule daily.
#
# NOTE: cross-tenant.spec.ts is deliberately NOT excluded. It is the G4 /
# CC6.1 evidence and the entire reason this script exists; only its five UI
# legs are grep-inverted, with the defect that blocks them named above.

# ═════════════════════════════════════════════════════════════════════════════
# HARNESS
# ═════════════════════════════════════════════════════════════════════════════

DEV_PID=""
WORKER_PID=""
STARTED_DEV=0
STARTED_WORKER=0
TMP_DIR=""

# shellcheck disable=SC2329  # invoked indirectly by the trap below
cleanup() {
  local rc=$?
  if [ "$STARTED_WORKER" = "1" ] && [ -n "$WORKER_PID" ]; then
    kill "$WORKER_PID" 2>/dev/null || true
  fi
  if [ "$STARTED_DEV" = "1" ] && [ -n "$DEV_PID" ]; then
    kill "$DEV_PID" 2>/dev/null || true
  fi
  [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"
  exit "$rc"
}
trap cleanup EXIT INT TERM

die() { echo "ERROR: $*" >&2; exit 2; }

secret() {
  local name="$1" value
  value="$(gcloud secrets versions access latest --secret="$name" --project="$GCP_PROJECT" 2>/dev/null)" \
    || die "could not read Secret Manager secret '$name' (is gcloud authenticated?)"
  [ -n "$value" ] || die "Secret Manager secret '$name' is empty"
  printf '%s' "$value"
}

wait_for_http() { # wait_for_http <url> <label> <max_seconds>
  local url="$1" label="$2" budget="$3" i=0
  while [ "$i" -lt "$budget" ]; do
    if curl -fsS -m 3 "$url" >/dev/null 2>&1; then
      echo "  $label ready after ${i}s"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

cd "$REPO_ROOT"

command -v gcloud >/dev/null 2>&1 || die "gcloud not on PATH"
command -v npx    >/dev/null 2>&1 || die "npx not on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not on PATH"

UTC_NOW="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ"))')"
UTC_DATE="${UTC_NOW%T*}"
OUT_DIR="$EVID_ROOT/$UTC_DATE"
mkdir -p "$OUT_DIR"
MD_OUT="$OUT_DIR/e2e-daily-$UTC_NOW.md"
JSON_OUT="$OUT_DIR/e2e-daily-$UTC_NOW.json"

TMP_DIR="$(mktemp -d)"
RAW_JSON="$TMP_DIR/playwright.json"
RAW_LOG="$TMP_DIR/playwright.log"

echo "== fullsoak E2E daily =="
echo "  side rig      : $SIDE_RIG_REF"
echo "  protected refs: $PROTECTED_REFS"
echo "  evidence      : $MD_OUT"

# ── Secrets ─────────────────────────────────────────────────────────────────
E2E_SUPABASE_URL="$(secret "$SB_URL_SECRET")"
E2E_SUPABASE_SERVICE_KEY="$(secret "$SB_SERVICE_KEY_SECRET")"
SIDE_RIG_ANON_KEY="$(secret "$SB_ANON_KEY_SECRET")"
E2E_SEED_PASSWORD="$(secret "$SEED_PASSWORD_SECRET")"

case "$E2E_SUPABASE_URL" in
  *"$SIDE_RIG_REF"*) : ;;
  *) die "resolved Supabase URL does not contain the side-rig ref $SIDE_RIG_REF — refusing to run" ;;
esac

# ── Guard env (e2e/helpers/soaking-ref-guard.ts reads these) ────────────────
export SOAKING_PROJECT_REFS="$PROTECTED_REFS"
export E2E_SUPABASE_PROJECT_REF="$SIDE_RIG_REF"
export E2E_SUPABASE_URL E2E_SUPABASE_SERVICE_KEY E2E_SEED_PASSWORD
export E2E_WORKER_URL="$WORKER_URL"
export VITE_SUPABASE_URL="$E2E_SUPABASE_URL"
export VITE_SUPABASE_ANON_KEY="$SIDE_RIG_ANON_KEY"

# Belt-and-suspenders: refuse if the resolved URL names a protected ref. The
# in-suite guard does this too; doing it here means we never even boot.
for ref in ${PROTECTED_REFS//,/ }; do
  case "$E2E_SUPABASE_URL" in
    *"$ref"*) die "Supabase URL points at protected ref $ref — refusing to run" ;;
  esac
done

# ── Frontend (vite dev on 5173) ─────────────────────────────────────────────
# Process env beats .env.local, so the VITE_* exports above win even though
# .env.local points at prod for local UAT.
if curl -fsS -m 3 "$FRONTEND_URL" >/dev/null 2>&1; then
  echo "  reusing an existing dev server on $FRONTEND_URL"
else
  npm run dev -- --port "$FRONTEND_PORT" --strictPort > "$TMP_DIR/dev.log" 2>&1 &
  DEV_PID=$!
  STARTED_DEV=1
  wait_for_http "$FRONTEND_URL" "dev server" 120 \
    || { cat "$TMP_DIR/dev.log" >&2; die "dev server never became reachable on $FRONTEND_URL"; }
fi

# ── Worker (CI parity: local node worker on 3001, side-rig Supabase) ────────
if curl -fsS -m 3 "$WORKER_URL/health" >/dev/null 2>&1; then
  echo "  reusing an existing worker on $WORKER_URL"
else
  [ -x "$NODE_BIN" ] || die "NODE_BIN '$NODE_BIN' is not executable — set NODE_BIN to a node with a matching @sentry/node-cpu-profiler prebuild"
  worker_frontend_url="$FRONTEND_URL"
  (
    cd services/worker
    PORT="$WORKER_PORT" \
    NODE_ENV=test \
    LOG_LEVEL=warn \
    SUPABASE_URL="$E2E_SUPABASE_URL" \
    SUPABASE_SERVICE_ROLE_KEY="$E2E_SUPABASE_SERVICE_KEY" \
    STRIPE_SECRET_KEY=sk_test_e2e_local \
    STRIPE_WEBHOOK_SECRET=whsec_e2e_local \
    API_KEY_HMAC_SECRET=e2e-local-api-key-hmac-secret \
    USE_MOCKS=true \
    ENABLE_VERIFICATION_API=true \
    ENABLE_PROD_NETWORK_ANCHORING=false \
    BITCOIN_NETWORK=signet \
    FRONTEND_URL="$worker_frontend_url" \
    CORS_ALLOWED_ORIGINS="$worker_frontend_url" \
    exec "$NODE_BIN" --import tsx src/index.ts
  ) > "$TMP_DIR/worker.log" 2>&1 &
  WORKER_PID=$!
  STARTED_WORKER=1
  wait_for_http "$WORKER_URL/health" "worker" 120 \
    || { cat "$TMP_DIR/worker.log" >&2; die "worker never became healthy on $WORKER_URL"; }
fi

# ── Run ─────────────────────────────────────────────────────────────────────
# workers=1 mirrors the CI e2e job. It also matters here: the seed users'
# browser sessions come from one shared storageState file, and parallel workers
# racing the GoTrue refresh-token rotation kill those sessions mid-suite (a
# dead session shows up as a /login bounce, which cross-tenant.spec.ts is
# explicitly built to FAIL on rather than pass hollow).
SPECS=()
if [ -n "${SPECS_OVERRIDE:-}" ]; then
  # shellcheck disable=SC2206  # deliberate word-split of a space-separated override
  SPECS=(${SPECS_OVERRIDE})
else
  SPECS=("${RUNNABLE_SPECS[@]}")
fi

echo "  running ${#SPECS[@]} spec files (chromium, workers=1)"
GREP_ARGS=()
[ -n "$GREP_INVERT" ] && GREP_ARGS=(--grep-invert "$GREP_INVERT")
set +e
PLAYWRIGHT_JSON_OUTPUT_NAME="$RAW_JSON" \
  npx playwright test --project=chromium --workers=1 --reporter=list,json \
  "${GREP_ARGS[@]}" "${SPECS[@]}" > "$RAW_LOG" 2>&1
PW_EXIT=$?
set -e

# ── Summarise ───────────────────────────────────────────────────────────────
python3 - "$RAW_JSON" "$JSON_OUT" "$MD_OUT" "$UTC_NOW" "$SIDE_RIG_REF" "$PW_EXIT" <<'PY'
import json, sys, collections, os

raw_path, json_out, md_out, stamp, rig, pw_exit = sys.argv[1:7]

per = collections.defaultdict(lambda: {"passed": 0, "failed": 0, "skipped": 0, "flaky": 0})
failures = []

def walk(suite, file_hint=None):
    f = suite.get("file") or file_hint
    for spec in suite.get("specs", []):
        sf = spec.get("file") or f
        for test in spec.get("tests", []):
            status = test.get("status", "unknown")
            key = {"expected": "passed", "unexpected": "failed",
                   "skipped": "skipped", "flaky": "flaky"}.get(status, "failed")
            per[sf][key] += 1
            if key in ("failed", "flaky"):
                msg = ""
                for r in test.get("results", []):
                    err = r.get("error") or {}
                    if err.get("message"):
                        msg = err["message"].strip().splitlines()[0]
                        break
                failures.append({"file": sf, "title": spec.get("title", ""),
                                 "status": key, "error": msg})
    for child in suite.get("suites", []):
        walk(child, f)

report = {}
if os.path.exists(raw_path):
    with open(raw_path) as fh:
        report = json.load(fh)
for s in report.get("suites", []):
    walk(s)

totals = {k: sum(v[k] for v in per.values()) for k in ("passed", "failed", "skipped", "flaky")}
verdict = "PASS" if (totals["failed"] == 0 and totals["flaky"] == 0 and int(pw_exit) == 0) else "FAIL"

payload = {
    "artifact": "fullsoak-2026-08 daily E2E",
    "timestamp_utc": stamp,
    "supabase_project_ref": rig,
    "browser_project": "chromium",
    "workers": 1,
    "playwright_exit_code": int(pw_exit),
    "verdict": verdict,
    "totals": totals,
    "per_spec": {k: dict(v) for k, v in sorted(per.items())},
    "failures": failures,
}
with open(json_out, "w") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")

lines = [
    f"# fullsoak-2026-08 — daily E2E run {stamp}",
    "",
    f"Target: side rig `{rig}` + local CI-parity worker. chromium, workers=1.",
    "This closes the gap where CI's path-gated `e2e` job reports green without",
    "running the suite, so `cross-tenant.spec.ts` (G4 / CC6.1) never executed",
    "during the soak.",
    "",
    f"**E2E_DAILY: {verdict}** — {totals['passed']} passed / {totals['failed']} failed / "
    f"{totals['skipped']} skipped / {totals['flaky']} flaky (playwright exit {pw_exit})",
    "",
    "| Spec | Passed | Failed | Skipped | Flaky |",
    "|---|---|---|---|---|",
]
for spec, counts in sorted(per.items()):
    lines.append(f"| `{spec}` | {counts['passed']} | {counts['failed']} | "
                 f"{counts['skipped']} | {counts['flaky']} |")

if failures:
    lines += ["", "## Failures", "", "| Spec | Test | Status | First error line |", "|---|---|---|---|"]
    for f in failures:
        err = f["error"].replace("|", "\\|")[:200]
        lines.append(f"| `{f['file']}` | {f['title']} | {f['status']} | {err} |")

lines += ["", "_Excluded specs and the reason for each are listed in "
          "`scripts/staging/fullsoak-e2e-daily.sh`._", ""]

with open(md_out, "w") as fh:
    fh.write("\n".join(lines))

print("\n".join(lines[:12]))
PY

VERDICT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["verdict"])' "$JSON_OUT")"
echo
echo "Evidence: $MD_OUT"
echo "          $JSON_OUT"

if [ "$VERDICT" != "PASS" ]; then
  echo "E2E_DAILY: FAIL — see $MD_OUT" >&2
  tail -n 60 "$RAW_LOG" >&2
  exit 1
fi
echo "E2E_DAILY: PASS"
exit 0
