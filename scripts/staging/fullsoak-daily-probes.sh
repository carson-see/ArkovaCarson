#!/usr/bin/env bash
# scripts/staging/fullsoak-daily-probes.sh
#
# Daily BEHAVIOURAL probes for the 2026-08 7-day full-functionality soak.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
# `fullsoak-daily-check.sh` is a PARITY/INTEGRITY checker (A1-A19): frozen SHA,
# image digest, env hash, flag hash, scheduler census, ledger head, /health.
# It asserts that the rig has not DRIFTED. It asserts nothing about whether any
# product feature still WORKS. Every §4 coverage row that says "daily" for a
# feature — cross-tenant isolation, the anon-RPC deny sweep, revoked-key
# refusal, webhook HMAC rejection — had no instrument behind it. This script is
# that instrument.
#
# It is the complement, not the replacement: run BOTH every soak day.
#
# ── CONSTITUTIONAL LIMITS (CLAUDE.md §1.11A, §1.6, runbook §5.0) ─────────────
# 1. Traffic only. Every mutation goes through a real product flow authenticated
#    by a Supabase user JWT or an Arkova API key. There is not one service-role
#    write in this file.
# 2. Reads may use the service-role/Management path (a SELECT is not a write);
#    they are used for row-delta verification and the pg_proc grant census only.
# 3. NEVER writes to `anchors` or `anchor_proofs` directly. Anchors are created
#    only by the product API, if at all.
# 4. NEVER changes rig env, flags, secrets, scheduler, revisions, or traffic.
#    Nothing here can restart the worker, so nothing here can void the clock.
# 5. The anon-RPC deny sweep NEVER invokes a zero-argument or known-mutating
#    function. Grant state for those is asserted by census, not by execution.
#    Argument-taking functions are probed with a TYPE-INVALID argument so the
#    cast fails before the function body ever runs.
#
# ── EVIDENCE (runbook §5.0) ──────────────────────────────────────────────────
# Fresh output file per run; transport status recorded separately from body;
# capture timestamped from this host; artifacts append-only under
# docs/staging/evidence/fullsoak-2026-08/<UTC-date>/.
#
# ── DEPENDENCIES ─────────────────────────────────────────────────────────────
#   gcloud (auth'd; Secret Manager read + identity token), curl, python3
#   Bash 3.2 compatible (stock macOS /bin/bash).
#
# ── USAGE ────────────────────────────────────────────────────────────────────
#   ./scripts/staging/fullsoak-daily-probes.sh              # full daily set
#   ./scripts/staging/fullsoak-daily-probes.sh --read-only  # non-mutating subset
#   ./scripts/staging/fullsoak-daily-probes.sh --list       # probe inventory
#   ./scripts/staging/fullsoak-daily-probes.sh --only P8    # single probe
#
# Exit: 0 DAILY_PROBES: PASS · 1 DAILY_PROBES: FAIL · 2 harness error.

set -uo pipefail

# ═════════════════════════════════════════════════════════════════════════════
# CONFIG — expectations, not observations. Changing one is a deliberate act.
# ═════════════════════════════════════════════════════════════════════════════

GCP_PROJECT="${GCP_PROJECT:-arkova1}"
RIG_URL="${RIG_URL:-https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app}"
RIG_SUPABASE_REF="${RIG_SUPABASE_REF:-gnkuaywlpmsaezwvlvhk}"
PROD_SUPABASE_REF="${PROD_SUPABASE_REF:-vzwyaatejekddvltxyye}"

# Secret Manager secret NAMES. Values are never printed, never in argv.
SB_URL_SECRET="${SB_URL_SECRET:-supabase-url-fullsoak-2026-08-staging}"
SB_ANON_SECRET="${SB_ANON_SECRET:-supabase-anon-key-fullsoak-2026-08-staging}"
SB_SRV_SECRET="${SB_SRV_SECRET:-supabase-service-role-key-fullsoak-2026-08-staging}"
SEED_PW_SECRET="${SEED_PW_SECRET:-arkova-fullsoak-2026-08-e2e-seed-password}"
APIKEY_PUBLIC_SECRET="${APIKEY_PUBLIC_SECRET:-arkova-fullsoak-2026-08-apikey-soak-public-api}"
APIKEY_WRITE_SECRET="${APIKEY_WRITE_SECRET:-arkova-fullsoak-2026-08-apikey-soak-sdk-write}"
SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
SUPABASE_ACCESS_TOKEN_SECRET="${SUPABASE_ACCESS_TOKEN_SECRET:-supabase_access}"

# The two seeded orgs. ORG_A owns the ORG_ADMIN identity used for invite/folder
# probes; ORG_B is the isolation counterparty. Both must authenticate for real —
# an isolation assertion whose counterparty never logged in is void (runbook §6).
ORG_A_ID="${ORG_A_ID:-aaaaaaaa-0000-4000-8000-000000000001}"   # Arkova
ORG_B_ID="${ORG_B_ID:-bbbbbbbb-0000-4000-8000-000000000001}"   # Acme Corp
ORG_A_USER="${ORG_A_USER:-sarah@arkova.ai}"
ORG_B_USER="${ORG_B_USER:-demo-admin@arkova.local}"

# Frozen expectation for the anon-executable RPC surface (P8).
# Captured 2026-08-12 against the rig and prod. GROWTH IS A FAILURE.
EXPECT_ANON_FN_COUNT_RIG="${EXPECT_ANON_FN_COUNT_RIG:-282}"
EXPECT_ANON_FN_COUNT_PROD="${EXPECT_ANON_FN_COUNT_PROD:-262}"
# The 20 functions anon-executable on the rig but REVOKED in prod. This set is a
# known, dated finding (baseline squash lost the archived anon/authenticated
# REVOKEs — see the coverage checklist, item 14). It must not grow, and every
# member must stay revoked in prod.
EXPECT_RIG_ONLY_ANON_COUNT="${EXPECT_RIG_ONLY_ANON_COUNT:-20}"

# Functions the sweep must NEVER invoke: zero-arg, or mutating, or both.
# Grant state for these is asserted by census only. Editing this list DOWN
# without proving the function is side-effect-free is how a soak fabricates data.
NEVER_INVOKE="cleanup_expired_data refresh_cache_anchor_status_counts \
refresh_cache_anchor_type_counts refresh_cache_by_source refresh_cache_pipeline_stats \
refresh_cache_record_types refresh_pipeline_dashboard_cache seed_free_tier_org_credits \
handle_new_user create_profile_for_new_user delete_own_account"

EVID_ROOT_REL="${EVID_ROOT_REL:-docs/staging/evidence/fullsoak-2026-08}"

# ═════════════════════════════════════════════════════════════════════════════
# End of config.
# ═════════════════════════════════════════════════════════════════════════════

MODE="full"; ONLY=""
_next_is_only=0
for arg in "$@"; do
  if [ "$_next_is_only" -eq 1 ]; then ONLY="$arg"; _next_is_only=0; continue; fi
  case "$arg" in
    --read-only) MODE="readonly" ;;
    --list)      MODE="list" ;;
    --only)      _next_is_only=1 ;;
    -h|--help)   sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "cannot cd to repo root" >&2; exit 2; }

if [ "$MODE" = "list" ]; then
  cat <<'INV'
PROBE INVENTORY — fullsoak-daily-probes.sh

  id   mutating  founder-checklist item          asserts
  ---  --------  ------------------------------  ------------------------------------------
  P1   no        3  Login / Supabase auth        both orgs mint a real JWT; bad password 400
  P2   no        14 Cross-tenant isolation       Org B positive access THEN Org A denial
  P3   YES       6  Member invitations           invite_member row delta; escalation refused
  P4   YES       13 Folders + anchor filing      create/rename/file/unfile; cross-org denial
  P5   no        10 DPA org field policies       anon denied; ORG_ADMIN cannot self-disarm
  P6   no        11 QR verification target       anon get_public_anchor resolves the QR URL
  P7   YES       17 API key scope + revocation    revoked key refused (CC6.8 daily)
  P8   no        14 Anon-RPC deny sweep          282/262 grant census + safe invocation sweep
  P9   no        14 Webhook HMAC rejection       forged DocuSign signature -> 401, delta 0
  P10  no        15 Dashboard data-level          worker dashboards return shape, anon 401

