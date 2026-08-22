#!/usr/bin/env bash
# scripts/staging/fullsoak-daily-check.sh
#
# Daily rig/prod soak-integrity + parity check for the 2026-08 7-day
# full-functionality soak (SOC 2 Type 2 standard).
#
# Implements SOAK-PREMORTEM-SOC2-2026-08-11 BL-1 **criterion 4** — "the same
# comparisons are re-run and recorded EVERY soak day, and any divergence is
# logged as an evidence-invalidating event ON THE DAY IT OCCURS, not discovered
# at Day 7" — and is the instrument behind rollback trigger **R13**.
#
# It is READ-ONLY against all infrastructure. It never mutates Cloud Run,
# Supabase, Cloud Scheduler, Cloud Monitoring, Secret Manager or GitHub. It
# never schedules itself; wiring the cron/launchd entry is a separate,
# deliberate act by the session that owns the soak clock.
#
# ── DEPENDENCIES ─────────────────────────────────────────────────────────────
#   gcloud   (auth'd; export CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.14/bin/python3.14)
#   gh       (auth'd, for `gh variable get`)
#   curl, python3
# No repo/node/npm dependency. Bash 3.2 compatible (stock macOS /bin/bash).
#
# ── SECRET HYGIENE ───────────────────────────────────────────────────────────
# The Supabase service-role key and URL are read from Secret Manager into shell
# variables and handed to curl through a mode-0600 `--config` file so they never
# appear in argv (`ps`), in shell history, or in any artifact. Rig env vars are
# dumped as NAMES + non-secret VALUES only; anything backed by a secretKeyRef is
# rendered as `-> SECRET_REF: <secret-name> key=<version>`. No output file, and
# no line this script prints, ever contains a secret value.
#
# ── USAGE ────────────────────────────────────────────────────────────────────
#   ./scripts/staging/fullsoak-daily-check.sh              # daily check (default)
#   ./scripts/staging/fullsoak-daily-check.sh --day0       # capture Day-0 baselines
#   ./scripts/staging/fullsoak-daily-check.sh --day0 --force
#   ./scripts/staging/fullsoak-daily-check.sh --help
#
# Exit code: 0 on DAILY_PARITY: PASS, 1 on DAILY_PARITY: FAIL, 2 on harness error.

set -uo pipefail

# ═════════════════════════════════════════════════════════════════════════════
# CONFIG BLOCK — the asserted, frozen state of the soak period.
# Every value here is an EXPECTATION, not an observation. Changing one is a
# deliberate act that must be justified in the soak log.
# ═════════════════════════════════════════════════════════════════════════════

# The build under soak. Rig and prod must BOTH serve exactly this.
EXPECT_GIT_SHA="${EXPECT_GIT_SHA:-f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58}"
# 2026-08-12: one authorized freeze-break deploy moved the rig from 00012-f45 to
# 00013-mrw (same image digest; env delta BITCOIN_UTXO_PROVIDER mempool->getblock
# plus the fullsoak-btc-rpc VPC connector). The 00012-era baselines are retained
# under day0-snapshots/superseded-by-00013/.
EXPECT_RIG_REVISION="${EXPECT_RIG_REVISION:-arkova-worker-fullsoak-2026-08-staging-00013-mrw}"
EXPECT_IMAGE_DIGEST="${EXPECT_IMAGE_DIGEST:-sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18}"
# The rig now serves 100% from LATEST rather than a pinned revision name, so A4
# asserts (latestReadyRevisionName == EXPECT_RIG_REVISION) AND (traffic is
# latestRevision:true at 100%) rather than a pinned-name match, which would go
# green on a stale pin the moment a new revision became latest.
EXPECT_RIG_TRAFFIC_MODE="${EXPECT_RIG_TRAFFIC_MODE:-LATEST@100}"

# Detailed health (SCRUM-2653). `/health?detailed=true` is gated by a shared
# secret sent as the `X-Health-Token` header; an unauthorized request silently
# degrades to the compact body at HTTP 200, so A16 proves it got the detailed
# shape before asserting on it.
HEALTH_DETAIL_TOKEN_SECRET="${HEALTH_DETAIL_TOKEN_SECRET:-health-detail-token-fullsoak-2026-08-staging}"

# Bitcoin RPC node. The rig now reaches bitcoind over the fullsoak-btc-rpc VPC
# connector (BITCOIN_UTXO_PROVIDER=getblock), so the soak depends on this VM.
RPC_VM_NAME="${RPC_VM_NAME:-arkova-s33-rig-b1-bitcoin-core-signet}"
RPC_VM_ZONE="${RPC_VM_ZONE:-us-central1-a}"
RPC_VM_CONTAINER="${RPC_VM_CONTAINER:-arkova-rig-b1-bitcoin-core}"
RPC_VM_BITCOIN_CONF="${RPC_VM_BITCOIN_CONF:-/home/bitcoin/.bitcoin/bitcoin.conf}"
RPC_HEIGHT_TOLERANCE_BLOCKS="${RPC_HEIGHT_TOLERANCE_BLOCKS:-2}"
MEMPOOL_SIGNET_TIP_URL="${MEMPOOL_SIGNET_TIP_URL:-https://mempool.space/signet/api/blocks/tip/height}"
# The height probe goes over IAP SSH. It runs ONLY when an SSH key already
# exists locally: `gcloud compute ssh` would otherwise generate one and publish
# it to project metadata, which is a WRITE, and this checker is read-only.
RPC_SSH_KEY="${RPC_SSH_KEY:-$HOME/.ssh/google_compute_engine}"

# Change-freeze switches (premortem §6.1 / §6.3).
EXPECT_DEPLOY_WORKER_PAUSED="${EXPECT_DEPLOY_WORKER_PAUSED:-true}"

# ── EXPECT_SOAK_GATE_DISABLED ────────────────────────────────────────────────
# The soak period requires SOAK_GATE_DISABLED=false: no hour of the period may
# run under the Staging Soak Evidence Gate bypass (premortem §6.3 step 7, R11).
#
# BUT the flip is the LAST action before the clock starts, and it has not
# happened yet. A Day-0 / pre-flip run must therefore assert the CURRENT truth
# ("true") rather than the target ("false"), otherwise every pre-flip run is a
# guaranteed red herring and the operator learns to ignore a FAIL — which is
# exactly how a real divergence gets missed on Day 4.
#
#   Pre-flip  (Day 0, before the clock):  EXPECT_SOAK_GATE_DISABLED=true
#   In-period (from clock start onward):  EXPECT_SOAK_GATE_DISABLED=false
#
# Flip this line to "false" in the same commit/action that runs
# `gh variable set SOAK_GATE_DISABLED --body false`. Overridable per-run via the
# environment for a one-off, but the committed default is what the schedule uses.
EXPECT_SOAK_GATE_DISABLED="${EXPECT_SOAK_GATE_DISABLED:-false}"

# Monitoring: the instruments that make the rig observable (BL-5).
EXPECT_SOAK_ALERT_POLICY_COUNT="${EXPECT_SOAK_ALERT_POLICY_COUNT:-5}"
EXPECT_SOAK_UPTIME_CHECK_COUNT="${EXPECT_SOAK_UPTIME_CHECK_COUNT:-4}"
SOAK_ALERT_POLICY_MATCH="${SOAK_ALERT_POLICY_MATCH:-SOAK }"     # substring of displayName
SOAK_UPTIME_CHECK_MATCH="${SOAK_UPTIME_CHECK_MATCH:-SOAK }"        # prefix of displayName

# Infrastructure coordinates.
GCP_PROJECT="${GCP_PROJECT:-arkova1}"
GCP_REGION="${GCP_REGION:-us-central1}"
RIG_SERVICE="${RIG_SERVICE:-arkova-worker-fullsoak-2026-08-staging}"
RIG_URL="${RIG_URL:-https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app}"
PROD_SERVICE="${PROD_SERVICE:-arkova-worker}"
PROD_URL="${PROD_URL:-https://arkova-worker-270018525501.us-central1.run.app}"
AR_IMAGE_REPO="${AR_IMAGE_REPO:-us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker}"

# Secret Manager secret NAMES (values are never printed or stored).
SB_URL_SECRET="${SB_URL_SECRET:-supabase-url-fullsoak-2026-08-staging}"
SB_KEY_SECRET="${SB_KEY_SECRET:-supabase-service-role-key-fullsoak-2026-08-staging}"

# Supabase project refs (used for the ledger-head parity check, BL-1 criterion 3).
RIG_SUPABASE_REF="${RIG_SUPABASE_REF:-gnkuaywlpmsaezwvlvhk}"
PROD_SUPABASE_REF="${PROD_SUPABASE_REF:-vzwyaatejekddvltxyye}"
# Supabase Management API PAT (sbp_...). `supabase_migrations.schema_migrations`
# is unreachable over PostgREST (PGRST106 — only `public` and `graphql_public`
# are exposed) and no DB password exists in Secret Manager for either ref, so
# the Management API is the only path to the ledger head.
# Resolution order: SUPABASE_ACCESS_TOKEN env var, else Secret Manager secret
# $SUPABASE_ACCESS_TOKEN_SECRET. If neither resolves, A15 reports SKIP — never
# a false PASS.
SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
SUPABASE_ACCESS_TOKEN_SECRET="${SUPABASE_ACCESS_TOKEN_SECRET:-supabase_access}"

# /health uptime sampling. Cloud Run may serve /health from any of up to
# max-instances containers; a freshly scaled-out instance reports a small
# uptime that is NOT a restart. Sample N times and take the MAX, which tracks
# the oldest live instance.
UPTIME_SAMPLES="${UPTIME_SAMPLES:-5}"
UPTIME_SAMPLE_GAP_SECONDS="${UPTIME_SAMPLE_GAP_SECONDS:-2}"

