#!/usr/bin/env bash
# scripts/staging/fullsoak-mcp-probe.sh
#
# Edge MCP surface probe for the 2026-08 7-day full-functionality soak.
# Closes founder-coverage GAP 1 / runbook §4 S12: "all 16 tools, driven daily
# from a real MCP client, per-tool observable effect asserted".
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
# `edge.arkova.ai` serves a 16-tool MCP surface behind `X-API-Key` / OAuth
# bearer. Until this script, NOTHING exercised it during the soak: the runbook
# listed S12 as IN, the SDK smoke covers the *worker* REST API, and the
# Playwright suite is browser-only. The surface was asserted, never driven.
#
# ── WHY IT DOES NOT DRIVE edge.arkova.ai BY DEFAULT ──────────────────────────
# The deployed Cloudflare Worker is bound to the PRODUCTION Supabase project.
# The Day-0 soak key (`arkova-fullsoak-2026-08-apikey-soak-mcp`) lives in the
# soak rig's DB, so it is rejected 401 by edge.arkova.ai — VERIFIED, see the
# gap-closure doc. There is therefore no way to drive the deployed MCP surface
# with soak-grade credentials, and driving it with a PRODUCTION key would put
# `anchor_document` writes into the prod ledger. So the default target is the
# SAME edge worker source, run locally under `wrangler dev`, bound to the
# mutable SIDE-RIG (Supabase `ehqqearcitrgloibtjqx` + the connector-sidecar
# Cloud Run worker). Same code, same auth path, writable fixtures.
#
#   --remote            drive https://edge.arkova.ai instead. Auth-negative
#                       probes + the reachability checks run; every tool call
#                       is SKIPPED unless --allow-remote-tools is also given,
#                       which you should not do without a prod-valid key and
#                       an explicit decision about anchor_document.
#
# ── ASSERTION DISCIPLINE ─────────────────────────────────────────────────────
# No assertion is "HTTP 200". Every tool asserts either a NAMED row it must
# return (a seeded public_id / fingerprint / org / agent resolved live from the
# rig DB) or a named row-count delta on a specific `content_hash`. Known
# defects are asserted in their CORRECT direction and reported as FAIL — this
# script never softens an assertion to manufacture a green run.
#
# ── CONSTITUTIONAL LIMITS (CLAUDE.md §1.11A) ─────────────────────────────────
# * NEVER touches `arkova-worker-fullsoak-2026-08-staging`, Supabase
#   `gnkuaywlpmsaezwvlvhk`, shared staging, or prod. The only writes are to the
#   side-rig, and the only write path is `anchor_document`, whose row is tagged
#   `source=soak_probe` so it is trivially separable from real ingestion.
# * Read-only probes against prod/soak hosts (reachability, auth-negative) are
#   GETs and unauthenticated POSTs only.
#
# ── DEPENDENCIES ─────────────────────────────────────────────────────────────
#   gcloud, curl, python3, node, npx (wrangler). Bash 3.2 compatible.
#
# ── USAGE ────────────────────────────────────────────────────────────────────
#   ./scripts/staging/fullsoak-mcp-probe.sh
#   ./scripts/staging/fullsoak-mcp-probe.sh --remote
#   MCP_BASE=http://127.0.0.1:8791 ./scripts/staging/fullsoak-mcp-probe.sh --no-serve
#
# Exit: 0 all assertions pass · 1 one or more FAIL · 2 harness error.

set -uo pipefail

GCP_PROJECT="${GCP_PROJECT:-arkova1}"
SIDE_RIG_REF="${SIDE_RIG_REF:-ehqqearcitrgloibtjqx}"
SIDE_WORKER_URL="${SIDE_WORKER_URL:-https://arkova-worker-connector-sidecar-2026-08-staging-270018525501.us-central1.run.app}"
SB_URL_SECRET="${SB_URL_SECRET:-supabase-url-connector-sidecar-2026-08-staging}"
SB_SRK_SECRET="${SB_SRK_SECRET:-supabase-service-role-key-connector-sidecar-2026-08-staging}"
APIKEY_SECRET="${APIKEY_SECRET:-arkova-sidecar-2026-08-apikey-mcp-probe}"
PROD_EDGE="${PROD_EDGE:-https://edge.arkova.ai}"
LOCAL_PORT="${LOCAL_PORT:-8791}"