--read-only runs P1 P2 P5 P6 P8 P9 P10 (zero writes of any kind).
INV
  exit 0
fi

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/fullsoak-probes.XXXXXX")" || exit 2
cleanup() { rm -rf "$TMPD"; }
trap cleanup EXIT INT TERM
chmod 700 "$TMPD"

RUN_DATE="$(date -u +%F)"
RUN_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_STAMP="$(date -u +%H%M%SZ)"
OUT_DIR="$REPO_ROOT/$EVID_ROOT_REL/$RUN_DATE"
mkdir -p "$OUT_DIR" || exit 2
# Fresh file per run (§5.0 rule 1) — never reuse a path across iterations.
OUT_TXT="$OUT_DIR/probes-$RUN_STAMP.txt"
OUT_JSON="$OUT_DIR/probes-$RUN_STAMP.json"

PASS=0; FAIL=0; SKIP=0
JSON_ROWS=""

die() { echo "FATAL: $*" >&2; exit 2; }

record() { # id | description | expected | observed | result
  local id="$1" desc="$2" exp="$3" obs="$4" res="$5"
  case "$res" in PASS) PASS=$((PASS+1)) ;; FAIL) FAIL=$((FAIL+1)) ;; *) SKIP=$((SKIP+1)) ;; esac
  printf '%-5s %-4s %s\n         expected: %s\n         observed: %s\n' \
    "$res" "$id" "$desc" "$exp" "$obs" | tee -a "$OUT_TXT"
  JSON_ROWS="$JSON_ROWS$(python3 -c "
import json,sys
print(json.dumps({'id':sys.argv[1],'desc':sys.argv[2],'expected':sys.argv[3],
                  'observed':sys.argv[4],'result':sys.argv[5]}))
" "$id" "$desc" "$exp" "$obs" "$res"),"
}

assert_eq() { # id | desc | expected | observed
  if [ "$3" = "$4" ]; then record "$1" "$2" "$3" "$4" "PASS"
  else record "$1" "$2" "$3" "$4" "FAIL"; fi
}

want() { # probe id -> 0 if it should run
  [ -n "$ONLY" ] && { [ "$ONLY" = "$1" ] && return 0 || return 1; }
  if [ "$MODE" = "readonly" ]; then
    case "$1" in P3|P4|P7) return 1 ;; esac
  fi
  return 0
}

secret() { gcloud secrets versions access latest --secret="$1" --project="$GCP_PROJECT" 2>/dev/null; }

# curl through a mode-0600 --config file so no token ever reaches argv/ps.
# Writes body to $1.body and the transport status to $1.status (§5.0 rule 2).
xcurl() { # outbase | method | url | authheader... (remaining args are header lines)
  local outbase="$1" method="$2" url="$3"; shift 3
  local rc="$TMPD/rc.$$"
  ( umask 077; {
      printf 'url = "%s"\n' "$url"
      printf 'request = "%s"\n' "$method"
      for h in "$@"; do printf 'header = "%s"\n' "$h"; done
      [ -f "$TMPD/body.json" ] && printf 'data-binary = "@%s"\n' "$TMPD/body.json"
      printf 'silent\nshow-error\nmax-time = 45\n'
      printf 'write-out = "%%{http_code}"\n'
      printf 'output = "%s.body"\n' "$outbase"
    } > "$rc" )
  curl -K "$rc" > "$outbase.status" 2>"$outbase.err"
  local rcode=$?
  # Always consume the request body: a leftover body.json would silently ride
  # along on the NEXT call, which is how a GET probe turns into a POST.
  rm -f "$rc" "$TMPD/body.json"
  [ $rcode -ne 0 ] && echo "000" > "$outbase.status"
  cat "$outbase.status"
}

is_num() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

http_of() { cat "$1.status" 2>/dev/null || echo "000"; }
body_of() { cat "$1.body" 2>/dev/null || echo ""; }

jbody() { # outbase | python expr over `d`
  python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1]+'.body'))
except Exception:
    print('<unparseable>'); sys.exit(0)
try:
    print($2)
except Exception as e:
    print('<missing>')
" "$1"
}

# ─────────────────────────────────────────────────────────────────────────────
# Read-only SQL against a project via the Supabase Management API.
# A SELECT is not a write; this path is used for row-delta verification and the
# pg_proc grant census only. It never issues DML.
# ─────────────────────────────────────────────────────────────────────────────
SQL_AVAILABLE=0
if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then
  SUPABASE_ACCESS_TOKEN="$(secret "$SUPABASE_ACCESS_TOKEN_SECRET")"
fi
[ -n "$SUPABASE_ACCESS_TOKEN" ] && SQL_AVAILABLE=1

sql() { # project_ref | query -> JSON array on stdout
  [ "$SQL_AVAILABLE" -eq 1 ] || { echo '<no-token>'; return 1; }
  local q; q="$(python3 -c 'import json,sys; print(json.dumps({"query":sys.argv[1]}))' "$2")"
  local rc="$TMPD/mgmt.rc"
  ( umask 077; {
      printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ACCESS_TOKEN"
      printf 'header = "Content-Type: application/json"\n'
      printf 'silent\nshow-error\nmax-time = 45\n'
    } > "$rc" )
  printf '%s' "$q" | curl -K "$rc" -X POST \
    "https://api.supabase.com/v1/projects/$1/database/query" --data-binary @- 2>/dev/null
  rm -f "$rc"
}

sql1() { # project_ref | query | key -> scalar
  sql "$1" "$2" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print((d[0] if isinstance(d,list) and d else {}).get(sys.argv[1],'<none>'))
except Exception:
    print('<error>')
" "$3"
}

{
  echo "fullsoak-daily-probes — behavioural probe run"
  echo "run_ts           : $RUN_TS"
  echo "mode             : $MODE${ONLY:+ (only $ONLY)}"
  echo "rig service      : $RIG_URL"
  echo "rig supabase ref : $RIG_SUPABASE_REF"
  echo "prod supabase ref: $PROD_SUPABASE_REF"
  echo "host             : $(hostname)"
  echo "git HEAD         : $(git rev-parse HEAD 2>/dev/null || echo '<none>')"
  echo "mgmt SQL (reads) : $([ $SQL_AVAILABLE -eq 1 ] && echo available || echo UNAVAILABLE)"
  echo "----------------------------------------------------------------------"
} | tee "$OUT_TXT"

# ── Credentials ──────────────────────────────────────────────────────────────
SB_URL="$(secret "$SB_URL_SECRET")";   [ -n "$SB_URL" ] || die "no $SB_URL_SECRET"
SB_ANON="$(secret "$SB_ANON_SECRET")"; [ -n "$SB_ANON" ] || die "no $SB_ANON_SECRET"
SEED_PW="$(secret "$SEED_PW_SECRET")"
RIG_ID_TOKEN="$(gcloud auth print-identity-token --audiences="$RIG_URL" 2>/dev/null)"
[ -n "$RIG_ID_TOKEN" ] || die "cannot mint Cloud Run identity token for $RIG_URL"

# Cloud Run IAM consumes `Authorization`, so the app-level bearer travels in
# X-Serverless-Authorization... inverted: IAM accepts either, and the app only
# reads `Authorization`. Send the IAM token in X-Serverless-Authorization and
# the product credential in Authorization (day-0 probes §2.6).
W_IAM="X-Serverless-Authorization: Bearer $RIG_ID_TOKEN"

mint_jwt() { # email -> access_token on stdout
  printf '{"email":"%s","password":"%s"}' "$1" "$SEED_PW" > "$TMPD/body.json"
  xcurl "$TMPD/jwt" POST "$SB_URL/auth/v1/token?grant_type=password" \
    "apikey: $SB_ANON" "Content-Type: application/json" >/dev/null
  rm -f "$TMPD/body.json"
  jbody "$TMPD/jwt" "d.get('access_token','')"
}