# Evidence layout. Overridable ONLY so the failure paths can be exercised against
# a throwaway tree without touching real soak evidence; the soak itself always
# uses the committed default.
EVID_ROOT_REL="${EVID_ROOT_REL:-docs/staging/evidence/fullsoak-2026-08}"

# ═════════════════════════════════════════════════════════════════════════════
# End of config block. Nothing below is an expectation.
# ═════════════════════════════════════════════════════════════════════════════

MODE="daily"
FORCE=0
ARCHIVE_AS=""
_next_is_archive=0
for arg in "$@"; do
  if [ "$_next_is_archive" -eq 1 ]; then ARCHIVE_AS="$arg"; FORCE=1; _next_is_archive=0; continue; fi
  case "$arg" in
    --day0)  MODE="day0" ;;
    --force) FORCE=1 ;;
    --archive-as) _next_is_archive=1 ;;
    -h|--help)
      sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ── Repo root ────────────────────────────────────────────────────────────────
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "cannot cd to repo root" >&2; exit 2; }

EVID_ROOT="$REPO_ROOT/$EVID_ROOT_REL"
DAY0_DIR="$EVID_ROOT/day0-snapshots"
RUN_DATE="$(date -u +%F)"
RUN_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_STAMP="$(date -u +%H%M%SZ)"
OUT_DIR="$EVID_ROOT/$RUN_DATE"

TMPDIR_RUN="$(mktemp -d "${TMPDIR:-/tmp}/fullsoak-daily.XXXXXX")" || exit 2
cleanup() { rm -rf "$TMPDIR_RUN"; }
trap cleanup EXIT INT TERM

# ── Helpers ──────────────────────────────────────────────────────────────────
die() { echo "FATAL: $*" >&2; exit 2; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum   >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"
  fi
}

# Results accumulator: one TSV row per assertion.
RESULTS_TSV="$TMPDIR_RUN/results.tsv"
: > "$RESULTS_TSV"
DIVERGENCE_MD="$TMPDIR_RUN/divergence.md"
: > "$DIVERGENCE_MD"
FAIL_IDS=""
SKIP_IDS=""
WARN_IDS=""

# Result states: PASS | FAIL (verdict-breaking) | SKIP (could not run) |
# WARN (ran, could not reach a verdict, deliberately non-fatal).
record() { # id | description | expected | observed | result
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >> "$RESULTS_TSV"
  case "$5" in
    FAIL) FAIL_IDS="${FAIL_IDS}${FAIL_IDS:+,}$1" ;;
    SKIP) SKIP_IDS="${SKIP_IDS}${SKIP_IDS:+,}$1" ;;
    WARN) WARN_IDS="${WARN_IDS}${WARN_IDS:+,}$1" ;;
  esac
}

assert_eq() { # id | description | expected | observed
  if [ "$3" = "$4" ]; then record "$1" "$2" "$3" "$4" "PASS"
  else record "$1" "$2" "$3" "$4" "FAIL"; fi
}

emit_diff() { # heading | day0 file | current file
  {
    echo "### $1"
    echo
    if [ ! -f "$2" ]; then
      echo "Day-0 baseline file \`$2\` is **missing**. The hash recorded in"
      echo "\`day0-snapshots/hashes.txt\` cannot be corroborated — treat the baseline as compromised."
    elif diff -q "$2" "$3" >/dev/null 2>&1; then
      echo "**No content difference.** The Day-0 *hash record* and the Day-0 *content file* disagree:"
      echo "the observed state matches \`$(basename "$2")\` byte for byte, but not the sha256 recorded in"
      echo "\`hashes.txt\`. That is baseline corruption or tampering, not infrastructure drift, and it"
      echo "invalidates every comparison made against this baseline until it is reconciled."
    else
      echo '```diff'
      diff -u "$2" "$3" 2>&1 | sed -n '1,200p'
      echo '```'
    fi
    echo
  } >> "$DIVERGENCE_MD"
}

json_get() { # file | python expression on `d`
  python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    print('<unparseable>'); raise SystemExit(0)
try:
    print($2)
except Exception:
    print('<missing>')
" "$1" 2>/dev/null || echo "<error>"
}

# ── Preconditions ────────────────────────────────────────────────────────────
command -v gcloud  >/dev/null 2>&1 || die "gcloud not on PATH"
command -v curl    >/dev/null 2>&1 || die "curl not on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not on PATH"
command -v gh      >/dev/null 2>&1 || die "gh not on PATH"

GCLOUD_ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
[ -n "$GCLOUD_ACCOUNT" ] || die "no active gcloud account"

if [ "$MODE" = "day0" ] && [ -d "$DAY0_DIR" ] && [ "$FORCE" -eq 0 ]; then
  die "Day-0 snapshots already exist at $DAY0_DIR. They are immutable soak evidence.
     Re-capturing invalidates every daily comparison made against them.
     Pass --force only with an explicit, logged reason."
fi

# ═════════════════════════════════════════════════════════════════════════════
# CAPTURE — every probe is read-only.
# ═════════════════════════════════════════════════════════════════════════════
CAP="$TMPDIR_RUN/cap"
mkdir -p "$CAP"

echo "[1/8] rig + prod /health"
RIG_ID_TOKEN="$(gcloud auth print-identity-token --audiences="$RIG_URL" 2>/dev/null)"
[ -n "$RIG_ID_TOKEN" ] || die "could not mint an OIDC identity token for $RIG_URL (account: $GCLOUD_ACCOUNT)"

# Rig health, sampled UPTIME_SAMPLES times; keep the response with max uptime.
: > "$CAP/rig-health-samples.txt"
RIG_UPTIME_MAX=-1
i=0
while [ "$i" -lt "$UPTIME_SAMPLES" ]; do
  i=$((i+1))
  curl -sS -m 30 -H "Authorization: Bearer $RIG_ID_TOKEN" "$RIG_URL/health" \
    > "$CAP/rig-health.$i.json" 2>/dev/null
  u="$(json_get "$CAP/rig-health.$i.json" "d.get('uptime','')")"
  echo "sample $i: uptime=$u status=$(json_get "$CAP/rig-health.$i.json" "d.get('status','')")" \
    >> "$CAP/rig-health-samples.txt"
  case "$u" in
    ''|*[!0-9]*) : ;;
    *) if [ "$u" -gt "$RIG_UPTIME_MAX" ]; then RIG_UPTIME_MAX="$u"; cp "$CAP/rig-health.$i.json" "$CAP/rig-health.json"; fi ;;
  esac
  [ "$i" -lt "$UPTIME_SAMPLES" ] && sleep "$UPTIME_SAMPLE_GAP_SECONDS"
done
[ -f "$CAP/rig-health.json" ] || cp "$CAP/rig-health.1.json" "$CAP/rig-health.json" 2>/dev/null

curl -sS -m 30 "$PROD_URL/health" > "$CAP/prod-health.json" 2>/dev/null

RIG_GIT_SHA="$(json_get "$CAP/rig-health.json" "d.get('git_sha','<missing>')")"
RIG_STATUS="$(json_get "$CAP/rig-health.json" "d.get('status','<missing>')")"
RIG_NETWORK="$(json_get "$CAP/rig-health.json" "d.get('network','<missing>')")"
PROD_GIT_SHA="$(json_get "$CAP/prod-health.json" "d.get('git_sha','<missing>')")"
PROD_STATUS="$(json_get "$CAP/prod-health.json" "d.get('status','<missing>')")"
PROD_UPTIME="$(json_get "$CAP/prod-health.json" "d.get('uptime','<missing>')")"

echo "[2/8] Cloud Run revisions + image digests"
gcloud run services describe "$RIG_SERVICE" --region="$GCP_REGION" --project="$GCP_PROJECT" \
  --format=json > "$CAP/rig-service.json" 2>/dev/null
gcloud run services describe "$PROD_SERVICE" --region="$GCP_REGION" --project="$GCP_PROJECT" \
  --format=json > "$CAP/prod-service.json" 2>/dev/null

serving_revision() { # service json -> revision carrying the largest traffic percent
  python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
t=d.get('status',{}).get('traffic',[]) or []
t=[x for x in t if x.get('revisionName')]
if not t: print('<none>'); raise SystemExit(0)
best=max(t,key=lambda x:x.get('percent',0) or 0)
print(best['revisionName'])
" "$1" 2>/dev/null || echo "<error>"
}
latest_ready() { # service json -> status.latestReadyRevisionName
  json_get "$1" "d.get('status',{}).get('latestReadyRevisionName','<missing>')"
}
traffic_mode() { # service json -> "LATEST@<pct>" or "PINNED:<name>@<pct>"
  python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
t=d.get('status',{}).get('traffic',[]) or []
t=[x for x in t if x.get('revisionName')]
if not t: print('<none>'); raise SystemExit(0)
best=max(t,key=lambda x:x.get('percent',0) or 0)
pct=best.get('percent',0) or 0
if best.get('latestRevision') is True:
    print('LATEST@%d' % pct)
else:
    print('PINNED:%s@%d' % (best.get('revisionName'), pct))
" "$1" 2>/dev/null || echo "<error>"
}
RIG_REVISION="$(serving_revision "$CAP/rig-service.json")"
PROD_REVISION="$(serving_revision "$CAP/prod-service.json")"
RIG_LATEST_READY="$(latest_ready "$CAP/rig-service.json")"
RIG_TRAFFIC_MODE="$(traffic_mode "$CAP/rig-service.json")"

revision_digest() { # revision name -> sha256:...
  local full
  full="$(gcloud run revisions describe "$1" --region="$GCP_REGION" --project="$GCP_PROJECT" \
          --format='value(status.imageDigest)' 2>/dev/null)"
  case "$full" in
    *@sha256:*) echo "sha256:${full##*@sha256:}" ;;
    sha256:*)   echo "$full" ;;
    "")         echo "<unresolved>" ;;
    *)          echo "$full" ;;
  esac
}
RIG_DIGEST="$(revision_digest "$RIG_REVISION")"
PROD_REV_DIGEST="$(revision_digest "$PROD_REVISION")"