# Refs this script must never write to. Fail-closed on a fat-fingered override.
PROTECTED_REFS="gnkuaywlpmsaezwvlvhk ujtlwnoqfhtitcmsnrpq vzwyaatejekddvltxyye"

REMOTE=0
ALLOW_REMOTE_TOOLS=0
SERVE=1
for arg in "$@"; do
  case "$arg" in
    --remote)             REMOTE=1 ; SERVE=0 ;;
    --allow-remote-tools) ALLOW_REMOTE_TOOLS=1 ;;
    --no-serve)           SERVE=0 ;;
    -h|--help)            sed -n '2,55p' "$0" ; exit 0 ;;
    *) echo "unknown argument: $arg" >&2 ; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_TS="$(date -u +%Y-%m-%dT%H%M%SZ)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcp-probe.XXXXXX")"
EVIDENCE_DIR="${EVIDENCE_DIR:-$REPO_ROOT/docs/staging/evidence/fullsoak-2026-08/$(date -u +%Y-%m-%d)}"
REPORT="$EVIDENCE_DIR/mcp-probe-$RUN_TS.md"

PASS=0 ; FAIL=0 ; SKIP=0
WRANGLER_PID=""

cleanup() {
  if [ -n "$WRANGLER_PID" ]; then kill "$WRANGLER_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

say()  { printf '%s\n' "$*"; }
head2(){ printf '\n=== %s ===\n' "$*"; }

# record <PASS|FAIL|SKIP> <id> <what was asserted> <observed>
record() {
  local st="$1" id="$2" what="$3" obs="$4"
  case "$st" in
    PASS) PASS=$((PASS+1)) ;;
    FAIL) FAIL=$((FAIL+1)) ;;
    *)    SKIP=$((SKIP+1)) ;;
  esac
  printf '%-4s %-22s %s\n' "$st" "$id" "$what"
  [ -n "$obs" ] && printf '       observed: %s\n' "$(printf '%s' "$obs" | head -c 300 | tr '\n' ' ')"
  printf '| `%s` | %s | %s | **%s** |\n' \
    "$id" "$what" "$(printf '%s' "$obs" | head -c 260 | tr '\n' ' ' | sed 's/|/\\|/g')" "$st" >> "$WORK/rows.md"
}

need() { command -v "$1" >/dev/null 2>&1 || { say "FATAL: $1 not on PATH"; exit 2; }; }
need curl ; need python3 ; need gcloud

for ref in $PROTECTED_REFS; do
  if [ "$SIDE_RIG_REF" = "$ref" ]; then
    say "FATAL: SIDE_RIG_REF=$SIDE_RIG_REF is a PROTECTED project. Refusing to run."
    exit 2
  fi
done

secret() { gcloud secrets versions access latest --secret="$1" --project="$GCP_PROJECT" 2>/dev/null; }

SB_URL="$(secret "$SB_URL_SECRET")"
SB_SRK="$(secret "$SB_SRK_SECRET")"
API_KEY="$(secret "$APIKEY_SECRET")"
[ -n "$SB_URL" ] && [ -n "$SB_SRK" ] && [ -n "$API_KEY" ] || { say "FATAL: could not read side-rig secrets"; exit 2; }
case "$SB_URL" in *"$SIDE_RIG_REF"*) : ;; *) say "FATAL: $SB_URL_SECRET does not point at $SIDE_RIG_REF"; exit 2 ;; esac