# The `sub` claim, read locally from the (already-verified-by-Supabase) token.
# `folders_insert_own` requires created_by = auth.uid(), so the probe must send
# the real caller id exactly as the browser client does — hardcoding a seed uuid
# here would make the probe pass for a user it never authenticated as.
jwt_sub() {
  printf '%s' "$1" | python3 -c "
import base64,json,sys
t=sys.stdin.read().split('.')
if len(t)<2: print(''); raise SystemExit
p=t[1] + '=' * (-len(t[1]) % 4)
try: print(json.loads(base64.urlsafe_b64decode(p)).get('sub',''))
except Exception: print('')
"
}

# ═════════════════════════════════════════════════════════════════════════════
# P1 — Login (item 3). Both orgs must genuinely authenticate; this is the
# precondition every isolation assertion in P2/P4 depends on (runbook §6 trap).
# ═════════════════════════════════════════════════════════════════════════════
JWT_A=""; JWT_B=""
if want P1; then
  JWT_A="$(mint_jwt "$ORG_A_USER")"
  H1="$(http_of "$TMPD/jwt")"
  case "$JWT_A" in ey*) assert_eq P1a "Org A ($ORG_A_USER) mints a real Supabase JWT" "http 200 + JWT" "http $H1 + JWT" ;;
                   *)   record P1a "Org A ($ORG_A_USER) mints a real Supabase JWT" "http 200 + JWT" "http $H1 + no token" FAIL ;; esac

  JWT_B="$(mint_jwt "$ORG_B_USER")"
  H2="$(http_of "$TMPD/jwt")"
  case "$JWT_B" in ey*) assert_eq P1b "Org B ($ORG_B_USER) mints a real Supabase JWT" "http 200 + JWT" "http $H2 + JWT" ;;
                   *)   record P1b "Org B ($ORG_B_USER) mints a real Supabase JWT" "http 200 + JWT" "http $H2 + no token" FAIL ;; esac

  printf '{"email":"%s","password":"definitely-not-the-password-%s"}' "$ORG_A_USER" "$RUN_STAMP" > "$TMPD/body.json"
  xcurl "$TMPD/badpw" POST "$SB_URL/auth/v1/token?grant_type=password" \
    "apikey: $SB_ANON" "Content-Type: application/json" >/dev/null
  rm -f "$TMPD/body.json"
  BADH="$(http_of "$TMPD/badpw")"
  case "$BADH" in 400|401|403) record P1c "Wrong password is refused" "400/401/403" "http $BADH" PASS ;;
                  *)           record P1c "Wrong password is refused" "400/401/403" "http $BADH" FAIL ;; esac
else
  JWT_A="$(mint_jwt "$ORG_A_USER")"; JWT_B="$(mint_jwt "$ORG_B_USER")"
fi

pgrest() { # outbase | method | path+query | jwt | [body-json]
  local ob="$1" m="$2" p="$3" tok="$4"
  [ -n "${5:-}" ] && printf '%s' "$5" > "$TMPD/body.json"
  xcurl "$ob" "$m" "$SB_URL/rest/v1/$p" \
    "apikey: $SB_ANON" "Authorization: Bearer $tok" \
    "Content-Type: application/json" "Prefer: return=representation" >/dev/null
  rm -f "$TMPD/body.json"
}

# ═════════════════════════════════════════════════════════════════════════════
# P2 — Cross-tenant isolation (item 14). Positive access FIRST, every time.
# An isolation test that cannot prove positive access is void (runbook §6c).
# ═════════════════════════════════════════════════════════════════════════════
if want P2 && [ -n "$JWT_B" ]; then
  pgrest "$TMPD/p2own" GET "anchors?select=id,org_id&org_id=eq.$ORG_B_ID&limit=5" "$JWT_B"
  OWN_N="$(jbody "$TMPD/p2own" "len(d) if isinstance(d,list) else -1")"
  if is_num "$OWN_N" && [ "$OWN_N" -gt 0 ]; then
    record P2a "PRECONDITION: Org B session is live (reads its OWN anchors)" ">=1 row" "$OWN_N rows" PASS

    pgrest "$TMPD/p2xt" GET "anchors?select=id,org_id&org_id=eq.$ORG_A_ID&limit=5" "$JWT_B"
    XT_N="$(jbody "$TMPD/p2xt" "len(d) if isinstance(d,list) else -1")"
    XT_H="$(http_of "$TMPD/p2xt")"
    if [ "$XT_N" = "0" ]; then
      record P2b "Org B JWT cannot read Org A anchors (RLS filters to empty)" "0 rows" "http $XT_H, 0 rows" PASS
    else
      record P2b "Org B JWT cannot read Org A anchors (RLS filters to empty)" "0 rows" "http $XT_H, $XT_N rows — LEAK" FAIL
    fi

    pgrest "$TMPD/p2fold" GET "folders?select=id,org_id&org_id=eq.$ORG_A_ID&limit=5" "$JWT_B"
    F_N="$(jbody "$TMPD/p2fold" "len(d) if isinstance(d,list) else -1")"
    if [ "$F_N" = "0" ]; then
      record P2c "Org B JWT cannot enumerate Org A folders" "0 rows" "0 rows" PASS
    else
      record P2c "Org B JWT cannot enumerate Org A folders" "0 rows" "$F_N rows — LEAK" FAIL
    fi

    pgrest "$TMPD/p2keys" GET "api_keys?select=id,org_id&org_id=eq.$ORG_A_ID&limit=5" "$JWT_B"
    K_N="$(jbody "$TMPD/p2keys" "len(d) if isinstance(d,list) else -1")"
    K_H="$(http_of "$TMPD/p2keys")"
    if [ "$K_N" = "0" ] || [ "$K_H" = "401" ] || [ "$K_H" = "403" ] || [ "$K_H" = "404" ]; then
      record P2d "Org B JWT cannot enumerate Org A API keys" "0 rows or 401/403/404" "http $K_H, $K_N rows" PASS
    else
      record P2d "Org B JWT cannot enumerate Org A API keys" "0 rows or 401/403/404" "http $K_H, $K_N rows — LEAK" FAIL
    fi
  else
    record P2a "PRECONDITION: Org B session is live (reads its OWN anchors)" ">=1 row" "$OWN_N rows — isolation assertions VOID" FAIL
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# P3 — Member invitations (item 6). MUTATING: creates one `invitations` row per
# run via the real SECURITY DEFINER RPC, authenticated as an ORG_ADMIN JWT.
# ═════════════════════════════════════════════════════════════════════════════
if want P3 && [ -n "$JWT_A" ]; then
  INV_BEFORE="$(sql1 "$RIG_SUPABASE_REF" "select count(*)::text as n from invitations" n)"
  PROBE_EMAIL="soak-probe-$RUN_DATE-$RUN_STAMP@arkova-soak.invalid"

  pgrest "$TMPD/p3inv" POST "rpc/invite_member" "$JWT_A" \
    "$(printf '{"invitee_email":"%s","invitee_role":"ORG_MEMBER","target_org_id":"%s"}' "$PROBE_EMAIL" "$ORG_A_ID")"
  INV_H="$(http_of "$TMPD/p3inv")"
  INV_AFTER="$(sql1 "$RIG_SUPABASE_REF" "select count(*)::text as n from invitations" n)"
  if [ "$INV_H" = "200" ] && is_num "$INV_BEFORE" && is_num "$INV_AFTER" && [ "$INV_AFTER" -gt "$INV_BEFORE" ]; then
    record P3a "invite_member as ORG_ADMIN writes an invitations row" \
      "http 200 AND row delta +1" "http $INV_H, count $INV_BEFORE -> $INV_AFTER" PASS
  else
    record P3a "invite_member as ORG_ADMIN writes an invitations row" \
      "http 200 AND row delta +1" "http $INV_H, count $INV_BEFORE -> $INV_AFTER" FAIL
  fi

  # SEC-RECON-8: an ORG_ADMIN must not be able to mint another ORG_ADMIN.
  pgrest "$TMPD/p3esc" POST "rpc/invite_member" "$JWT_A" \
    "$(printf '{"invitee_email":"esc-%s@arkova-soak.invalid","invitee_role":"ORG_ADMIN","target_org_id":"%s"}' "$RUN_STAMP" "$ORG_A_ID")"
  ESC_H="$(http_of "$TMPD/p3esc")"
  case "$ESC_H" in
    400|401|403|404|500) record P3b "invite_member refuses to mint an ORG_ADMIN (SEC-RECON-8)" "non-2xx" "http $ESC_H" PASS ;;
    *)                   record P3b "invite_member refuses to mint an ORG_ADMIN (SEC-RECON-8)" "non-2xx" "http $ESC_H — ESCALATION" FAIL ;;
  esac

  # Cross-org: Org B admin must not invite into Org A.
  pgrest "$TMPD/p3xo" POST "rpc/invite_member" "$JWT_B" \
    "$(printf '{"invitee_email":"xo-%s@arkova-soak.invalid","invitee_role":"ORG_MEMBER","target_org_id":"%s"}' "$RUN_STAMP" "$ORG_A_ID")"
  XO_H="$(http_of "$TMPD/p3xo")"
  case "$XO_H" in
    2*) record P3c "Org B admin cannot invite into Org A" "non-2xx" "http $XO_H — CROSS-TENANT WRITE" FAIL ;;
    *)  record P3c "Org B admin cannot invite into Org A" "non-2xx" "http $XO_H" PASS ;;
  esac

  # Public token-preview leg (the recipient's first touch). No auth by design.
  TOK="$(sql1 "$RIG_SUPABASE_REF" \
    "select token::text as t from invitations where email='$PROBE_EMAIL' limit 1" t)"
  case "$TOK" in
    ''|'<none>'|'<error>') record P3d "GET /api/invitations/:token previews the invite" "200 + org name" "no token row to preview" SKIP ;;
    *)
      xcurl "$TMPD/p3prev" GET "$RIG_URL/api/invitations/$TOK" "$W_IAM" >/dev/null
      PV_H="$(http_of "$TMPD/p3prev")"
      PV_ORG="$(jbody "$TMPD/p3prev" "d.get('organizationName') or d.get('orgName') or d.get('organization') or '<missing>'")"
      if [ "$PV_H" = "200" ] && [ "$PV_ORG" != "<missing>" ]; then
        record P3d "GET /api/invitations/:token previews the invite" "200 + org name in body" "http $PV_H, org=$PV_ORG" PASS
      else
        record P3d "GET /api/invitations/:token previews the invite" "200 + org name in body" "http $PV_H, org=$PV_ORG" FAIL
      fi ;;
  esac
  # NOTE: POST /api/send-invitation-email is deliberately NOT probed — it sends
  # real mail through Resend. Wiring it needs an explicit operator decision and a
  # sink address, not a default daily probe.