# Prod deploys by TAG (arkova-worker:<git_sha>). Resolve that tag in Artifact
# Registry to the digest it actually points at — a matching tag string is not
# evidence (premortem BL-1 criterion 2).
PROD_TAG_DIGEST="$(gcloud artifacts docker images describe \
    "${AR_IMAGE_REPO}:${PROD_GIT_SHA}" --format='value(image_summary.digest)' 2>/dev/null)"
[ -n "$PROD_TAG_DIGEST" ] || PROD_TAG_DIGEST="<unresolved>"

echo "[3/8] rig env dump (names + non-secret values only)"
python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
try:
    c=d['spec']['template']['spec']['containers'][0]
except Exception:
    print('<no container spec>'); raise SystemExit(0)
out=[]
for e in c.get('env',[]) or []:
    n=e.get('name')
    if 'value' in e:
        out.append('%s = %s' % (n, e['value']))
    else:
        ref=(e.get('valueFrom') or {}).get('secretKeyRef') or {}
        out.append('%s -> SECRET_REF: %s key=%s' % (n, ref.get('name'), ref.get('key')))
r=c.get('resources',{}) or {}
out.append('__resources.limits = %s' % json.dumps(r.get('limits',{}), sort_keys=True))
ann=(d.get('spec',{}).get('template',{}).get('metadata',{}) or {}).get('annotations',{}) or {}
for k in ('autoscaling.knative.dev/minScale','autoscaling.knative.dev/maxScale',
          'run.googleapis.com/execution-environment',
          'run.googleapis.com/vpc-access-connector','run.googleapis.com/vpc-access-egress'):
    out.append('__annotation.%s = %s' % (k, ann.get(k)))
for line in sorted(out):
    print(line)
" "$CAP/rig-service.json" > "$CAP/rig-env-dump.txt" 2>/dev/null

echo "[4/8] GitHub repository variables"
GH_DEPLOY_PAUSED="$(gh variable get DEPLOY_WORKER_PAUSED 2>/dev/null | tr -d '\r\n')"
[ -n "$GH_DEPLOY_PAUSED" ] || GH_DEPLOY_PAUSED="<unreadable>"
GH_SOAK_GATE="$(gh variable get SOAK_GATE_DISABLED 2>/dev/null | tr -d '\r\n')"
[ -n "$GH_SOAK_GATE" ] || GH_SOAK_GATE="<unreadable>"

echo "[5/8] switchboard_flags (Supabase REST; service key never enters argv)"
FLAG_MATERIAL="$CAP/switchboard-flags-material.txt"
FLAG_FULL="$CAP/switchboard-flags-full.tsv"
FLAG_ROWS="<unreadable>"
FLAG_HASH_MATERIAL="<unreadable>"
FLAG_HASH_FULL="<unreadable>"

SB_URL_VAL="$(gcloud secrets versions access latest --secret="$SB_URL_SECRET" --project="$GCP_PROJECT" 2>/dev/null)"
SB_KEY_VAL="$(gcloud secrets versions access latest --secret="$SB_KEY_SECRET" --project="$GCP_PROJECT" 2>/dev/null)"
if [ -n "$SB_URL_VAL" ] && [ -n "$SB_KEY_VAL" ]; then
  CURLRC="$TMPDIR_RUN/sb.curlrc"
  ( umask 077; {
      printf 'header = "apikey: %s"\n' "$SB_KEY_VAL"
      printf 'header = "Authorization: Bearer %s"\n' "$SB_KEY_VAL"
      printf 'url = "%s/rest/v1/switchboard_flags?select=flag_key,enabled,updated_at&order=flag_key.asc"\n' "$SB_URL_VAL"
      printf 'silent\nshow-error\nmax-time = 30\n'
    } > "$CURLRC" )
  curl -K "$CURLRC" > "$CAP/switchboard-flags.raw.json" 2>/dev/null
  rm -f "$CURLRC"
  unset SB_KEY_VAL SB_URL_VAL

  python3 -c "
import json,sys,hashlib
try:
    rows=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(3)
if not isinstance(rows,list): sys.exit(3)
rows.sort(key=lambda r: r.get('flag_key') or '')
mat=['%s|%s' % (r.get('flag_key'), r.get('enabled')) for r in rows]
full=['%s|%s|%s' % (r.get('flag_key'), r.get('enabled'), r.get('updated_at')) for r in rows]
open(sys.argv[2],'w').write('\n'.join(mat)+'\n')
open(sys.argv[3],'w').write('\n'.join(full)+'\n')
print(len(rows))
print(hashlib.sha256(('\n'.join(mat)+'\n').encode()).hexdigest())
print(hashlib.sha256(('\n'.join(full)+'\n').encode()).hexdigest())
" "$CAP/switchboard-flags.raw.json" "$FLAG_MATERIAL" "$FLAG_FULL" > "$CAP/flaghash.txt" 2>/dev/null
  if [ -s "$CAP/flaghash.txt" ]; then
    FLAG_ROWS="$(sed -n 1p "$CAP/flaghash.txt")"
    FLAG_HASH_MATERIAL="$(sed -n 2p "$CAP/flaghash.txt")"
    FLAG_HASH_FULL="$(sed -n 3p "$CAP/flaghash.txt")"
  fi
  # The raw response is discarded; only the derived non-secret projections are kept.
  rm -f "$CAP/switchboard-flags.raw.json"
fi

echo "[6/8] Cloud Scheduler census"
gcloud scheduler jobs list --location="$GCP_REGION" --project="$GCP_PROJECT" \
  --format='value(name,schedule,state,timeZone)' 2>/dev/null \
  | sed "s|^projects/[^/]*/locations/[^/]*/jobs/||" \
  | tr '\t' '|' | sort > "$CAP/scheduler-census.txt"
SCHED_TOTAL="$(wc -l < "$CAP/scheduler-census.txt" | tr -d ' ')"
SCHED_RIG="$(grep -c "^${RIG_SERVICE}-" "$CAP/scheduler-census.txt" 2>/dev/null | tr -d ' ')"
SCHED_HASH="$(sha256_file "$CAP/scheduler-census.txt")"

echo "[7/8] Cloud Monitoring alert policies + uptime checks"
MON_TOKEN="$(gcloud auth print-access-token 2>/dev/null)"
MON_CENSUS="$CAP/monitoring-census.txt"
: > "$MON_CENSUS"
SOAK_POLICY_COUNT="<unreadable>"; SOAK_POLICY_ENABLED="<unreadable>"
SOAK_UPTIME_COUNT="<unreadable>"; SOAK_UPTIME_ENABLED="<unreadable>"
if [ -n "$MON_TOKEN" ]; then
  MONRC="$TMPDIR_RUN/mon.curlrc"
  ( umask 077; {
      printf 'header = "Authorization: Bearer %s"\n' "$MON_TOKEN"
      printf 'silent\nshow-error\nmax-time = 45\n'
    } > "$MONRC" )
  curl -K "$MONRC" "https://monitoring.googleapis.com/v3/projects/${GCP_PROJECT}/alertPolicies?pageSize=200" \
    > "$CAP/alert-policies.json" 2>/dev/null
  curl -K "$MONRC" "https://monitoring.googleapis.com/v3/projects/${GCP_PROJECT}/uptimeCheckConfigs?pageSize=200" \
    > "$CAP/uptime-checks.json" 2>/dev/null
  rm -f "$MONRC"; unset MON_TOKEN

  python3 -c "
import json,sys
pol_f,up_f,match_pol,match_up,out_f = sys.argv[1:6]
lines=[]; res={}
try:
    pols=json.load(open(pol_f)).get('alertPolicies',[])
except Exception:
    pols=[]
sel=[p for p in pols if match_pol in (p.get('displayName') or '')]
sel.sort(key=lambda p: p.get('displayName') or '')
for p in sel:
    lines.append('ALERT_POLICY|%s|enabled=%s' % (p.get('displayName'), p.get('enabled')))
res['pol_count']=len(sel)
res['pol_enabled']=sum(1 for p in sel if p.get('enabled') is True)
try:
    ups=json.load(open(up_f)).get('uptimeCheckConfigs',[])
except Exception:
    ups=[]
selu=[u for u in ups if (u.get('displayName') or '').startswith(match_up)]
selu.sort(key=lambda u: u.get('displayName') or '')
for u in selu:
    lines.append('UPTIME_CHECK|%s|enabled=%s|period=%s' % (u.get('displayName'), not u.get('disabled', False), u.get('period')))
res['up_count']=len(selu)
res['up_enabled']=sum(1 for u in selu if not u.get('disabled', False))
open(out_f,'w').write('\n'.join(lines)+'\n')
print(res['pol_count']); print(res['pol_enabled']); print(res['up_count']); print(res['up_enabled'])
" "$CAP/alert-policies.json" "$CAP/uptime-checks.json" "$SOAK_ALERT_POLICY_MATCH" "$SOAK_UPTIME_CHECK_MATCH" "$MON_CENSUS" \
    > "$CAP/moncounts.txt" 2>/dev/null
  if [ -s "$CAP/moncounts.txt" ]; then
    SOAK_POLICY_COUNT="$(sed -n 1p "$CAP/moncounts.txt")"
    SOAK_POLICY_ENABLED="$(sed -n 2p "$CAP/moncounts.txt")"
    SOAK_UPTIME_COUNT="$(sed -n 3p "$CAP/moncounts.txt")"
    SOAK_UPTIME_ENABLED="$(sed -n 4p "$CAP/moncounts.txt")"
  fi
  rm -f "$CAP/alert-policies.json" "$CAP/uptime-checks.json"
fi