# ── PostgREST helpers (side-rig, service role) ───────────────────────────────
pg() { # pg <path-with-query>
  curl -sS --max-time 20 "$SB_URL/rest/v1/$1" \
    -H "apikey: $SB_SRK" -H "Authorization: Bearer $SB_SRK"
}
pg_count() { # pg_count <table?filters>  -> exact row count
  curl -sS --max-time 20 -o /dev/null -D- "$SB_URL/rest/v1/$1" \
    -H "apikey: $SB_SRK" -H "Authorization: Bearer $SB_SRK" \
    -H 'Prefer: count=exact' -H 'Range: 0-0' \
    | tr -d '\r' | awk 'tolower($1)=="content-range:"{split($2,a,"/"); print a[2]}'
}

# ── Boot the edge worker under wrangler dev, bound to the SIDE-RIG ───────────
if [ "$SERVE" = "1" ]; then
  head2 "Phase 0 — booting services/edge under wrangler dev (side-rig bound)"
  DEV_VARS="$REPO_ROOT/services/edge/.dev.vars"
  if [ ! -f "$DEV_VARS" ]; then
    {
      echo "SUPABASE_URL=$SB_URL"
      echo "SUPABASE_SERVICE_ROLE_KEY=$SB_SRK"
      echo "WORKER_BASE_URL=$SIDE_WORKER_URL"
      echo "MCP_ENABLE_ANCHOR_DOCUMENT=true"
      echo "MCP_SIGNING_KEY=$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
      echo "ALLOWED_ORIGINS=https://app.arkova.ai"
    } > "$DEV_VARS"
    chmod 600 "$DEV_VARS"
    say "wrote $DEV_VARS (gitignored)"
  fi
  ( cd "$REPO_ROOT/services/edge" && npx wrangler dev --port "$LOCAL_PORT" --local --ip 127.0.0.1 >"$WORK/wrangler.log" 2>&1 ) &
  WRANGLER_PID=$!
  for _ in $(seq 1 40); do
    sleep 2
    grep -q "Ready on http" "$WORK/wrangler.log" && break
  done
  grep -q "Ready on http" "$WORK/wrangler.log" || { say "FATAL: wrangler dev did not come up"; tail -20 "$WORK/wrangler.log"; exit 2; }
  say "wrangler dev ready on 127.0.0.1:$LOCAL_PORT"
fi

if [ "$REMOTE" = "1" ]; then
  MCP_BASE="${MCP_BASE:-$PROD_EDGE}"
else
  MCP_BASE="${MCP_BASE:-http://127.0.0.1:$LOCAL_PORT}"
fi
say "MCP target: $MCP_BASE"

# ── MCP JSON-RPC helpers ─────────────────────────────────────────────────────
rpc() { # rpc <json-body> [extra curl args...]  -> body on stdout
  local body="$1"; shift
  curl -sS --max-time 45 -X POST "$MCP_BASE/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    "$@" -d "$body"
}
rpc_code() { # rpc_code [extra curl args...] -> HTTP status for a tools/list POST
  curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST "$MCP_BASE/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    "$@" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
}
tool_text() { # tool_text <name> <args-json> -> the tool's text payload on stdout
  rpc "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
      -H "X-API-Key: $API_KEY" \
  | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception as e:
    print("HARNESS_PARSE_ERROR: %s" % e); raise SystemExit(0)
r=d.get("result") or {}
if "error" in d: print("RPC_ERROR: %s" % json.dumps(d["error"])); raise SystemExit(0)
c=(r.get("content") or [{}])[0].get("text","")
if r.get("isError"): print("TOOL_ERROR: %s" % c)
else: print(c)'
}
# jcheck <json-text> <python-expr over `d`> -> prints "1" or "0"
jcheck() {
  python3 -c 'import json,sys
raw=sys.argv[1]; expr=sys.argv[2]
try: d=json.loads(raw)
except Exception: print("0"); raise SystemExit(0)
try: print("1" if eval(expr) else "0")
except Exception: print("0")' "$1" "$2"
}