fi

# ═════════════════════════════════════════════════════════════════════════════
# P4 — Folders + anchor filing (item 13). MUTATING via PostgREST + user JWT.
# Folders have NO worker route; the browser is the only client, so JWT+PostgREST
# is the real product flow.
# ═════════════════════════════════════════════════════════════════════════════
if want P4 && [ -n "$JWT_A" ]; then
  FNAME="soak-probe-$RUN_STAMP"
  SUB_A="$(jwt_sub "$JWT_A")"
  pgrest "$TMPD/p4new" POST "folders" "$JWT_A" \
    "$(printf '{"owner_scope":"ORG","org_id":"%s","name":"%s","created_by":"%s"}' "$ORG_A_ID" "$FNAME" "$SUB_A")"
  F_H="$(http_of "$TMPD/p4new")"
  FID="$(jbody "$TMPD/p4new" "(d[0] if isinstance(d,list) and d else d).get('id','')")"
  if [ "$F_H" = "201" ] && [ -n "$FID" ]; then
    record P4a "ORG_ADMIN JWT creates a folder" "201 + id" "http $F_H, id=${FID%%-*}…" PASS

    pgrest "$TMPD/p4ren" PATCH "folders?id=eq.$FID" "$JWT_A" "$(printf '{"name":"%s-renamed"}' "$FNAME")"
    REN_N="$(jbody "$TMPD/p4ren" "len(d) if isinstance(d,list) else 0")"
    if is_num "$REN_N" && [ "$REN_N" -ge 1 ]; then
      record P4b "Folder rename returns the updated row (not a silent 0-row PATCH)" ">=1 row" "$REN_N rows" PASS
    else
      record P4b "Folder rename returns the updated row (not a silent 0-row PATCH)" ">=1 row" "$REN_N rows" FAIL
    fi

    # File an anchor into it. `select=id` returning >=1 row is the whole point:
    # an RLS-blocked UPDATE returns {error:null} with zero rows (the SCRUM-2940
    # bug 0393 fixes) — status alone is not evidence.
    ANCH="$(sql1 "$RIG_SUPABASE_REF" \
      "select id::text as i from anchors where org_id='$ORG_A_ID' order by created_at desc limit 1" i)"
    case "$ANCH" in
      ''|'<none>'|'<error>') record P4c "Anchor filed into folder (row-count proven)" ">=1 row" "no Org A anchor available" SKIP ;;
      *)
        pgrest "$TMPD/p4file" PATCH "anchors?id=eq.$ANCH&select=id" "$JWT_A" "$(printf '{"folder_id":"%s"}' "$FID")"
        FIL_N="$(jbody "$TMPD/p4file" "len(d) if isinstance(d,list) else 0")"
        if is_num "$FIL_N" && [ "$FIL_N" -ge 1 ]; then
          record P4c "Anchor filed into folder (row-count proven, not status-only)" ">=1 row returned" "$FIL_N rows" PASS
        else
          record P4c "Anchor filed into folder (row-count proven, not status-only)" ">=1 row returned" "$FIL_N rows — silent RLS block" FAIL
        fi

        # Cross-org negative: Org B must not be able to re-file Org A's anchor.
        pgrest "$TMPD/p4xo" PATCH "anchors?id=eq.$ANCH&select=id" "$JWT_B" '{"folder_id":null}'
        XOF_N="$(jbody "$TMPD/p4xo" "len(d) if isinstance(d,list) else 0")"
        if [ "$XOF_N" = "0" ]; then
          record P4d "Org B JWT cannot re-file an Org A anchor" "0 rows" "0 rows" PASS
        else
          record P4d "Org B JWT cannot re-file an Org A anchor" "0 rows" "$XOF_N rows — CROSS-TENANT WRITE" FAIL
        fi
        ;;
    esac

    # Teardown proves ON DELETE SET NULL, and keeps the rig from accreting a
    # folder per soak day.
    pgrest "$TMPD/p4del" DELETE "folders?id=eq.$FID" "$JWT_A"
    DEL_H="$(http_of "$TMPD/p4del")"
    ORPH="$(sql1 "$RIG_SUPABASE_REF" \
      "select count(*)::text as n from anchors where folder_id='$FID'" n)"
    if [ "$ORPH" = "0" ]; then
      record P4e "Folder delete releases filed anchors (ON DELETE SET NULL)" "0 anchors left pointing at it" "http $DEL_H, $ORPH" PASS
    else
      record P4e "Folder delete releases filed anchors (ON DELETE SET NULL)" "0 anchors left pointing at it" "http $DEL_H, $ORPH" FAIL
    fi
  else
    record P4a "ORG_ADMIN JWT creates a folder" "201 + id" "http $F_H, body=$(head -c 160 "$TMPD/p4new.body" 2>/dev/null)" FAIL
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# P5 — DPA org field policies, migration 0405 (item 10). NON-MUTATING.
# 0405's whole design claim is that the regulated party cannot switch off its
# own compliance control: no INSERT/UPDATE/DELETE policy exists for
# `authenticated` at all, and the table is REVOKEd from anon. That claim is what
# this probe tests. Armed enforcement (a policy row -> anchor rejection) needs an
# operator/service-role fixture INSERT and is DECLARED-UNTESTED here by design.
# ═════════════════════════════════════════════════════════════════════════════
if want P5; then
  xcurl "$TMPD/p5anon" GET "$SB_URL/rest/v1/organization_field_policies?select=org_id" \
    "apikey: $SB_ANON" "Authorization: Bearer $SB_ANON" >/dev/null
  A_H="$(http_of "$TMPD/p5anon")"
  A_N="$(jbody "$TMPD/p5anon" "len(d) if isinstance(d,list) else -1")"
  if [ "$A_H" = "401" ] || [ "$A_H" = "403" ] || [ "$A_N" = "0" ]; then
    record P5a "anon cannot read organization_field_policies" "401/403 or 0 rows" "http $A_H, rows=$A_N" PASS
  else
    record P5a "anon cannot read organization_field_policies" "401/403 or 0 rows" "http $A_H, rows=$A_N — EXPOSED" FAIL
  fi

  # The load-bearing one: an ORG_ADMIN must not be able to write its own policy.
  # The payload is doubly inert BY DESIGN — `enabled:false` AND an empty
  # `disallowed_fields` — so that if the write-lock is broken (a P0 finding) the
  # probe still cannot arm a DPA control on a live soak rig.
  pgrest "$TMPD/p5ins" POST "organization_field_policies" "$JWT_A" \
    "$(printf '{"org_id":"%s","disallowed_fields":[],"enabled":false,"policy_reason":"soak-probe-must-fail"}' "$ORG_A_ID")"
  I_H="$(http_of "$TMPD/p5ins")"
  case "$I_H" in
    2*) record P5b "ORG_ADMIN cannot INSERT its own field policy (cannot self-disarm)" "non-2xx" "http $I_H — REGULATED PARTY CAN DISARM ITS OWN CONTROL" FAIL ;;
    *)  record P5b "ORG_ADMIN cannot INSERT its own field policy (cannot self-disarm)" "non-2xx" "http $I_H" PASS ;;
  esac

  pgrest "$TMPD/p5upd" PATCH "organization_field_policies?org_id=eq.$ORG_A_ID&select=org_id" "$JWT_A" '{"enabled":false}'
  U_N="$(jbody "$TMPD/p5upd" "len(d) if isinstance(d,list) else 0")"
  U_H="$(http_of "$TMPD/p5upd")"
  if [ "$U_N" = "0" ]; then
    record P5c "ORG_ADMIN cannot UPDATE a field policy row" "0 rows affected" "http $U_H, $U_N rows" PASS
  else
    record P5c "ORG_ADMIN cannot UPDATE a field policy row" "0 rows affected" "http $U_H, $U_N rows — DISARMABLE" FAIL
  fi

  # Dated statement of the inert baseline: enforcement keys off row presence.
  OFP_N="$(sql1 "$RIG_SUPABASE_REF" "select count(*)::text as n from organization_field_policies" n)"
  record P5d "Field-policy enforcement armed? (row count, dated)" \
    "0 = inert; enforcement path NOT exercised" "$OFP_N policy rows" \
    "$([ "$OFP_N" = "0" ] && echo SKIP || echo PASS)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# P6 — QR verification target (item 11). The QR is generated client-side and