echo "[8/8] migration ledger head (Supabase Management API)"
LEDGER_RIG="<skipped>"; LEDGER_PROD="<skipped>"
LEDGER_TOKEN_SOURCE="none"
if [ -n "$SUPABASE_ACCESS_TOKEN" ]; then
  LEDGER_TOKEN_SOURCE="SUPABASE_ACCESS_TOKEN env var"
elif [ -n "$SUPABASE_ACCESS_TOKEN_SECRET" ]; then
  # Only the secret NAME reaches argv; the value is captured into a shell
  # variable and handed to curl through a mode-0600 --config file, exactly as
  # the Supabase service-role key is handled above.
  SUPABASE_ACCESS_TOKEN="$(gcloud secrets versions access latest \
      --secret="$SUPABASE_ACCESS_TOKEN_SECRET" --project="$GCP_PROJECT" 2>/dev/null)"
  [ -n "$SUPABASE_ACCESS_TOKEN" ] && \
    LEDGER_TOKEN_SOURCE="Secret Manager ${GCP_PROJECT}/${SUPABASE_ACCESS_TOKEN_SECRET}"
fi
if [ -n "$SUPABASE_ACCESS_TOKEN" ]; then
  ledger_head() { # project ref
    local rc="$TMPDIR_RUN/sbmgmt.curlrc"
    ( umask 077; {
        printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ACCESS_TOKEN"
        printf 'header = "Content-Type: application/json"\n'
        printf 'silent\nshow-error\nmax-time = 30\n'
      } > "$rc" )
    curl -K "$rc" -X POST "https://api.supabase.com/v1/projects/$1/database/query" \
      --data '{"query":"select max(version) as head from supabase_migrations.schema_migrations where version ~ '"'"'^[0-9]{4}$'"'"'"}' \
      2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print((d[0] if isinstance(d,list) and d else {}).get('head','<none>'))
except Exception:
    print('<error>')
"
    rm -f "$rc"
  }
  LEDGER_RIG="$(ledger_head "$RIG_SUPABASE_REF")"
  LEDGER_PROD="$(ledger_head "$PROD_SUPABASE_REF")"
  unset SUPABASE_ACCESS_TOKEN
fi

echo "[9/10] rig detailed health (X-Health-Token; token never enters argv)"
DH_AUTHORIZED="no"; DH_DRAIN_STALLED="<unreadable>"; DH_LAST_SECURED="<unreadable>"
DH_FEE_RATE="<unreadable>"; DH_DRAIN_REASON="<unreadable>"; DH_PENDING="<unreadable>"
DH_LAST_BATCH="<unreadable>"; DH_ANCHORING_STATUS="<unreadable>"
HEALTH_TOKEN_VAL="$(gcloud secrets versions access latest \
    --secret="$HEALTH_DETAIL_TOKEN_SECRET" --project="$GCP_PROJECT" 2>/dev/null)"
if [ -n "$HEALTH_TOKEN_VAL" ]; then
  DHRC="$TMPDIR_RUN/dh.curlrc"
  ( umask 077; {
      printf 'header = "Authorization: Bearer %s"\n' "$RIG_ID_TOKEN"
      printf 'header = "X-Health-Token: %s"\n' "$HEALTH_TOKEN_VAL"
      printf 'url = "%s/health?detailed=true"\n' "$RIG_URL"
      printf 'silent\nshow-error\nmax-time = 40\n'
    } > "$DHRC" )
  curl -K "$DHRC" > "$CAP/detailed-health.raw.json" 2>/dev/null
  rm -f "$DHRC"; unset HEALTH_TOKEN_VAL

  # Redacted projection. `connection` is dropped on purpose: it is the Supabase
  # project ref/URL, and the whole reason /health?detailed=true is gated
  # (SCRUM-2653) is that it is an information-disclosure surface. The soak needs
  # the anchoring block, not the connection block.
  python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(3)
a=d.get('checks',{}).get('anchoring')
# An unauthorized detailed request degrades to the COMPACT body at HTTP 200,
# where checks.anchoring is the bare status string. Only a dict proves the
# detailed view was actually served.
authorized = isinstance(a, dict)
proj={
 'authorized': authorized,
 'detail_field': d.get('detail'),
 'status': d.get('status'),
 'git_sha': d.get('git_sha'),
 'uptime': d.get('uptime'),
 'network': d.get('network'),
 'anchoring': a if authorized else {'<compact>': a},
 'kms': d.get('checks',{}).get('kms') if authorized else None,
 'info': d.get('info'),
 '_redacted': ['connection (Supabase project ref/URL — deliberately not written to evidence)'],
}
open(sys.argv[2],'w').write(json.dumps(proj, indent=2, sort_keys=True)+'\n')
if not authorized:
    print('no'); raise SystemExit(0)
print('yes')
print(a.get('drainStalled'))
print(a.get('lastSecuredAt'))
print(a.get('feeRateSatVb'))
print(a.get('drainReason'))
print(a.get('pendingCount'))
print(a.get('lastBatchAt'))
print(a.get('status'))
" "$CAP/detailed-health.raw.json" "$CAP/detailed-health.json" > "$CAP/dh.txt" 2>/dev/null
  rm -f "$CAP/detailed-health.raw.json"
  if [ -s "$CAP/dh.txt" ]; then
    DH_AUTHORIZED="$(sed -n 1p "$CAP/dh.txt")"
    if [ "$DH_AUTHORIZED" = "yes" ]; then
      DH_DRAIN_STALLED="$(sed -n 2p "$CAP/dh.txt")"
      DH_LAST_SECURED="$(sed -n 3p "$CAP/dh.txt")"
      DH_FEE_RATE="$(sed -n 4p "$CAP/dh.txt")"
      DH_DRAIN_REASON="$(sed -n 5p "$CAP/dh.txt")"
      DH_PENDING="$(sed -n 6p "$CAP/dh.txt")"
      DH_LAST_BATCH="$(sed -n 7p "$CAP/dh.txt")"
      DH_ANCHORING_STATUS="$(sed -n 8p "$CAP/dh.txt")"
    fi
  fi
fi

echo "[10/10] bitcoin RPC node liveness"
RPC_VM_STATUS="$(gcloud compute instances describe "$RPC_VM_NAME" --zone="$RPC_VM_ZONE" \
    --project="$GCP_PROJECT" --format='value(status)' 2>/dev/null)"
[ -n "$RPC_VM_STATUS" ] || RPC_VM_STATUS="<unreadable>"

RPC_TIP_HEIGHT="$(curl -sS -m 25 "$MEMPOOL_SIGNET_TIP_URL" 2>/dev/null | tr -d '[:space:]')"
case "$RPC_TIP_HEIGHT" in ''|*[!0-9]*) RPC_TIP_HEIGHT="<unreadable>" ;; esac

RPC_NODE_HEIGHT="<not-probed>"
RPC_PROBE_NOTE="not attempted"
if [ ! -f "$RPC_SSH_KEY" ]; then
  RPC_PROBE_NOTE="no pre-existing SSH key at $RPC_SSH_KEY — NOT generating one, because \`gcloud compute ssh\` publishes a new key to project metadata and this checker is read-only"
elif [ "$RPC_VM_STATUS" != "RUNNING" ]; then
  RPC_PROBE_NOTE="VM is not RUNNING ($RPC_VM_STATUS) — height probe skipped"
else
  RPC_PROBE_NOTE="IAP SSH -> docker exec $RPC_VM_CONTAINER bitcoin-cli -signet getblockcount"
  RPC_NODE_HEIGHT="$(gcloud compute ssh "$RPC_VM_NAME" --zone="$RPC_VM_ZONE" --project="$GCP_PROJECT" \
      --tunnel-through-iap --quiet \
      --command="docker exec $RPC_VM_CONTAINER bitcoin-cli -signet -conf=$RPC_VM_BITCOIN_CONF getblockcount" \
      -- -o StrictHostKeyChecking=no -o ConnectTimeout=20 -o BatchMode=yes </dev/null 2>/dev/null \
      | tr -d '[:space:]')"
  case "$RPC_NODE_HEIGHT" in
    ''|*[!0-9]*) RPC_NODE_HEIGHT="<unreachable>"
                 RPC_PROBE_NOTE="IAP SSH or bitcoin-cli unavailable (non-fatal)" ;;
  esac
fi

# ═════════════════════════════════════════════════════════════════════════════
# DAY-0 MODE — freeze the baselines and stop.
# ═════════════════════════════════════════════════════════════════════════════
if [ "$MODE" = "day0" ]; then
  mkdir -p "$DAY0_DIR" || die "cannot create $DAY0_DIR"

  # Archive the outgoing baseline set rather than destroying it: the 00012-era
  # snapshots are the evidence of what the 00012-era daily runs were compared
  # against, and deleting them would orphan those reports.
  if [ -n "$ARCHIVE_AS" ]; then
    ARCH_DIR="$DAY0_DIR/superseded-by-$ARCHIVE_AS"
    mkdir -p "$ARCH_DIR/day0" || die "cannot create $ARCH_DIR"
    for f in rig-env-dump.txt scheduler-census.txt monitoring-census.txt \
             switchboard-flags-material.txt switchboard-flags-full.tsv \
             hashes.txt uptime-baseline.json build-baseline.txt README.md; do
      [ -f "$DAY0_DIR/$f" ] && mv "$DAY0_DIR/$f" "$ARCH_DIR/day0/$f"
    done
    echo "archived previous Day-0 baseline -> $ARCH_DIR/day0/"
  fi

  cp "$CAP/rig-env-dump.txt"          "$DAY0_DIR/rig-env-dump.txt"
  cp "$CAP/scheduler-census.txt"      "$DAY0_DIR/scheduler-census.txt"
  cp "$MON_CENSUS"                    "$DAY0_DIR/monitoring-census.txt"
  [ -f "$FLAG_MATERIAL" ] && cp "$FLAG_MATERIAL" "$DAY0_DIR/switchboard-flags-material.txt"
  [ -f "$FLAG_FULL" ]     && cp "$FLAG_FULL"     "$DAY0_DIR/switchboard-flags-full.tsv"

  cat > "$DAY0_DIR/hashes.txt" <<EOF