mkdir -p "$EVIDENCE_DIR"
: > "$WORK/rows.md"

# ── Phase 1 — reachability + auth-negative (safe on every host) ──────────────
head2 "Phase 1 — reachability + auth-negative"

PRM="$(curl -sS --max-time 20 "$MCP_BASE/mcp/.well-known/oauth-protected-resource")"
if [ "$(jcheck "$PRM" 'd.get("resource","").endswith("/mcp") and isinstance(d.get("scopes_supported"),list)')" = "1" ]; then
  record PASS N-01 "RFC 9728 protected-resource metadata is served and well-formed" "$PRM"
else
  record FAIL N-01 "RFC 9728 protected-resource metadata is served and well-formed" "$PRM"
fi

C="$(rpc_code)"
[ "$C" = "401" ] && record PASS N-02 "no credential -> 401" "HTTP $C" || record FAIL N-02 "no credential -> 401" "HTTP $C"
C="$(rpc_code -H 'X-API-Key: ak_live_deliberately_invalid_key')"
case "$C" in
  401|403) record PASS N-03 "invalid X-API-Key -> 401/403" "HTTP $C" ;;
  *)       record FAIL N-03 "invalid X-API-Key -> 401/403" "HTTP $C" ;;
esac
C="$(rpc_code -H 'X-API-Key: ')"
[ "$C" = "401" ] && record PASS N-04 "empty X-API-Key -> 401" "HTTP $C" || record FAIL N-04 "empty X-API-Key -> 401" "HTTP $C"
C="$(rpc_code -H 'Authorization: Bearer not.a.jwt')"
[ "$C" = "401" ] && record PASS N-05 "malformed OAuth bearer -> 401" "HTTP $C" || record FAIL N-05 "malformed OAuth bearer -> 401" "HTTP $C"

# S17 reachability: /.well-known/arkova-keys.json is served by the WORKER
# (services/worker/src/api/proof-keys.ts), not the edge. Assert 200 + key
# material on the worker host. Recorded as FAIL while it 404s — never softened.
KEYS_CODE="$(curl -sS --max-time 20 -o "$WORK/keys.json" -w '%{http_code}' "$SIDE_WORKER_URL/.well-known/arkova-keys.json")"
if [ "$KEYS_CODE" = "200" ] && [ "$(jcheck "$(cat "$WORK/keys.json")" 'bool(d.get("keys"))')" = "1" ]; then
  record PASS S-17 "/.well-known/arkova-keys.json serves 200 + key material" "HTTP $KEYS_CODE"
else
  record FAIL S-17 "/.well-known/arkova-keys.json serves 200 + key material" "HTTP $KEYS_CODE (proof-keys.ts is never imported by services/worker/src/index.ts)"
fi

if [ "$REMOTE" = "1" ] && [ "$ALLOW_REMOTE_TOOLS" != "1" ]; then
  record SKIP T-ALL "16 tool invocations (remote target; --allow-remote-tools not given)" "$MCP_BASE is prod-bound; soak keys 401 there and anchor_document would write the prod ledger"
else

# ── Phase 2 — resolve NAMED fixtures live from the side-rig ──────────────────
head2 "Phase 2 — resolving named fixtures from $SIDE_RIG_REF"