# encodes ${APP_URL}/verify/<publicId>; that page's ONLY data call is the anon
# RPC get_public_anchor. Probing the RPC as anon is the scan path.
# ═════════════════════════════════════════════════════════════════════════════
if want P6; then
  PUB="$(sql1 "$RIG_SUPABASE_REF" \
    "select public_id as p from anchors where status='SECURED' and public_id is not null order by created_at desc limit 1" p)"
  case "$PUB" in
    ''|'<none>'|'<error>') record P6a "QR scan path resolves (anon get_public_anchor)" "record body" "no SECURED anchor" SKIP ;;
    *)
      printf '{"p_public_id":"%s"}' "$PUB" > "$TMPD/body.json"
      xcurl "$TMPD/p6" POST "$SB_URL/rest/v1/rpc/get_public_anchor" \
        "apikey: $SB_ANON" "Authorization: Bearer $SB_ANON" "Content-Type: application/json" >/dev/null
      rm -f "$TMPD/body.json"
      P6H="$(http_of "$TMPD/p6")"
      P6ID="$(jbody "$TMPD/p6" "(d[0] if isinstance(d,list) and d else d).get('public_id','<missing>')")"
      if [ "$P6H" = "200" ] && [ "$P6ID" = "$PUB" ]; then
        record P6a "QR scan path resolves as anon (get_public_anchor -> record)" \
          "200 + public_id=$PUB" "http $P6H, public_id=$P6ID" PASS
      else
        record P6a "QR scan path resolves as anon (get_public_anchor -> record)" \
          "200 + public_id=$PUB" "http $P6H, public_id=$P6ID" FAIL
      fi

      printf '{"p_public_id":"ARK-2026-NOSUCHID"}' > "$TMPD/body.json"
      xcurl "$TMPD/p6bad" POST "$SB_URL/rest/v1/rpc/get_public_anchor" \
        "apikey: $SB_ANON" "Authorization: Bearer $SB_ANON" "Content-Type: application/json" >/dev/null
      rm -f "$TMPD/body.json"
      B6H="$(http_of "$TMPD/p6bad")"
      # `get_public_anchor` answers an unknown id with jsonb {"error":"Record not
      # found"} at HTTP 200 — a distinct not-found payload, which is what the
      # frontend's proof-gate renders. Assert the PAYLOAD, never the status: a
      # bare 200 is exactly the hollow assertion runbook §5.1 warns about, and a
      # 200 carrying a real record for a bogus id would be a disclosure bug.
      B6ERR="$(jbody "$TMPD/p6bad" "(d[0] if isinstance(d,list) and d else (d or {})).get('error','<none>')")"
      B6PID="$(jbody "$TMPD/p6bad" "(d[0] if isinstance(d,list) and d else (d or {})).get('public_id','<none>')")"
      if [ "$B6H" = "404" ] || { [ "$B6H" = "200" ] && [ "$B6ERR" != "<none>" ] && [ "$B6PID" = "<none>" ]; }; then
        record P6b "Unknown QR target yields a distinct not-found payload, never a record and never a 5xx" \
          "404, or 200 with error payload and NO public_id" "http $B6H, error=$B6ERR, public_id=$B6PID" PASS
      else
        record P6b "Unknown QR target yields a distinct not-found payload, never a record and never a 5xx" \
          "404, or 200 with error payload and NO public_id" "http $B6H, error=$B6ERR, public_id=$B6PID" FAIL
      fi ;;
  esac
fi

# ═════════════════════════════════════════════════════════════════════════════
# P7 — API key scope + revocation (item 17, CC6.8). MUTATING: mints one probe
# key through the real POST /api/v1/keys flow, exercises it, revokes it, and
# proves the revoked key is refused. There is NO revoked key on the rig, so
# without this the runbook's "a revoked API key is refused daily" has nothing
# to assert against.
# ═════════════════════════════════════════════════════════════════════════════
if want P7 && [ -n "$JWT_A" ]; then
  # Accretion backstop. P7e deletes the probe key at the end of each run —
  # reachable since the FD-P7 fix restored `id` on key responses. The cap only
  # matters if that delete regresses or a retry loop goes wrong; it must never
  # mint dozens of keys on a live soak rig.
  EXISTING_PROBE_KEYS="$(sql1 "$RIG_SUPABASE_REF" \
    "select count(*)::text as n from api_keys where name like 'soak-daily-revocation-probe%'" n)"
  PROBE_KEY_CAP="${PROBE_KEY_CAP:-8}"
  if is_num "$EXISTING_PROBE_KEYS" && [ "$EXISTING_PROBE_KEYS" -ge "$PROBE_KEY_CAP" ]; then
    record P7a "Probe API key minted through the real POST /api/v1/keys flow" \
      "mint one probe key" \
      "$EXISTING_PROBE_KEYS probe keys already present (cap $PROBE_KEY_CAP) — refusing to mint; clear them out-of-band (FD-P7)" SKIP
    P7_SKIP_MINT=1
  else
    P7_SKIP_MINT=0
  fi