# Day-0 baseline hashes — fullsoak-2026-08
# Captured $RUN_TS by $GCLOUD_ACCOUNT via $(basename "$SCRIPT_PATH")
rig_env_dump_sha256=$(sha256_file "$DAY0_DIR/rig-env-dump.txt")
scheduler_census_sha256=$SCHED_HASH
scheduler_jobs_total=$SCHED_TOTAL
scheduler_jobs_rig_scoped=$SCHED_RIG
switchboard_flags_rows=$FLAG_ROWS
switchboard_flags_material_sha256=$FLAG_HASH_MATERIAL
switchboard_flags_full_sha256=$FLAG_HASH_FULL
monitoring_census_sha256=$(sha256_file "$DAY0_DIR/monitoring-census.txt")
soak_alert_policies=$SOAK_POLICY_COUNT
soak_alert_policies_enabled=$SOAK_POLICY_ENABLED
soak_uptime_checks=$SOAK_UPTIME_COUNT
soak_uptime_checks_enabled=$SOAK_UPTIME_ENABLED
EOF

  cat > "$DAY0_DIR/uptime-baseline.json" <<EOF
{
  "captured_at": "$RUN_TS",
  "rig_service": "$RIG_SERVICE",
  "rig_revision": "$RIG_REVISION",
  "rig_uptime_seconds": $RIG_UPTIME_MAX,
  "samples": $UPTIME_SAMPLES,
  "sampling_note": "max uptime across $UPTIME_SAMPLES samples; Cloud Run may serve /health from any live instance, so max tracks the oldest instance rather than a scaled-out one",
  "prod_uptime_seconds_informational": "$PROD_UPTIME"
}
EOF

  cat > "$DAY0_DIR/detailed-health-baseline.json" <<EOF
{
  "captured_at": "$RUN_TS",
  "rig_revision": "$RIG_REVISION",
  "authorized": "$DH_AUTHORIZED",
  "lastSecuredAt": "$DH_LAST_SECURED",
  "lastBatchAt": "$DH_LAST_BATCH",
  "drainStalled": "$DH_DRAIN_STALLED",
  "drainReason": "$DH_DRAIN_REASON",
  "pendingCount": "$DH_PENDING",
  "feeRateSatVb": "$DH_FEE_RATE",
  "anchoring_status": "$DH_ANCHORING_STATUS",
  "seed_note": "lastSecuredAt seeds the A16c advancement check. The first DAILY run on a LATER UTC date is the first one that can assert advancement; a same-date run reports SKIP rather than comparing against a value captured minutes earlier."
}
EOF

  cat > "$DAY0_DIR/rpc-node-baseline.json" <<EOF
{
  "captured_at": "$RUN_TS",
  "vm_name": "$RPC_VM_NAME",
  "vm_zone": "$RPC_VM_ZONE",
  "vm_status": "$RPC_VM_STATUS",
  "container": "$RPC_VM_CONTAINER",
  "node_block_height": "$RPC_NODE_HEIGHT",
  "mempool_signet_tip": "$RPC_TIP_HEIGHT",
  "tolerance_blocks": $RPC_HEIGHT_TOLERANCE_BLOCKS,
  "probe_note": "$RPC_PROBE_NOTE"
}
EOF

  cat > "$DAY0_DIR/build-baseline.txt" <<EOF
# Day-0 build baseline — fullsoak-2026-08 (captured $RUN_TS)
rig_git_sha=$RIG_GIT_SHA
prod_git_sha=$PROD_GIT_SHA
rig_revision=$RIG_REVISION
rig_latest_ready_revision=$RIG_LATEST_READY
rig_traffic_mode=$RIG_TRAFFIC_MODE
prod_revision=$PROD_REVISION
rig_image_digest=$RIG_DIGEST
prod_revision_image_digest=$PROD_REV_DIGEST
prod_tag_resolved_digest=$PROD_TAG_DIGEST
rig_network=$RIG_NETWORK
deploy_worker_paused=$GH_DEPLOY_PAUSED
soak_gate_disabled=$GH_SOAK_GATE
ledger_head_rig=$LEDGER_RIG
ledger_head_prod=$LEDGER_PROD
rpc_vm_status=$RPC_VM_STATUS
rpc_node_block_height=$RPC_NODE_HEIGHT
mempool_signet_tip=$RPC_TIP_HEIGHT
EOF

  cat > "$DAY0_DIR/README.md" <<EOF
# Day-0 snapshots — fullsoak-2026-08

Captured **$RUN_TS** by \`$GCLOUD_ACCOUNT\` with
\`scripts/staging/fullsoak-daily-check.sh --day0\`.

These files are the **immutable** comparison basis for every daily
rig/prod parity check (premortem BL-1 criterion 4, rollback trigger R13).
Re-capturing them invalidates every comparison already made against them;
the script refuses to overwrite without \`--force\`.

| File | What it pins |
|---|---|
| \`rig-env-dump.txt\` | Rig Cloud Run env var names + non-secret values; secret-backed vars appear as \`-> SECRET_REF: <name>\` only. Also pins CPU/memory limits and min/max scale. |
| \`switchboard-flags-material.txt\` | \`flag_key\|enabled\` for every row, sorted. The behaviour-bearing projection. |
| \`switchboard-flags-full.tsv\` | Same plus \`updated_at\`, for forensics when the material hash moves. |
| \`scheduler-census.txt\` | \`name\|schedule\|state\|timeZone\` for every Cloud Scheduler job in \`$GCP_REGION\` (rig **and** prod). |
| \`monitoring-census.txt\` | The SOAK alert policies and uptime checks, with enabled state. |
| \`uptime-baseline.json\` | Rig \`/health.uptime\` at Day 0 — the floor for the monotonic restart detector. |
| \`detailed-health-baseline.json\` | \`/health?detailed=true\` anchoring block — seeds the A16c \`lastSecuredAt\` advancement check. |
| \`rpc-node-baseline.json\` | bitcoind VM status and block height vs the public signet tip (A17). |
| \`build-baseline.txt\` | git_sha / revision / image digest on both sides, plus the two freeze switches. |
| \`hashes.txt\` | sha256 of each of the above, so a daily run can assert in one comparison. |

**No secret values are present in any file here.** Secret-backed environment
variables are recorded by secret *name* only, and the gated \`connection\` block
of detailed health (Supabase project ref/URL) is dropped before anything is
written.

Superseded baselines live in \`superseded-by-<label>/day0/\`. They are retained,
not deleted: they are what the daily reports of that era were compared against.
EOF

  # Verify — do not assume — that the surfaces expected to be untouched by the
  # redeploy actually are, by diffing the fresh capture against the archive.
  if [ -n "$ARCHIVE_AS" ]; then
    REGEN_NOTE="$DAY0_DIR/superseded-by-$ARCHIVE_AS/REGENERATION-DIFF.md"
    {
      echo "# Baseline regeneration diff — superseded by \`$ARCHIVE_AS\`"
      echo
      echo "Captured $RUN_TS by \`$GCLOUD_ACCOUNT\`. Old = \`superseded-by-$ARCHIVE_AS/day0/\`, new = \`day0-snapshots/\`."
      echo "Every surface below is **verified**, not assumed."
      echo
      for f in scheduler-census.txt switchboard-flags-material.txt switchboard-flags-full.tsv monitoring-census.txt rig-env-dump.txt; do
        old="$DAY0_DIR/superseded-by-$ARCHIVE_AS/day0/$f"; new="$DAY0_DIR/$f"
        echo "## \`$f\`"
        echo
        if [ ! -f "$old" ] || [ ! -f "$new" ]; then
          echo "_one side missing — cannot compare_"
        elif diff -q "$old" "$new" >/dev/null 2>&1; then
          echo "**UNCHANGED** — sha256 \`$(sha256_file "$new")\`"
        else
          echo "**CHANGED**"
          echo
          echo '```diff'
          diff -u "$old" "$new" 2>&1 | sed -n '1,200p'
          echo '```'
        fi
        echo
      done
    } > "$REGEN_NOTE"
    echo
    echo "regeneration diff -> $REGEN_NOTE"
    grep -E '^## |^\*\*(UNCHANGED|CHANGED)' "$REGEN_NOTE" | paste - - 2>/dev/null || true
  fi

  echo
  echo "Day-0 snapshots written to $DAY0_DIR"
  ls -1 "$DAY0_DIR"
  exit 0
fi

# ═════════════════════════════════════════════════════════════════════════════
# DAILY MODE — assert.
# ═════════════════════════════════════════════════════════════════════════════
[ -d "$DAY0_DIR" ] || die "Day-0 snapshots missing at $DAY0_DIR. Run --day0 first."

d0_hash() { grep "^$1=" "$DAY0_DIR/hashes.txt" 2>/dev/null | head -1 | cut -d= -f2-; }
D0_ENV_HASH="$(d0_hash rig_env_dump_sha256)"
D0_SCHED_HASH="$(d0_hash scheduler_census_sha256)"
D0_FLAG_MAT="$(d0_hash switchboard_flags_material_sha256)"
D0_FLAG_FULL="$(d0_hash switchboard_flags_full_sha256)"
D0_MON_HASH="$(d0_hash monitoring_census_sha256)"

# ── Previous recorded uptime: latest prior date dir with uptime.json, else Day-0
PREV_UPTIME=""
PREV_UPTIME_SRC=""
for dir in $(ls -1 "$EVID_ROOT" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -r); do
  [ "$dir" \< "$RUN_DATE" ] || continue
  if [ -f "$EVID_ROOT/$dir/uptime.json" ]; then
    PREV_UPTIME="$(json_get "$EVID_ROOT/$dir/uptime.json" "d.get('rig_uptime_seconds','')")"
    PREV_UPTIME_SRC="$EVID_ROOT_REL/$dir/uptime.json"
    break
  fi