jfield() { python3 -c 'import json,sys
try:
    d=json.loads(sys.argv[1]); print(d[0][sys.argv[2]] if d else "")
except Exception: print("")' "$1" "$2"; }

FIX="$(pg "anchors?status=eq.SECURED&deleted_at=is.null&select=public_id,fingerprint,filename,credential_type,org_id&order=created_at.desc&limit=1")"
FIX_PID="$(jfield "$FIX" public_id)"
FIX_FP="$(jfield "$FIX" fingerprint)"
FIX_NAME="$(jfield "$FIX" filename)"
[ -n "${FIX_PID:-}" ] || { say "FATAL: no SECURED anchor on the side-rig to assert against"; exit 2; }
# A distinctive whole-word token from the fixture's filename, and a non-word
# INTERNAL fragment of that token (used by the claims probe below).
LEX_TERM="$(python3 -c 'import re,sys
n=sys.argv[1]
toks=[t for t in re.split(r"[^A-Za-z]+", n) if len(t)>=5]
print(toks[0] if toks else n[:6])' "$FIX_NAME")"
FRAGMENT="$(python3 -c 'import sys; t=sys.argv[1]; print(t[1:-1] if len(t)>=6 else t)' "$LEX_TERM")"
# The MCP caller identity is `api_keys.created_by`; org-scoped tools resolve
# through org_members for THAT user, so the fixtures must too.
PROBE_KEY_NAME="${PROBE_KEY_NAME:-SCRUM-3140 side-rig MCP probe}"
PROBE_KEY_NAME_ENC="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$PROBE_KEY_NAME")"
KEY_OWNER="$(jfield "$(pg "api_keys?select=created_by&is_active=eq.true&name=eq.$PROBE_KEY_NAME_ENC&limit=1")" created_by)"
[ -n "$KEY_OWNER" ] || { say "FATAL: no active api_keys row named '$PROBE_KEY_NAME' on $SIDE_RIG_REF"; exit 2; }
ORG_PID="$(python3 -c 'import json,sys
try:
    d=json.loads(sys.argv[1]); print(((d[0] or {}).get("organizations") or {}).get("public_id","") if d else "")
except Exception: print("")' "$(pg "org_members?user_id=eq.$KEY_OWNER&select=organizations(public_id)&limit=1")")"
AGENT_NAME="$(jfield "$(pg "agents?select=name&status=eq.active&order=created_at.desc&limit=1")" name)"
say "fixture anchor : $FIX_PID  ($FIX_NAME)"
say "fixture term   : '$LEX_TERM'   internal fragment: '$FRAGMENT'"
say "fixture org    : $ORG_PID"
say "fixture agent  : $AGENT_NAME"

AUDIT_BEFORE="$(pg_count "audit_events?event_type=eq.MCP_TOOL_CALL&select=id")"

# ── Phase 3 — all 16 tools, one named assertion each ────────────────────────
head2 "Phase 3 — 16 tools, named assertion each"

LIST="$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' -H "X-API-Key: $API_KEY")"
NTOOLS="$(python3 -c 'import json,sys
try: print(len(json.loads(sys.argv[1])["result"]["tools"]))
except Exception: print(-1)' "$LIST")"
TOOLNAMES="$(python3 -c 'import json,sys
try: print(",".join(sorted(t["name"] for t in json.loads(sys.argv[1])["result"]["tools"])))
except Exception: print("")' "$LIST")"
[ "$NTOOLS" = "16" ] \
  && record PASS T-00 "tools/list advertises exactly 16 tools" "$TOOLNAMES" \
  || record FAIL T-00 "tools/list advertises exactly 16 tools" "count=$NTOOLS names=$TOOLNAMES"

R="$(tool_text verify_credential "{\"public_id\":\"$FIX_PID\"}")"
[ "$(jcheck "$R" "d.get('verified') is True and d.get('record_uri','').endswith('$FIX_PID')")" = "1" ] \
  && record PASS T-01 "verify_credential($FIX_PID) returns verified=true for that exact public_id" "$R" \
  || record FAIL T-01 "verify_credential($FIX_PID) returns verified=true for that exact public_id" "$R"

R="$(tool_text search_credentials "{\"query\":\"$LEX_TERM\",\"max_results\":10}")"
[ "$(jcheck "$R" "any(x.get('public_id')=='$FIX_PID' for x in d.get('results',[])) and 'search_mode' in d")" = "1" ] \
  && record PASS T-02 "search_credentials('$LEX_TERM') returns $FIX_PID and labels search_mode" "$R" \
  || record FAIL T-02 "search_credentials('$LEX_TERM') returns $FIX_PID and labels search_mode" "$R"