fi
if want P7 && [ -n "$JWT_A" ] && [ "${P7_SKIP_MINT:-0}" -eq 0 ]; then
  printf '{"name":"soak-daily-revocation-probe-%s","scopes":["verify"]}' "$RUN_STAMP" > "$TMPD/body.json"
  xcurl "$TMPD/p7new" POST "$RIG_URL/api/v1/keys" "$W_IAM" \
    "Authorization: Bearer $JWT_A" "Content-Type: application/json" >/dev/null
  rm -f "$TMPD/body.json"
  N_H="$(http_of "$TMPD/p7new")"
  RAWKEY="$(jbody "$TMPD/p7new" "d.get('key','')")"
  KEYPFX="$(jbody "$TMPD/p7new" "d.get('key_prefix') or d.get('keyPrefix') or ''")"

  if { [ "$N_H" = "201" ] || [ "$N_H" = "200" ]; } && [ -n "$RAWKEY" ]; then
    record P7a "Probe API key minted through the real POST /api/v1/keys flow" \
      "200/201 + raw key returned once" "http $N_H, prefix=$KEYPFX" PASS

    # FD-P7 fixed: create and list both carry the addressable `id`. Prefer the
    # create response; fall back to list-matching by key_prefix (what the UI
    # does) so the probe still finds its key if create's shape ever drifts.
    KEYID="$(jbody "$TMPD/p7new" "d.get('id') or ''")"
    xcurl "$TMPD/p7list" GET "$RIG_URL/api/v1/keys" "$W_IAM" "Authorization: Bearer $JWT_A" >/dev/null
    if [ -z "$KEYID" ]; then
      KEYID="$(python3 -c "
import json
try: d=json.load(open('$TMPD/p7list.body'))
except Exception: print(''); raise SystemExit
for k in (d.get('keys') or []):
    if k.get('key_prefix')=='$KEYPFX': print(k.get('id') or ''); break
else: print('')
")"
    fi
    # FD-P7 regression assertion: the UI's revoke/delete handlers address keys
    # by the `id` on list rows (src/hooks/useApiKeys.ts). If list rows stop
    # exposing it, revocation is unreachable from every client again — assert
    # it, do not let the probe SKIP its way past it.
    HAS_ID="$(python3 -c "
import json
try: d=json.load(open('$TMPD/p7list.body'))
except Exception: print('unreadable'); raise SystemExit
ks=d.get('keys') or []
print('yes' if ks and any('id' in k for k in ks) else ('no' if ks else 'no-keys'))
")"
    if [ "$HAS_ID" = "yes" ]; then
      record P7f "GET /api/v1/keys exposes an addressable key id (revoke/delete precondition)" \
        "id present on list rows" "$HAS_ID" PASS
    else
      record P7f "GET /api/v1/keys exposes an addressable key id (revoke/delete precondition)" \
        "id present on list rows" "$HAS_ID — no id on any row; UI revoke/delete are keyed by an id the API never returns (keys.ts toPublicKey strips it)" FAIL
    fi

    PUB2="$(sql1 "$RIG_SUPABASE_REF" \
      "select public_id as p from anchors where status='SECURED' and public_id is not null order by created_at desc limit 1" p)"
    xcurl "$TMPD/p7live" GET "$RIG_URL/api/v1/verify/$PUB2" "$W_IAM" "Authorization: Bearer $RAWKEY" >/dev/null
    L_H="$(http_of "$TMPD/p7live")"
    assert_eq P7b "Live key with 'verify' scope is accepted" "http 200" "http $L_H"

    # Out-of-scope call with the same key: 'verify' must not imply anchor:write.
    printf '{"fingerprint":"%064d","credentialType":"OTHER"}' 0 > "$TMPD/body.json"
    xcurl "$TMPD/p7scope" POST "$RIG_URL/api/v1/anchor" "$W_IAM" \
      "Authorization: Bearer $RAWKEY" "Content-Type: application/json" >/dev/null
    S_H="$(http_of "$TMPD/p7scope")"
    case "$S_H" in
      401|403) record P7c "Scope enforced: verify-only key refused on /api/v1/anchor" "401/403" "http $S_H" PASS ;;
      *)       record P7c "Scope enforced: verify-only key refused on /api/v1/anchor" "401/403" "http $S_H — SCOPE NOT ENFORCED" FAIL ;;
    esac

    if [ -n "$KEYID" ]; then
      # The product's revoke path is PATCH is_active=false (it logs
      # api_key.revoked). DELETE is a hard delete and proves something weaker —
      # a row that no longer exists is trivially refused.
      printf '{"is_active":false}' > "$TMPD/body.json"
      xcurl "$TMPD/p7rev" PATCH "$RIG_URL/api/v1/keys/$KEYID" "$W_IAM" \
        "Authorization: Bearer $JWT_A" "Content-Type: application/json" >/dev/null
      R_H="$(http_of "$TMPD/p7rev")"
      xcurl "$TMPD/p7dead" GET "$RIG_URL/api/v1/verify/$PUB2" "$W_IAM" "Authorization: Bearer $RAWKEY" >/dev/null
      D_H="$(http_of "$TMPD/p7dead")"
      case "$D_H" in
        401|403) record P7d "REVOKED key is refused (CC6.8 daily assertion)" \
                   "401/403 after PATCH is_active=false" "revoke http $R_H, reuse http $D_H" PASS ;;
        *)       record P7d "REVOKED key is refused (CC6.8 daily assertion)" \
                   "401/403 after PATCH is_active=false" "revoke http $R_H, reuse http $D_H — REVOCATION INEFFECTIVE" FAIL ;;
      esac

      # The designation is stamped, not just the boolean flipped — a CC6.8
      # export reads revoked_at, and pre-FD-P7 it stayed NULL after a revoke.
      RVK_AT="$(jbody "$TMPD/p7rev" "d.get('revoked_at') or ''")"
      if [ -n "$RVK_AT" ]; then
        record P7g "Revoke stamps revoked_at (CC6.8 designation, not just is_active)" \
          "non-null revoked_at in PATCH response" "revoked_at=$RVK_AT" PASS
      else
        record P7g "Revoke stamps revoked_at (CC6.8 designation, not just is_active)" \
          "non-null revoked_at in PATCH response" "revoked_at empty — designation export would read revoked=false" FAIL
      fi

      # Clean up so the CC6.8 designation table does not accrete one probe key
      # per soak day. The assertion above is re-proved from scratch each run.
      xcurl "$TMPD/p7clean" DELETE "$RIG_URL/api/v1/keys/$KEYID" "$W_IAM" "Authorization: Bearer $JWT_A" >/dev/null
      record P7e "Probe key cleaned up (no per-day key accretion)" "204" "http $(http_of "$TMPD/p7clean")" \
        "$([ "$(http_of "$TMPD/p7clean")" = "204" ] && echo PASS || echo FAIL)"
    else
      # FD-P7 regression: neither the create response nor any list row carried
      # an id, so PATCH/DELETE /api/v1/keys/:keyId cannot be addressed. P7f has
      # already FAILed above; fail the control assertion too and name the
      # leftover key for out-of-band cleanup.
      record P7d "REVOKED key is refused (CC6.8 daily assertion)" \
        "401/403 after revoke through the product surface" \
        "no key id in create or list response (FD-P7 regression) — probe key $KEYPFX left active" FAIL
    fi
  else
    record P7a "Probe API key minted through the real POST /api/v1/keys flow" "200/201 + raw key" "http $N_H" FAIL
  fi
  unset RAWKEY
fi