done
if [ -z "$PREV_UPTIME" ] && [ -f "$DAY0_DIR/uptime-baseline.json" ]; then
  PREV_UPTIME="$(json_get "$DAY0_DIR/uptime-baseline.json" "d.get('rig_uptime_seconds','')")"
  PREV_UPTIME_SRC="$EVID_ROOT_REL/day0-snapshots/uptime-baseline.json"
fi

# ── A1..A3 build identity ────────────────────────────────────────────────────
assert_eq A1 "Rig /health.git_sha == frozen soak build"            "$EXPECT_GIT_SHA" "$RIG_GIT_SHA"
assert_eq A2 "Prod /health.git_sha == frozen soak build"           "$EXPECT_GIT_SHA" "$PROD_GIT_SHA"
assert_eq A3 "Rig git_sha == prod git_sha (BL-1 criterion 1)"      "$PROD_GIT_SHA"   "$RIG_GIT_SHA"

# ── A4..A6 revision + digest ─────────────────────────────────────────────────
assert_eq A4  "Rig latestReadyRevision is the frozen one"            "$EXPECT_RIG_REVISION"   "$RIG_LATEST_READY"
assert_eq A4b "Rig traffic routes 100% to LATEST (not a stale pin)" "$EXPECT_RIG_TRAFFIC_MODE" "$RIG_TRAFFIC_MODE"
assert_eq A4c "Revision actually serving == latestReadyRevision"    "$RIG_LATEST_READY"      "$RIG_REVISION"
assert_eq A5 "Rig revision image digest == frozen digest"            "$EXPECT_IMAGE_DIGEST" "$RIG_DIGEST"
assert_eq A6 "Prod tag ${PROD_GIT_SHA} resolves to frozen digest (BL-1 criterion 2)" "$EXPECT_IMAGE_DIGEST" "$PROD_TAG_DIGEST"
assert_eq A6b "Prod serving revision image digest == frozen digest"  "$EXPECT_IMAGE_DIGEST" "$PROD_REV_DIGEST"

# ── A7 uptime monotonicity (restart detector) ────────────────────────────────
if [ "$RIG_UPTIME_MAX" -lt 0 ] 2>/dev/null; then
  record A7 "Rig /health.uptime strictly increasing (no restart)" "> $PREV_UPTIME" "<unreadable>" "FAIL"
elif [ -z "$PREV_UPTIME" ]; then
  record A7 "Rig /health.uptime strictly increasing (no restart)" "> <no prior record>" "$RIG_UPTIME_MAX" "SKIP"
elif [ "$RIG_UPTIME_MAX" -gt "$PREV_UPTIME" ]; then
  record A7 "Rig /health.uptime strictly increasing (no restart)" "> $PREV_UPTIME" "$RIG_UPTIME_MAX" "PASS"
else
  record A7 "Rig /health.uptime strictly increasing (no restart)" "> $PREV_UPTIME" "$RIG_UPTIME_MAX" "FAIL"
  {
    echo "### A7 — rig uptime regressed (restart / revision replacement)"
    echo
    echo "Previous recorded uptime: \`$PREV_UPTIME\` s (from \`$PREV_UPTIME_SRC\`)"
    echo "Observed max uptime this run: \`$RIG_UPTIME_MAX\` s over $UPTIME_SAMPLES samples."
    echo
    echo "The soak clock **is** rig uptime. A regression means the period restarted."
    echo "Per premortem R2, more than one restart in 24 h restarts the day."
    echo
    echo '```'
    cat "$CAP/rig-health-samples.txt"
    echo '```'
    echo
  } >> "$DIVERGENCE_MD"
fi

# ── A8..A9 freeze switches ───────────────────────────────────────────────────
assert_eq A8 "GitHub var DEPLOY_WORKER_PAUSED (prod deploy freeze)" "$EXPECT_DEPLOY_WORKER_PAUSED" "$GH_DEPLOY_PAUSED"
assert_eq A9 "GitHub var SOAK_GATE_DISABLED (evidence-gate bypass)" "$EXPECT_SOAK_GATE_DISABLED"   "$GH_SOAK_GATE"

# ── A10 rig env dump vs Day-0 ────────────────────────────────────────────────
ENV_HASH="$(sha256_file "$CAP/rig-env-dump.txt")"
assert_eq A10 "Rig env dump unchanged vs Day-0" "$D0_ENV_HASH" "$ENV_HASH"
if [ "$ENV_HASH" != "$D0_ENV_HASH" ]; then
  emit_diff "A10 — rig env dump diverged from Day-0" "$DAY0_DIR/rig-env-dump.txt" "$CAP/rig-env-dump.txt"
fi

# ── A11 switchboard_flags hash vs Day-0 ──────────────────────────────────────
assert_eq A11 "switchboard_flags material hash (flag_key|enabled) unchanged vs Day-0" "$D0_FLAG_MAT" "$FLAG_HASH_MATERIAL"
if [ "$FLAG_HASH_MATERIAL" != "$D0_FLAG_MAT" ] && [ -f "$FLAG_MATERIAL" ]; then
  emit_diff "A11 — switchboard_flags diverged from Day-0" "$DAY0_DIR/switchboard-flags-material.txt" "$FLAG_MATERIAL"
fi
# Informational: a full-row hash move with a stable material hash means a row was
# touched (updated_at) without changing behaviour. Reported, never a FAIL.
FLAG_TOUCH_NOTE="none"
if [ "$FLAG_HASH_MATERIAL" = "$D0_FLAG_MAT" ] && [ "$FLAG_HASH_FULL" != "$D0_FLAG_FULL" ]; then
  FLAG_TOUCH_NOTE="row(s) touched (updated_at moved) with no change to any flag_key/enabled pair"
fi

# ── A12 scheduler census vs Day-0 ────────────────────────────────────────────
assert_eq A12 "Cloud Scheduler census unchanged vs Day-0 ($SCHED_TOTAL jobs, $SCHED_RIG rig-scoped)" "$D0_SCHED_HASH" "$SCHED_HASH"
if [ "$SCHED_HASH" != "$D0_SCHED_HASH" ]; then
  emit_diff "A12 — Cloud Scheduler census diverged from Day-0" "$DAY0_DIR/scheduler-census.txt" "$CAP/scheduler-census.txt"
fi

# ── A13..A14 monitoring instruments ──────────────────────────────────────────
assert_eq A13  "SOAK alert policies present"  "$EXPECT_SOAK_ALERT_POLICY_COUNT" "$SOAK_POLICY_COUNT"
assert_eq A13b "SOAK alert policies enabled"  "$EXPECT_SOAK_ALERT_POLICY_COUNT" "$SOAK_POLICY_ENABLED"
assert_eq A14  "SOAK uptime checks present"   "$EXPECT_SOAK_UPTIME_CHECK_COUNT" "$SOAK_UPTIME_COUNT"
assert_eq A14b "SOAK uptime checks enabled"   "$EXPECT_SOAK_UPTIME_CHECK_COUNT" "$SOAK_UPTIME_ENABLED"
MON_HASH="$(sha256_file "$MON_CENSUS")"
MON_NOTE="unchanged"
if [ "$MON_HASH" != "$D0_MON_HASH" ]; then
  MON_NOTE="CHANGED vs Day-0 (informational — the hard assertions are A13/A14)"
  emit_diff "Monitoring census changed vs Day-0 (informational)" "$DAY0_DIR/monitoring-census.txt" "$MON_CENSUS"
fi

# ── A15 migration ledger head parity (optional) ──────────────────────────────
if [ "$LEDGER_RIG" = "<skipped>" ]; then
  record A15 "Migration ledger head parity rig==prod (BL-1 criterion 3 / R13)" \
    "equal" "SKIPPED — no Management API PAT (env or ${GCP_PROJECT}/${SUPABASE_ACCESS_TOKEN_SECRET})" "SKIP"
else
  # A malformed / errored response must never satisfy the equality: two
  # `<error>` values are equal to each other and would otherwise report PASS.
  case "$LEDGER_RIG$LEDGER_PROD" in
    *"<error>"*|*"<none>"*|*"<unparseable>"*|*"<missing>"*)
      record A15 "Migration ledger head parity rig==prod (BL-1 criterion 3 / R13)" \
        "two numeric NNNN heads" "rig=$LEDGER_RIG prod=$LEDGER_PROD" "FAIL" ;;
    *)
      assert_eq A15 "Migration ledger head parity rig==prod (BL-1 criterion 3 / R13)" "$LEDGER_PROD" "$LEDGER_RIG" ;;
  esac
fi