R="$(tool_text search "{\"q\":\"$LEX_TERM\",\"type\":\"record\",\"limit\":10}")"
[ "$(jcheck "$R" "any(x.get('public_id')=='$FIX_PID' for x in d.get('results',[]))")" = "1" ] \
  && record PASS T-03 "search(q='$LEX_TERM',type=record) returns $FIX_PID" "$R" \
  || record FAIL T-03 "search(q='$LEX_TERM',type=record) returns $FIX_PID" "$R"

R="$(tool_text verify "{\"fingerprint\":\"$FIX_FP\"}")"
[ "$(jcheck "$R" "d.get('verified') is True and d.get('public_id')=='$FIX_PID'")" = "1" ] \
  && record PASS T-04 "verify(<fingerprint of $FIX_PID>) resolves to that public_id" "$R" \
  || record FAIL T-04 "verify(<fingerprint of $FIX_PID>) resolves to that public_id" "$R"

R="$(tool_text list_orgs '{}')"
[ "$(jcheck "$R" "any(o.get('public_id')=='$ORG_PID' for o in d.get('organizations',[]))")" = "1" ] \
  && record PASS T-05 "list_orgs contains the caller's own org $ORG_PID" "$R" \
  || record FAIL T-05 "list_orgs contains the caller's own org $ORG_PID" "$R"

R="$(tool_text get_anchor "{\"public_id\":\"$FIX_PID\"}")"
[ "$(jcheck "$R" "d.get('anchor_timestamp') and d.get('status') in ('ACTIVE','REVOKED','SUPERSEDED','EXPIRED')")" = "1" ] \
  && record PASS T-06 "get_anchor($FIX_PID) returns a lifecycle status + anchor_timestamp" "$R" \
  || record FAIL T-06 "get_anchor($FIX_PID) returns a lifecycle status + anchor_timestamp" "$R"

R="$(tool_text get_organization "{\"public_id\":\"$ORG_PID\"}")"
[ "$(jcheck "$R" "d.get('public_id')=='$ORG_PID' and bool(d.get('display_name'))")" = "1" ] \
  && record PASS T-07 "get_organization($ORG_PID) returns that org's display_name" "$R" \
  || record FAIL T-07 "get_organization($ORG_PID) returns that org's display_name" "$R"

R="$(tool_text get_record "{\"public_id\":\"$FIX_PID\"}")"
[ "$(jcheck "$R" "d.get('record_uri','').endswith('$FIX_PID')")" = "1" ] \
  && record PASS T-08 "get_record($FIX_PID) returns that record" "$R" \
  || record FAIL T-08 "get_record($FIX_PID) returns that record" "$R"

R="$(tool_text get_fingerprint "{\"fingerprint\":\"$FIX_FP\"}")"
[ "$(jcheck "$R" "d.get('public_id')=='$FIX_PID'")" = "1" ] \
  && record PASS T-09 "get_fingerprint(<$FIX_PID's hash>) resolves to that public_id" "$R" \
  || record FAIL T-09 "get_fingerprint(<$FIX_PID's hash>) resolves to that public_id" "$R"

R="$(tool_text get_document "{\"public_id\":\"$FIX_PID\"}")"
[ "$(jcheck "$R" "d.get('record_uri','').endswith('$FIX_PID')")" = "1" ] \
  && record PASS T-10 "get_document($FIX_PID) returns that document" "$R" \
  || record FAIL T-10 "get_document($FIX_PID) returns that document" "$R"