# ═════════════════════════════════════════════════════════════════════════════
# P8 — Anon-executable RPC deny sweep (item 14). THE ONE THAT WAS ONLY PLANNED.
#
# Two legs, deliberately separate:
#   Leg A — GRANT CENSUS (read-only SQL). Counts and set-membership on both rig
#           and prod. Growth in either is a failure. This is the only leg that
#           can speak about PROD, because prod is change-frozen and must not be
#           probed with traffic.
#   Leg B — LIVE INVOCATION on the rig, side-effect-free by construction: only
#           functions taking >=1 argument, called with a TYPE-INVALID argument so
#           the cast fails before the body runs. `permission denied` proves the
#           deny; `invalid input syntax` proves the grant is live and reachable.
#           Zero-arg / mutating functions in $NEVER_INVOKE are census-only.
# ═════════════════════════════════════════════════════════════════════════════
if want P8; then
  if [ "$SQL_AVAILABLE" -ne 1 ]; then
    record P8 "Anon-RPC deny sweep" "grant census + invocation sweep" "no Supabase management token — census impossible" SKIP
  else
    ANON_Q="select count(*)::text as n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and has_function_privilege('anon', p.oid, 'EXECUTE')"
    RIG_N="$(sql1 "$RIG_SUPABASE_REF" "$ANON_Q" n)"
    PROD_N="$(sql1 "$PROD_SUPABASE_REF" "$ANON_Q" n)"

    if is_num "$RIG_N" && [ "$RIG_N" -le "$EXPECT_ANON_FN_COUNT_RIG" ]; then
      record P8a "Rig anon-executable function count has not grown" "<= $EXPECT_ANON_FN_COUNT_RIG" "$RIG_N" PASS
    else
      record P8a "Rig anon-executable function count has not grown" "<= $EXPECT_ANON_FN_COUNT_RIG" "$RIG_N — NEW ANON SURFACE" FAIL
    fi
    if is_num "$PROD_N" && [ "$PROD_N" -le "$EXPECT_ANON_FN_COUNT_PROD" ]; then
      record P8b "PROD anon-executable function count has not grown (change freeze)" "<= $EXPECT_ANON_FN_COUNT_PROD" "$PROD_N" PASS
    else
      record P8b "PROD anon-executable function count has not grown (change freeze)" "<= $EXPECT_ANON_FN_COUNT_PROD" "$PROD_N — NEW PROD ANON SURFACE" FAIL
    fi

    # The 20 rig-only grants. Every one MUST remain revoked in prod; the set
    # must not grow. (Rig-only members are a rebuild-provenance finding, not a
    # prod exposure — see the coverage checklist, item 14.)
    sql "$RIG_SUPABASE_REF" "$(printf '%s' \
      "select p.proname as f from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and has_function_privilege('anon', p.oid, 'EXECUTE') group by 1 order by 1")" \
      > "$TMPD/rig_fns.json"
    sql "$PROD_SUPABASE_REF" "$(printf '%s' \
      "select p.proname as f from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and has_function_privilege('anon', p.oid, 'EXECUTE') group by 1 order by 1")" \
      > "$TMPD/prod_fns.json"
    python3 -c "
import json
def load(p):
    try:
        return {r['f'] for r in json.load(open(p))}
    except Exception:
        return set()
r,pr = load('$TMPD/rig_fns.json'), load('$TMPD/prod_fns.json')
open('$TMPD/rigonly.txt','w').write('\n'.join(sorted(r-pr)))
open('$TMPD/prodonly.txt','w').write('\n'.join(sorted(pr-r)))
"
    RO_N="$(grep -c . "$TMPD/rigonly.txt" 2>/dev/null | tr -d ' ')"; RO_N="${RO_N:-0}"
    PO_N="$(grep -c . "$TMPD/prodonly.txt" 2>/dev/null | tr -d ' ')"; PO_N="${PO_N:-0}"
    if is_num "$RO_N" && [ "$RO_N" -le "$EXPECT_RIG_ONLY_ANON_COUNT" ]; then
      record P8c "Rig-only anon grants (prod-revoked) have not grown" \
        "<= $EXPECT_RIG_ONLY_ANON_COUNT" "$RO_N: $(tr '\n' ' ' < "$TMPD/rigonly.txt" | cut -c1-200)" PASS
    else
      record P8c "Rig-only anon grants (prod-revoked) have not grown" \
        "<= $EXPECT_RIG_ONLY_ANON_COUNT" "$RO_N — GREW: $(tr '\n' ' ' < "$TMPD/rigonly.txt" | cut -c1-200)" FAIL
    fi
    if [ "$PO_N" = "0" ]; then
      record P8d "No function is anon-executable in PROD but not on the rig" "0" "$PO_N" PASS
    else
      record P8d "No function is anon-executable in PROD but not on the rig" "0" \
        "$PO_N: $(tr '\n' ' ' < "$TMPD/prodonly.txt" | cut -c1-200) — sweep blind spot" FAIL
    fi

    # ── Leg B: live, side-effect-free invocation sweep on the RIG only ────────
    sql "$RIG_SUPABASE_REF" "$(printf '%s' \
      "select p.proname as f, (select a.attname from unnest(p.proargnames) with ordinality as a(attname, ord) where ord = 1) as a1, format_type(p.proargtypes[0], null) as t1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and has_function_privilege('anon', p.oid, 'EXECUTE') and p.pronargs > 0 and p.proargnames is not null and format_type(p.proargtypes[0], null) in ('uuid','integer','bigint','boolean','numeric','double precision') order by 1")" \
      > "$TMPD/invokable.json"
    python3 -c "
import json,sys
never=set('''$NEVER_INVOKE'''.split())
try:
    rows=json.load(open('$TMPD/invokable.json'))
except Exception:
    rows=[]
out=[r for r in rows if r.get('f') and r.get('a1') and r['f'] not in never]
with open('$TMPD/invokable.tsv','w') as fh:
    for r in out:
        fh.write('%s\t%s\n' % (r['f'], r['a1']))