# ── A16 detailed health (SCRUM-2653 gated view) ──────────────────────────────
# An unauthorized detailed request degrades to the compact body at HTTP 200, so
# authorization is proved first; without it every field below would read
# <unreadable> and a naive equality could go green on nothing.
assert_eq A16 "Detailed health authorized (X-Health-Token accepted, detailed shape served)" "yes" "$DH_AUTHORIZED"
if [ "$DH_AUTHORIZED" = "yes" ]; then
  assert_eq A16a "checks.anchoring.drainStalled is false (batch-drain dead-man's-switch)" "False" "$DH_DRAIN_STALLED"

  case "$DH_LAST_SECURED" in
    ''|None|null|'<unreadable>')
      record A16b "checks.anchoring.lastSecuredAt present" "non-null ISO timestamp" "$DH_LAST_SECURED" "FAIL" ;;
    *) record A16b "checks.anchoring.lastSecuredAt present" "non-null ISO timestamp" "$DH_LAST_SECURED" "PASS" ;;
  esac

  case "$DH_FEE_RATE" in
    ''|None|null|'<unreadable>')
      record A16d "checks.anchoring.feeRateSatVb non-null" "non-null number" "$DH_FEE_RATE" "FAIL" ;;
    *) record A16d "checks.anchoring.feeRateSatVb non-null" "non-null number" "$DH_FEE_RATE" "PASS" ;;
  esac

  # A16c — lastSecuredAt must ADVANCE day over day. The comparison basis is the
  # most recent record from a STRICTLY EARLIER UTC date: comparing against a
  # value captured minutes ago (same-date Day-0 seed) would fail every seeding
  # run, which is how an operator learns to ignore this assertion.
  PREV_SECURED=""; PREV_SECURED_SRC=""
  for dir in $(ls -1 "$EVID_ROOT" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -r); do
    [ "$dir" \< "$RUN_DATE" ] || continue
    if [ -f "$EVID_ROOT/$dir/detailed-health.json" ]; then
      PREV_SECURED="$(json_get "$EVID_ROOT/$dir/detailed-health.json" "(d.get('anchoring') or {}).get('lastSecuredAt','')")"
      PREV_SECURED_SRC="$EVID_ROOT_REL/$dir/detailed-health.json"
      break
    fi
  done
  if [ -z "$PREV_SECURED" ] && [ -f "$DAY0_DIR/detailed-health-baseline.json" ]; then
    D0_SECURED_DATE="$(json_get "$DAY0_DIR/detailed-health-baseline.json" "d.get('captured_at','')[:10]")"
    if [ -n "$D0_SECURED_DATE" ] && [ "$D0_SECURED_DATE" \< "$RUN_DATE" ]; then
      PREV_SECURED="$(json_get "$DAY0_DIR/detailed-health-baseline.json" "d.get('lastSecuredAt','')")"
      PREV_SECURED_SRC="$EVID_ROOT_REL/day0-snapshots/detailed-health-baseline.json"
    fi
  fi
  if [ -z "$PREV_SECURED" ]; then
    record A16c "lastSecuredAt advancing vs previous day" \
      "> <no earlier-dated record>" "$DH_LAST_SECURED (seeded this run)" "SKIP"
  elif [ "$DH_LAST_SECURED" \> "$PREV_SECURED" ]; then
    record A16c "lastSecuredAt advancing vs previous day" "> $PREV_SECURED" "$DH_LAST_SECURED" "PASS"
  else
    record A16c "lastSecuredAt advancing vs previous day" "> $PREV_SECURED" "$DH_LAST_SECURED" "FAIL"
    {
      echo "### A16c — lastSecuredAt did not advance"
      echo
      echo "Previous: \`$PREV_SECURED\` (from \`$PREV_SECURED_SRC\`)"
      echo "Observed: \`$DH_LAST_SECURED\`"
      echo
      echo "No document reached SECURED since the previous daily record. The soak's"
      echo "central claim is that the anchor lifecycle completes end to end; a flat"
      echo "\`lastSecuredAt\` means the period is accumulating uptime, not evidence."
      echo "Cross-check \`pendingCount\` (\`$DH_PENDING\`), \`lastBatchAt\` (\`$DH_LAST_BATCH\`)"
      echo "and \`drainReason\` (\`$DH_DRAIN_REASON\`) before treating this as chain-side latency."
      echo
    } >> "$DIVERGENCE_MD"
  fi
fi

# ── A17 bitcoin RPC node liveness ────────────────────────────────────────────
# The rig reaches bitcoind over the fullsoak-btc-rpc VPC connector, so this VM
# is now on the soak's critical path.
assert_eq A17 "RPC node VM $RPC_VM_NAME status" "RUNNING" "$RPC_VM_STATUS"
if [ "$RPC_NODE_HEIGHT" = "<not-probed>" ] || [ "$RPC_NODE_HEIGHT" = "<unreachable>" ] \
   || [ "$RPC_TIP_HEIGHT" = "<unreadable>" ]; then
  record A17b "RPC node height within $RPC_HEIGHT_TOLERANCE_BLOCKS blocks of public signet tip" \
    "|node - tip| <= $RPC_HEIGHT_TOLERANCE_BLOCKS" \
    "node=$RPC_NODE_HEIGHT tip=$RPC_TIP_HEIGHT — $RPC_PROBE_NOTE" "WARN"
else
  RPC_DELTA=$(( RPC_NODE_HEIGHT - RPC_TIP_HEIGHT ))
  [ "$RPC_DELTA" -lt 0 ] && RPC_DELTA=$(( -RPC_DELTA ))
  if [ "$RPC_DELTA" -le "$RPC_HEIGHT_TOLERANCE_BLOCKS" ]; then
    record A17b "RPC node height within $RPC_HEIGHT_TOLERANCE_BLOCKS blocks of public signet tip" \
      "|node - tip| <= $RPC_HEIGHT_TOLERANCE_BLOCKS" "node=$RPC_NODE_HEIGHT tip=$RPC_TIP_HEIGHT delta=$RPC_DELTA" "PASS"
  else
    record A17b "RPC node height within $RPC_HEIGHT_TOLERANCE_BLOCKS blocks of public signet tip" \
      "|node - tip| <= $RPC_HEIGHT_TOLERANCE_BLOCKS" "node=$RPC_NODE_HEIGHT tip=$RPC_TIP_HEIGHT delta=$RPC_DELTA" "FAIL"
  fi
fi

# ── Health status sanity ─────────────────────────────────────────────────────
assert_eq A18 "Rig /health.status"  "healthy" "$RIG_STATUS"
assert_eq A19 "Prod /health.status" "healthy" "$PROD_STATUS"

# ═════════════════════════════════════════════════════════════════════════════
# REPORT
# ═════════════════════════════════════════════════════════════════════════════
mkdir -p "$OUT_DIR" || die "cannot create $OUT_DIR"
REPORT="$OUT_DIR/daily-check.md"
# Append-only directory: never destroy a prior run's report.
if [ -f "$REPORT" ]; then mv "$REPORT" "$OUT_DIR/daily-check.prev-$RUN_STAMP.md"; fi

cp "$CAP/rig-health.json"       "$OUT_DIR/rig-health.json"        2>/dev/null
cp "$CAP/prod-health.json"      "$OUT_DIR/prod-health.json"       2>/dev/null
cp "$CAP/rig-health-samples.txt" "$OUT_DIR/rig-health-samples.txt" 2>/dev/null
cp "$CAP/rig-env-dump.txt"      "$OUT_DIR/rig-env-dump.txt"       2>/dev/null
cp "$CAP/scheduler-census.txt"  "$OUT_DIR/scheduler-census.txt"   2>/dev/null
cp "$MON_CENSUS"                "$OUT_DIR/monitoring-census.txt"  2>/dev/null
[ -f "$FLAG_MATERIAL" ] && cp "$FLAG_MATERIAL" "$OUT_DIR/switchboard-flags-material.txt"
[ -f "$FLAG_FULL" ]     && cp "$FLAG_FULL"     "$OUT_DIR/switchboard-flags-full.tsv"
[ -f "$CAP/detailed-health.json" ] && cp "$CAP/detailed-health.json" "$OUT_DIR/detailed-health.json"

cat > "$OUT_DIR/rpc-node.json" <<EOF
{
  "recorded_at": "$RUN_TS",
  "vm_name": "$RPC_VM_NAME",
  "vm_zone": "$RPC_VM_ZONE",
  "vm_status": "$RPC_VM_STATUS",
  "node_block_height": "$RPC_NODE_HEIGHT",
  "mempool_signet_tip": "$RPC_TIP_HEIGHT",
  "tolerance_blocks": $RPC_HEIGHT_TOLERANCE_BLOCKS,
  "probe_note": "$RPC_PROBE_NOTE"
}
EOF

cat > "$OUT_DIR/uptime.json" <<EOF
{
  "recorded_at": "$RUN_TS",
  "rig_service": "$RIG_SERVICE",
  "rig_revision": "$RIG_REVISION",
  "rig_uptime_seconds": $RIG_UPTIME_MAX,
  "samples": $UPTIME_SAMPLES,
  "previous_uptime_seconds": "${PREV_UPTIME:-null}",
  "previous_source": "${PREV_UPTIME_SRC:-none}"
}
EOF

PASS_N="$(awk -F'\t' '$5=="PASS"' "$RESULTS_TSV" | wc -l | tr -d ' ')"
FAIL_N="$(awk -F'\t' '$5=="FAIL"' "$RESULTS_TSV" | wc -l | tr -d ' ')"
SKIP_N="$(awk -F'\t' '$5=="SKIP"' "$RESULTS_TSV" | wc -l | tr -d ' ')"
WARN_N="$(awk -F'\t' '$5=="WARN"' "$RESULTS_TSV" | wc -l | tr -d ' ')"