PR_BEFORE="$(pg_count "public_records?select=id")"
R="$(tool_text nessie_query '{"query":"SEC filing risk factors","mode":"retrieval","limit":3}')"
[ "$(jcheck "$R" "d.get('mode')=='retrieval' and isinstance(d.get('total'),int)")" = "1" ] \
  && record PASS T-11 "nessie_query(retrieval) returns a well-formed retrieval envelope" "$R" \
  || record FAIL T-11 "nessie_query(retrieval) returns a well-formed retrieval envelope" "$R"

# Nessie is a permanently-disabled capability (founder directive 2026-08-01).
# The CORRECT behaviour is an explicit disabled/error result. A synthesized
# natural-language `answer` with confidence 0 is a fail-OPEN. Asserted in the
# correct direction; it fails today and that is the point.
R="$(tool_text nessie_query '{"query":"What are the disclosed risk factors?","mode":"context","limit":3}')"
[ "$(jcheck "$R" "('disabled' in json.dumps(d).lower()) or not d.get('answer')")" = "1" ] \
  && record PASS T-12 "nessie_query(context) fails CLOSED for a disabled capability" "$R" \
  || record FAIL T-12 "nessie_query(context) fails CLOSED for a disabled capability" "$R"

PROBE_HASH="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
BEFORE="$(pg_count "public_records?content_hash=eq.$PROBE_HASH&select=id")"
R="$(tool_text anchor_document "{\"content_hash\":\"$PROBE_HASH\",\"record_type\":\"document\",\"source\":\"soak_probe\",\"title\":\"MCP probe $RUN_TS\"}")"
sleep 2
AFTER="$(pg_count "public_records?content_hash=eq.$PROBE_HASH&select=id")"
[ "$BEFORE" = "0" ] && [ "$AFTER" = "1" ] \
  && record PASS T-13 "anchor_document: public_records rows for that exact content_hash 0 -> 1" "before=$BEFORE after=$AFTER resp=$R" \
  || record FAIL T-13 "anchor_document: public_records rows for that exact content_hash 0 -> 1" "before=$BEFORE after=$AFTER resp=$R"

# The tool's own stated follow-up ("Check status with verify_document") must
# resolve the fingerprint it just accepted. It does not — public_records rows
# are orphaned from `anchors` until a feeder links them.
R="$(tool_text verify_document "{\"content_hash\":\"$PROBE_HASH\"}")"
[ "$(jcheck "$R" "d.get('public_id') is not None")" = "1" ] \
  && record PASS T-14 "verify_document resolves the fingerprint anchor_document just accepted" "$R" \
  || record FAIL T-14 "verify_document resolves the fingerprint anchor_document just accepted" "$R"

R="$(tool_text verify_document "{\"content_hash\":\"$FIX_FP\"}")"
[ "$(jcheck "$R" "d.get('verified') is True and d.get('public_id')=='$FIX_PID'")" = "1" ] \
  && record PASS T-15 "verify_document(<seeded hash>) resolves to $FIX_PID" "$R" \
  || record FAIL T-15 "verify_document(<seeded hash>) resolves to $FIX_PID" "$R"

R="$(tool_text verify_batch "{\"public_ids\":[\"$FIX_PID\",\"ARK-NOSUCH-000000\"]}")"
[ "$(jcheck "$R" "d.get('total')==2 and sum(1 for x in d.get('results',[]) if x.get('verified') is True)==1")" = "1" ] \
  && record PASS T-16 "verify_batch returns 2 results: the seeded id verified, the bogus id not" "$R" \
  || record FAIL T-16 "verify_batch returns 2 results: the seeded id verified, the bogus id not" "$R"

R="$(tool_text oracle_batch_verify "{\"public_ids\":[\"$FIX_PID\"]}")"
[ "$(jcheck "$R" "len(d.get('payload',{}).get('results',[]))==1 and (d.get('signature') or d.get('signed') is False)")" = "1" ] \
  && record PASS T-17 "oracle_batch_verify returns a query envelope with an explicit signing state" "$R" \
  || record FAIL T-17 "oracle_batch_verify returns a query envelope with an explicit signing state" "$R"