print(len(out))
" > "$TMPD/invokable.count"
    INVOKE_N="$(cat "$TMPD/invokable.count" 2>/dev/null || echo 0)"

    SWEPT=0; DENIED=0; REACHABLE=0; ANOMALY=0; ANOM_LIST=""
    if is_num "$INVOKE_N" && [ "$INVOKE_N" -gt 0 ]; then
      while IFS="$(printf '\t')" read -r FN ARG; do
        [ -n "$FN" ] || continue
        # A type-invalid argument: the cast fails before the function body runs,
        # so a granted function is observable without being executed.
        printf '{"%s":"__soak_probe_not_a_valid_value__"}' "$ARG" > "$TMPD/body.json"
        xcurl "$TMPD/sw" POST "$SB_URL/rest/v1/rpc/$FN" \
          "apikey: $SB_ANON" "Authorization: Bearer $SB_ANON" "Content-Type: application/json" >/dev/null
        rm -f "$TMPD/body.json"
        SW_H="$(http_of "$TMPD/sw")"
        SW_B="$(head -c 300 "$TMPD/sw.body" 2>/dev/null)"
        SWEPT=$((SWEPT+1))
        case "$SW_B" in
          *"permission denied"*|*"PGRST202"*|*"42501"*) DENIED=$((DENIED+1)) ;;
          *"invalid input syntax"*|*"22P02"*|*"cannot be cast"*|*"22003"*) REACHABLE=$((REACHABLE+1)) ;;
          *)
            case "$SW_H" in
              200|201|204) ANOMALY=$((ANOMALY+1)); ANOM_LIST="$ANOM_LIST $FN(http $SW_H EXECUTED)" ;;
              401|403|404) DENIED=$((DENIED+1)) ;;
              *)           REACHABLE=$((REACHABLE+1)) ;;
            esac ;;
        esac
      done < "$TMPD/invokable.tsv"
    fi

    record P8e "Live anon invocation sweep (type-invalid args; body never runs)" \
      "every call classified; 0 executed-to-success" \
      "swept=$SWEPT denied=$DENIED grant-reachable=$REACHABLE executed=$ANOMALY" \
      "$([ "$ANOMALY" -eq 0 ] && echo PASS || echo FAIL)"
    [ "$ANOMALY" -gt 0 ] && record P8f "Functions that executed to success as anon" "none" "$ANOM_LIST" FAIL

    cp "$TMPD/rigonly.txt"  "$OUT_DIR/anon-rpc-rig-only-$RUN_STAMP.txt"  2>/dev/null
    cp "$TMPD/prodonly.txt" "$OUT_DIR/anon-rpc-prod-only-$RUN_STAMP.txt" 2>/dev/null
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# P9 — Inbound webhook HMAC rejection (item 8). NON-MUTATING: only the FORGED
# leg is sent daily. A valid-signature leg would write a nonce row every day for
# no added assertion; Day-0 already proved the accept path.
# ═════════════════════════════════════════════════════════════════════════════
if want P9; then
  NONCE_BEFORE="$(sql1 "$RIG_SUPABASE_REF" "select count(*)::text as n from docusign_webhook_nonces" n)"
  printf '{"event":"envelope-completed","data":{"envelopeId":"soak-forged-%s"}}' "$RUN_STAMP" > "$TMPD/body.json"
  xcurl "$TMPD/p9" POST "$RIG_URL/webhooks/docusign" "$W_IAM" \
    "Content-Type: application/json" \
    "X-DocuSign-Signature-1: Zm9yZ2VkLXNpZ25hdHVyZS1ub3QtdmFsaWQ=" >/dev/null
  rm -f "$TMPD/body.json"
  P9H="$(http_of "$TMPD/p9")"
  NONCE_AFTER="$(sql1 "$RIG_SUPABASE_REF" "select count(*)::text as n from docusign_webhook_nonces" n)"
  if { [ "$P9H" = "401" ] || [ "$P9H" = "400" ] || [ "$P9H" = "403" ]; } && [ "$NONCE_AFTER" = "$NONCE_BEFORE" ]; then
    record P9a "Forged DocuSign signature rejected AND writes nothing" \
      "401/400/403 AND nonce delta 0" "http $P9H, nonces $NONCE_BEFORE -> $NONCE_AFTER" PASS
  else
    record P9a "Forged DocuSign signature rejected AND writes nothing" \
      "401/400/403 AND nonce delta 0" "http $P9H, nonces $NONCE_BEFORE -> $NONCE_AFTER" FAIL
  fi

  # The Drive rejection path is TOKEN mismatch on a KNOWN channel. An unknown
  # channel id is a different branch (the runner has nothing to resolve and acks),
  # so probing with a made-up channel id proves nothing about the token check —
  # it was the first false FAIL this instrument produced, and the fix is to
  # address a real channel, not to soften the assertion.
  DRIVE_CH="$(sql1 "$RIG_SUPABASE_REF" \
    "select subscription_id as c from org_integrations where provider='google_drive' and subscription_id is not null limit 1" c)"
  case "$DRIVE_CH" in
    ''|'<none>'|'<error>')
      record P9b "Forged Drive channel token rejected on a KNOWN channel" "400/401/403" "no google_drive channel on the rig to address" SKIP ;;
    *)
      xcurl "$TMPD/p9d" POST "$RIG_URL/api/v1/webhooks/drive" "$W_IAM" \
        "X-Goog-Channel-ID: $DRIVE_CH" "X-Goog-Channel-Token: not-the-token-$RUN_STAMP" \
        "X-Goog-Message-Number: 99" >/dev/null
      P9DH="$(http_of "$TMPD/p9d")"
      case "$P9DH" in
        400|401|403) record P9b "Forged Drive channel token rejected on a KNOWN channel" "400/401/403" "http $P9DH" PASS ;;
        *)           record P9b "Forged Drive channel token rejected on a KNOWN channel" "400/401/403" "http $P9DH — ACCEPTED" FAIL ;;
      esac ;;
  esac
fi

# ═════════════════════════════════════════════════════════════════════════════
# P10 — Dashboards, data-level (item 15). Dashboards are JWT-only; an API key
# cannot reach them. Assert SHAPE, never the status code (the §5.1 S17 trap).
# ═════════════════════════════════════════════════════════════════════════════
if want P10 && [ -n "$JWT_A" ]; then
  # The rig runs the IN-MEMORY rate limiter (prod uses Upstash — DECLARED-UNTESTED).
  # It is live and it WILL 429 a probe run that follows the P8 sweep. A 429 is a
  # rate-limit observation, never evidence about the dashboard's payload, and
  # never evidence that an unauthenticated caller was refused. Retry with backoff
  # and, if it persists, report SKIP with the 429 named — a 429 counted as PASS
  # would be the exact hollow assertion this instrument exists to prevent.
  dash() { # id | path | python-expr | description
    local h v attempt=0
    while [ "$attempt" -lt 3 ]; do
      xcurl "$TMPD/d$1" GET "$RIG_URL$2" "$W_IAM" "Authorization: Bearer $JWT_A" >/dev/null
      h="$(http_of "$TMPD/d$1")"
      [ "$h" != "429" ] && break
      attempt=$((attempt+1)); sleep 20
    done
    v="$(jbody "$TMPD/d$1" "$3")"
    if [ "$h" = "429" ]; then
      record "$1" "$4" "200 + non-empty payload" "http 429 after $attempt retries — rate-limited, payload NOT asserted" SKIP
    elif [ "$h" = "200" ] && [ "$v" != "<missing>" ] && [ "$v" != "<unparseable>" ] && [ "$v" != "[]" ]; then
      record "$1" "$4" "200 + non-empty payload" "http $h, keys=$v" PASS
    else
      record "$1" "$4" "200 + non-empty payload" "http $h, keys=$v" FAIL
    fi
  }
  # Assert that a payload with real keys came back — not a guessed field name,
  # which only tests the probe author's memory of the response schema.
  KEYS="sorted(d.keys())[:5] if isinstance(d,dict) and d else ('[]' if d in ([],{},None) else '<missing>')"
  dash P10a "/api/admin/platform-stats" "$KEYS" "Platform overview dashboard returns a populated payload"
  dash P10b "/api/admin/pipeline-stats" "$KEYS" "Pipeline admin dashboard returns a populated payload"
  dash P10c "/api/treasury/status"      "$KEYS" "Treasury dashboard returns a populated payload"
  dash P10d "/api/admin/ops-slo-stats"  "$KEYS" "Ops SLO dashboard returns a populated payload"

  # Anon must not reach any of them. Same 429 discipline: a rate-limited request
  # tells us nothing about authorization.
  AN_H=""; a=0
  while [ "$a" -lt 3 ]; do
    xcurl "$TMPD/d10anon" GET "$RIG_URL/api/admin/platform-stats" "$W_IAM" >/dev/null
    AN_H="$(http_of "$TMPD/d10anon")"
    [ "$AN_H" != "429" ] && break
    a=$((a+1)); sleep 20
  done
  case "$AN_H" in
    401|403) record P10e "Unauthenticated caller cannot read admin dashboards" "401/403" "http $AN_H" PASS ;;
    429)     record P10e "Unauthenticated caller cannot read admin dashboards" "401/403" "http 429 — rate-limited, authorization NOT asserted" SKIP ;;
    *)       record P10e "Unauthenticated caller cannot read admin dashboards" "401/403" "http $AN_H — EXPOSED" FAIL ;;
  esac
fi

# ═════════════════════════════════════════════════════════════════════════════
# Verdict
# ═════════════════════════════════════════════════════════════════════════════
VERDICT="PASS"; [ "$FAIL" -gt 0 ] && VERDICT="FAIL"
{
  echo "----------------------------------------------------------------------"
  echo "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
  echo "DAILY_PROBES: $VERDICT"
  echo "artifact: $OUT_TXT"
} | tee -a "$OUT_TXT"

{
  printf '{\n'
  printf '  \"run_ts\": \"%s\",\n' "$RUN_TS"
  printf '  \"mode\": \"%s\",\n' "$MODE"
  printf '  \"rig_service\": \"%s\",\n' "$RIG_URL"
  printf '  \"rig_supabase_ref\": \"%s\",\n' "$RIG_SUPABASE_REF"
  printf '  \"git_head\": \"%s\",\n' "$(git rev-parse HEAD 2>/dev/null)"
  printf '  \"pass\": %s, \"fail\": %s, \"skip\": %s,\n' "$PASS" "$FAIL" "$SKIP"
  printf '  \"verdict\": \"%s\",\n' "$VERDICT"
  printf '  \"probes\": [%s]\n' "$(printf '%s' "$JSON_ROWS" | sed 's/,$//')"
  printf '}\n'
} > "$OUT_JSON"

[ "$VERDICT" = "PASS" ] && exit 0 || exit 1