{
  echo "# Full-soak daily integrity check — $RUN_DATE"
  echo
  echo "> BL-1 criterion 4 / rollback trigger **R13**: rig↔prod parity re-verified every soak day,"
  echo "> divergence logged the day it occurs. Generated by \`scripts/staging/fullsoak-daily-check.sh\`."
  echo "> **Read-only** against all infrastructure. No secret value appears in this file or any sibling artifact."
  echo
  echo "| Field | Value |"
  echo "|---|---|"
  echo "| Run at (UTC) | \`$RUN_TS\` |"
  echo "| Operator identity | \`$GCLOUD_ACCOUNT\` |"
  echo "| Script sha256 | \`$(sha256_file "$SCRIPT_PATH")\` |"
  echo "| Rig service | \`$RIG_SERVICE\` (\`$GCP_PROJECT\`/\`$GCP_REGION\`) |"
  echo "| Prod service | \`$PROD_SERVICE\` |"
  echo "| Frozen build | \`$EXPECT_GIT_SHA\` |"
  echo "| Frozen digest | \`$EXPECT_IMAGE_DIGEST\` |"
  echo "| \`EXPECT_SOAK_GATE_DISABLED\` | \`$EXPECT_SOAK_GATE_DISABLED\` |"
  echo "| Day-0 baseline | \`$EVID_ROOT_REL/day0-snapshots/\` |"
  echo
  echo "## Assertions"
  echo
  echo "| ID | Assertion | Expected | Observed | Result |"
  echo "|---|---|---|---|---|"
  awk -F'\t' '{printf "| %s | %s | `%s` | `%s` | **%s** |\n", $1, $2, $3, $4, $5}' "$RESULTS_TSV"
  echo
  echo "**$PASS_N PASS / $FAIL_N FAIL / $SKIP_N SKIP / $WARN_N WARN.**"
  echo
  echo "## Observed state"
  echo
  echo "| Item | Rig | Prod |"
  echo "|---|---|---|"
  echo "| \`/health.status\` | \`$RIG_STATUS\` | \`$PROD_STATUS\` |"
  echo "| \`/health.git_sha\` | \`$RIG_GIT_SHA\` | \`$PROD_GIT_SHA\` |"
  echo "| \`/health.network\` | \`$RIG_NETWORK\` | (mainnet, by design) |"
  echo "| \`/health.uptime\` (max of $UPTIME_SAMPLES) | \`$RIG_UPTIME_MAX\` s | \`$PROD_UPTIME\` s (informational) |"
  echo "| Serving revision | \`$RIG_REVISION\` | \`$PROD_REVISION\` |"
  echo "| latestReadyRevision / traffic | \`$RIG_LATEST_READY\` / \`$RIG_TRAFFIC_MODE\` | — |"
  echo "| Revision image digest | \`$RIG_DIGEST\` | \`$PROD_REV_DIGEST\` |"
  echo "| Tag→digest resolution | n/a (deployed by digest) | \`$PROD_TAG_DIGEST\` |"
  echo "| Migration ledger head | \`$LEDGER_RIG\` | \`$LEDGER_PROD\` (PAT source: $LEDGER_TOKEN_SOURCE) |"
  echo
  echo "| Frozen surface | Observed | Day-0 |"
  echo "|---|---|---|"
  echo "| \`DEPLOY_WORKER_PAUSED\` | \`$GH_DEPLOY_PAUSED\` | expected \`$EXPECT_DEPLOY_WORKER_PAUSED\` |"
  echo "| \`SOAK_GATE_DISABLED\` | \`$GH_SOAK_GATE\` | expected \`$EXPECT_SOAK_GATE_DISABLED\` |"
  echo "| Rig env dump sha256 | \`$ENV_HASH\` | \`$D0_ENV_HASH\` |"
  echo "| \`switchboard_flags\` rows | \`$FLAG_ROWS\` | — |"
  echo "| \`switchboard_flags\` material sha256 | \`$FLAG_HASH_MATERIAL\` | \`$D0_FLAG_MAT\` |"
  echo "| \`switchboard_flags\` full sha256 | \`$FLAG_HASH_FULL\` | \`$D0_FLAG_FULL\` |"
  echo "| Scheduler census sha256 | \`$SCHED_HASH\` ($SCHED_TOTAL jobs, $SCHED_RIG rig-scoped) | \`$D0_SCHED_HASH\` |"
  echo "| Monitoring census | \`$MON_HASH\` — $MON_NOTE | \`$D0_MON_HASH\` |"
  echo "| Flag row-touch note | $FLAG_TOUCH_NOTE | — |"
  echo
  echo "### Detailed health (\`/health?detailed=true\`, gated)"
  echo
  echo "| Field | Value |"
  echo "|---|---|"
  echo "| Authorized (detailed shape served) | \`$DH_AUTHORIZED\` |"
  echo "| \`checks.anchoring.status\` | \`$DH_ANCHORING_STATUS\` |"
  echo "| \`checks.anchoring.drainStalled\` | \`$DH_DRAIN_STALLED\` (reason \`$DH_DRAIN_REASON\`) |"
  echo "| \`checks.anchoring.lastSecuredAt\` | \`$DH_LAST_SECURED\` |"
  echo "| \`checks.anchoring.lastBatchAt\` | \`$DH_LAST_BATCH\` |"
  echo "| \`checks.anchoring.pendingCount\` | \`$DH_PENDING\` |"
  echo "| \`checks.anchoring.feeRateSatVb\` | \`$DH_FEE_RATE\` |"
  echo
  echo "The \`connection\` block (Supabase project ref/URL) is **dropped before anything is written** — it is the information-disclosure surface that SCRUM-2653 gated, and the soak has no need of it."
  echo
  echo "### Bitcoin RPC node (\`$RPC_VM_NAME\`, \`$RPC_VM_ZONE\`)"
  echo
  echo "| Field | Value |"
  echo "|---|---|"
  echo "| VM status | \`$RPC_VM_STATUS\` |"
  echo "| Node block height | \`$RPC_NODE_HEIGHT\` |"
  echo "| Public signet tip | \`$RPC_TIP_HEIGHT\` |"
  echo "| Tolerance | $RPC_HEIGHT_TOLERANCE_BLOCKS blocks |"
  echo "| Probe | $RPC_PROBE_NOTE |"
  echo
  if [ -s "$DIVERGENCE_MD" ]; then
    echo "## Divergence detail"
    echo
    cat "$DIVERGENCE_MD"
  fi
  echo "## Artifacts in this directory"
  echo
  for f in $(ls -1 "$OUT_DIR" 2>/dev/null); do
    [ "$f" = "daily-check.md" ] && continue
    echo "- \`$f\` — sha256 \`$(sha256_file "$OUT_DIR/$f")\`"
  done
  echo
  echo "## Interpretation"
  echo
  echo "- **A1–A6b** are BL-1 criteria 1 and 2. A FAIL here is evidence-invalidating from the moment it is true, not from the moment it is noticed."
  echo "- **A4/A4b/A4c** assert \`latestReadyRevision\` **and** that traffic routes to LATEST at 100%, then that the revision actually serving is that same one. A pinned-name-only check would stay green while a newer revision quietly became latest."
  echo "- **A16** proves authorization before asserting on any detailed field. An unauthorized \`?detailed=true\` degrades to the compact body at HTTP 200 (SCRUM-2653), so a naive read would see nulls and could be mistaken for a healthy null."
  echo "- **A16c** compares \`lastSecuredAt\` only against a record from a **strictly earlier UTC date**. Comparing against a same-day seed captured minutes earlier would fail every seeding run, which trains the operator to ignore the assertion."
  echo "- **A17b** is deliberately **non-fatal (WARN)**: the height probe runs over IAP SSH, and it is not run at all unless an SSH key already exists locally — \`gcloud compute ssh\` would otherwise publish a new key to project metadata, which is a write, and this checker is read-only."
  echo "- **A7** is the soak clock. Uptime is sampled $UPTIME_SAMPLES times and the **maximum** is taken: Cloud Run may route \`/health\` to any live instance, so a single low reading is a scale-out, not a restart. A regression of the maximum is a genuine restart of the oldest instance and triggers premortem R2."
  echo "- **A9** compares against \`EXPECT_SOAK_GATE_DISABLED\` in the script's config block, not against a hardcoded \`false\`. Pre-flip (Day 0) that value is \`true\`; it must be changed to \`false\` in the same action that flips the repository variable."
  echo "- **A11** hashes only \`flag_key|enabled\`. A row touched without a behaviour change moves the full-row hash and is reported, not failed."
  echo "- **A13/A14** assert the instruments themselves are alive. A soak with dark alarms produces confident evidence about an unobserved system."
  echo
  echo "## Known gaps"
  echo
  if [ "$LEDGER_RIG" = "<skipped>" ]; then
    echo "- **A15 (ledger-head parity) did not run.** \`supabase_migrations.schema_migrations\` is unreachable over PostgREST (\`PGRST106: Only the following schemas are exposed: public, graphql_public\`) and no database password exists in Secret Manager for \`$RIG_SUPABASE_REF\` or \`$PROD_SUPABASE_REF\`, so the check goes through the Supabase Management API. No PAT resolved — neither the \`SUPABASE_ACCESS_TOKEN\` env var nor Secret Manager secret \`${GCP_PROJECT}/${SUPABASE_ACCESS_TOKEN_SECRET}\`. The assertion reports **SKIP**, never PASS."
  else
    echo "- **A15 (ledger-head parity) is closed.** The check runs against the Supabase Management API using the PAT from **$LEDGER_TOKEN_SOURCE** (name only ever reaches argv; the value is passed to curl through a mode-0600 \`--config\` file). The Management API is used because \`supabase_migrations.schema_migrations\` is unreachable over PostgREST (\`PGRST106: Only the following schemas are exposed: public, graphql_public\`) and no database password exists in Secret Manager for \`$RIG_SUPABASE_REF\` or \`$PROD_SUPABASE_REF\`. Rig head \`$LEDGER_RIG\`, prod head \`$LEDGER_PROD\`. A malformed or errored response fails the assertion rather than satisfying it by equality."
  fi
  echo "- Prod \`switchboard_flags\` are not hashed — only the rig's. Prod flag drift is a separate control."
  echo
  if [ -n "$WARN_IDS" ]; then echo "WARNINGS: $WARN_IDS (non-fatal)"; fi
  if [ -n "$SKIP_IDS" ]; then echo "SKIPPED: $SKIP_IDS"; fi
  if [ -n "$FAIL_IDS" ]; then
    echo "DAILY_PARITY: FAIL — $FAIL_IDS"
  else
    echo "DAILY_PARITY: PASS"
  fi
} > "$REPORT"

# stdout summary
echo
sed -n '/^## Assertions/,/^\*\*/p' "$REPORT"
echo
[ -n "$WARN_IDS" ] && echo "WARNINGS: $WARN_IDS (non-fatal)"
[ -n "$SKIP_IDS" ] && echo "SKIPPED: $SKIP_IDS"
tail -1 "$REPORT"
echo "report: $EVID_ROOT_REL/$RUN_DATE/daily-check.md"

if [ -n "$FAIL_IDS" ]; then exit 1; fi
exit 0