R="$(tool_text list_agents '{}')"
[ "$(jcheck "$R" "any(a.get('name')=='$AGENT_NAME' for a in d.get('agents',[]))")" = "1" ] \
  && record PASS T-18 "list_agents returns the caller-org agent '$AGENT_NAME'" "$R" \
  || record FAIL T-18 "list_agents returns the caller-org agent '$AGENT_NAME'" "$R"

# ── Phase 4 — claims probes ─────────────────────────────────────────────────
head2 "Phase 4 — claims probes"

# A-3.1b (i): a NON-WORD internal fragment of the fixture's title. A semantic
# (vector) engine cannot match gibberish; a literal ILIKE %fragment% can. A hit
# here PROVES the path is substring matching, whatever `search_mode` claims.
R="$(tool_text search_credentials "{\"query\":\"$FRAGMENT\",\"max_results\":10}")"
HIT="$(jcheck "$R" "any(x.get('public_id')=='$FIX_PID' for x in d.get('results',[]))")"
MODE="$(jcheck "$R" "d.get('search_mode')=='semantic_vector'")"
if [ "$HIT" = "1" ] && [ "$MODE" = "1" ]; then
  record FAIL A-3.1b-i "a non-word fragment ('$FRAGMENT') must NOT match while search_mode says semantic_vector" "$R"
elif [ "$HIT" = "1" ]; then
  record FAIL A-3.1b-i "search_credentials must not be substring matching ('$FRAGMENT' matched $FIX_PID)" "$R"
else
  record PASS A-3.1b-i "a non-word fragment ('$FRAGMENT') does not match — path is not substring matching" "$R"
fi

# A-3.1b (ii): an English paraphrase sharing no substring with the title.
R="$(tool_text search_credentials '{"query":"documents proving professional standing issued by an accredited body","max_results":10}')"
[ "$(jcheck "$R" "d.get('total',0)>0")" = "1" ] \
  && record PASS A-3.1b-ii "a semantic paraphrase returns >0 results" "$R" \
  || record FAIL A-3.1b-ii "a semantic paraphrase returns >0 results" "$R"

# MCP-SEC-06: every tool invocation must leave an audit row.
sleep 2
AUDIT_AFTER="$(pg_count "audit_events?event_type=eq.MCP_TOOL_CALL&select=id")"
if [ "${AUDIT_AFTER:-0}" -gt "${AUDIT_BEFORE:-0}" ]; then
  record PASS SEC-06 "audit_events MCP_TOOL_CALL rows increase across the run" "before=$AUDIT_BEFORE after=$AUDIT_AFTER"
else
  record FAIL SEC-06 "audit_events MCP_TOOL_CALL rows increase across the run" "before=$AUDIT_BEFORE after=$AUDIT_AFTER — every insert is rejected 400 (event_category 'security' vs the CHECK's uppercase 'SECURITY')"
fi

say "public_records total before/after the run: $PR_BEFORE / $(pg_count "public_records?select=id") (side-rig ingestion runs concurrently — this is context, not an assertion)"

fi # end tool phase

# ── Report ──────────────────────────────────────────────────────────────────
{
  echo "# Edge MCP probe — $RUN_TS"
  echo
  echo "- Target: \`$MCP_BASE\`$([ "$SERVE" = "1" ] && echo ' (services/edge under `wrangler dev`, bound to the side-rig)')"
  echo "- Side-rig Supabase: \`$SIDE_RIG_REF\` · worker \`$SIDE_WORKER_URL\`"
  echo "- Result: **$PASS pass · $FAIL fail · $SKIP skip**"
  echo
  echo "| id | assertion | observed | result |"
  echo "|---|---|---|---|"
  cat "$WORK/rows.md"
} > "$REPORT"

head2 "Summary"
say "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
say "report: $REPORT"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
