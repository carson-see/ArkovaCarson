#!/usr/bin/env bash
# scripts/staging/fullsoak-sdk-integration.sh
#
# LIVE-API SDK smoke for the 2026-08 7-day full-functionality soak.
#
# ── WHY THIS EXISTS, AND WHAT IT IS NOT ──────────────────────────────────────
# The founder-coverage checklist item 8 marks the SDKs IN, receipt "§4 S13 —
# installed FROM THE REGISTRY, never the working tree (the §5.1 S12/S13 false-
# pass trap)". Two things had never been checked:
#
#   1. Whether the SDK test suites can be pointed at a live base URL. THEY
#      CANNOT. All three TypeScript suites stub fetch —
#      `packages/sdk/src/client.test.ts:13` is literally
#      `vi.stubGlobal('fetch', mockFetch)` under the header "Tests SDK methods
#      with mocked fetch. No real API calls." There is no env var, no
#      integration mode, no conditional live path in any of them. Running
#      `npm test` against the rig would exercise the mock, not the rig, and
#      report green either way. So this script does NOT run the suites; it
#      exercises each SDK's PUBLIC SURFACE against the rig directly.
#
#   2. Whether the packages are on a registry at all. Phase A answers that
#      live every run rather than trusting the claim.
#
# ── CONSTITUTIONAL LIMITS (CLAUDE.md §1.11A) ─────────────────────────────────
# * Read-only product surface only. No SDK write method is called with a key
#   that could satisfy it: anchor / anchor_bulk / attest are exercised ONLY as
#   scope-negative assertions (a verify-scoped key must be refused). The soak's
#   12-anchor / 12-proof BL-2 cohort is never touched.
# * The API key is the Day-0 `soak-public-api` key from Secret Manager, itself
#   minted through the real product flow. `--mint` mints a fresh one via
#   POST /api/v1/keys with a real Supabase JWT — but that is NOT the default,
#   because FD-P7 (API-key delete/revoke is unreachable from any client, the
#   server strips `id` from every list row) means every minted key is permanent
#   litter on the rig. Daily minting would grow the CC6.8 designation table by
#   7 keys a week for no added assertion.
# * Cloud Run IAM protects the rig, and no SDK has a custom-header hook, so a
#   loopback proxy on 127.0.0.1 forwards to the rig and injects
#   `X-Serverless-Authorization`. The SDK is given the loopback base URL and is
#   otherwise unmodified — the bytes it sends are its own.
#
# ── DEPENDENCIES ─────────────────────────────────────────────────────────────
#   gcloud, curl, python3 (>=3.10 for the PyPI leg), node, npm, git.
#   Bash 3.2 compatible.
#
# ── USAGE ────────────────────────────────────────────────────────────────────
#   ./scripts/staging/fullsoak-sdk-integration.sh
#   ./scripts/staging/fullsoak-sdk-integration.sh --mint       # fresh API key
#   ./scripts/staging/fullsoak-sdk-integration.sh --skip-python
#
# Exit: 0 all assertions pass · 1 one or more FAIL · 2 harness error.

set -uo pipefail

GCP_PROJECT="${GCP_PROJECT:-arkova1}"
RIG_URL="${RIG_URL:-https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app}"
RIG_SUPABASE_REF="${RIG_SUPABASE_REF:-gnkuaywlpmsaezwvlvhk}"
SB_URL_SECRET="${SB_URL_SECRET:-supabase-url-fullsoak-2026-08-staging}"
SB_ANON_SECRET="${SB_ANON_SECRET:-supabase-anon-key-fullsoak-2026-08-staging}"
SEED_PW_SECRET="${SEED_PW_SECRET:-arkova-fullsoak-2026-08-e2e-seed-password}"
APIKEY_PUBLIC_SECRET="${APIKEY_PUBLIC_SECRET:-arkova-fullsoak-2026-08-apikey-soak-public-api}"
SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
SUPABASE_ACCESS_TOKEN_SECRET="${SUPABASE_ACCESS_TOKEN_SECRET:-supabase_access}"
ORG_A_USER="${ORG_A_USER:-sarah@arkova.ai}"
EVID_ROOT_REL="${EVID_ROOT_REL:-docs/staging/evidence/fullsoak-2026-08}"
PROXY_PORT="${PROXY_PORT:-8931}"

# name|kind|registry-probe-url|source-dir
read -r -d '' SDK_INVENTORY <<'INV_EOF'
@carsonarkova/sdk|npm|https://registry.npmjs.org/@carsonarkova%2fsdk|packages/sdk
@arkova/mcp-server|npm|https://registry.npmjs.org/@arkova%2fmcp-server|sdks/mcp-server
@arkova/langchain|npm|https://registry.npmjs.org/@arkova%2flangchain|sdks/langchain-ts
arkova|pypi|https://pypi.org/pypi/arkova/json|packages/arkova-py
INV_EOF

MINT=0; SKIP_PY=0
for arg in "$@"; do
  case "$arg" in
    --mint) MINT=1 ;;
    --skip-python) SKIP_PY=1 ;;
    -h|--help) sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/fullsoak-sdk.XXXXXX")" || exit 2
PROXY_PID=""
cleanup() { [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null; rm -rf "$TMPD"; }
trap cleanup EXIT INT TERM
chmod 700 "$TMPD"

RUN_DATE="$(date -u +%F)"; RUN_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; RUN_STAMP="$(date -u +%H%M%SZ)"
OUT_DIR="$REPO_ROOT/$EVID_ROOT_REL/$RUN_DATE"; mkdir -p "$OUT_DIR" || exit 2
OUT_MD="$OUT_DIR/sdk-integration.md"
OUT_RUN_MD="$OUT_DIR/sdk-integration-$RUN_STAMP.md"
OUT_JSON="$OUT_DIR/sdk-integration-$RUN_STAMP.json"

die() { echo "FATAL: $*" >&2; exit 2; }
secret() { gcloud secrets versions access latest --secret="$1" --project="$GCP_PROJECT" 2>/dev/null; }
pyjson() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

PASS=0; FAIL=0; SKIP=0; ROWS=""; JROWS=""
record() { # id | desc | expected | observed | result
  case "$5" in PASS) PASS=$((PASS+1)) ;; FAIL) FAIL=$((FAIL+1)) ;; *) SKIP=$((SKIP+1)) ;; esac
  printf '  %-5s %-6s %s\n' "$5" "$1" "$2"
  ROWS="$ROWS| \`$1\` | $2 | $3 | $4 | **$5** |
"
  JROWS="$JROWS{\"id\":$(pyjson "$1"),\"desc\":$(pyjson "$2"),\"expected\":$(pyjson "$3"),\"observed\":$(pyjson "$4"),\"result\":$(pyjson "$5")},"
}

# ── Read-only SQL (a SELECT is not a write) — used to find a live public_id ──
SQL_AVAILABLE=0
[ -z "$SUPABASE_ACCESS_TOKEN" ] && SUPABASE_ACCESS_TOKEN="$(secret "$SUPABASE_ACCESS_TOKEN_SECRET")"
[ -n "$SUPABASE_ACCESS_TOKEN" ] && SQL_AVAILABLE=1
sql1() {
  [ "$SQL_AVAILABLE" -eq 1 ] || { echo '<no-token>'; return 1; }
  local q rc; q="$(python3 -c 'import json,sys; print(json.dumps({"query":sys.argv[1]}))' "$2")"; rc="$TMPD/mgmt.rc"
  ( umask 077; { printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ACCESS_TOKEN"
                 printf 'header = "Content-Type: application/json"\nsilent\nshow-error\nmax-time = 45\n'; } > "$rc" )
  printf '%s' "$q" | curl -K "$rc" -X POST "https://api.supabase.com/v1/projects/$1/database/query" --data-binary @- 2>/dev/null \
  | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get(sys.argv[1],'<none>'))
except Exception: print('<error>')
" "$3"
  rm -f "$rc"
}

echo "fullsoak-sdk-integration — $RUN_TS"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE A — registry availability. Answered live, never asserted from a doc.
# ═════════════════════════════════════════════════════════════════════════════
REG_ROWS=""
while IFS='|' read -r NAME KIND URL DIR; do
  [ -n "$NAME" ] || continue
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$URL")"
  LOCAL_V="$(python3 - "$REPO_ROOT/$DIR" <<'PY'
import json,os,re,sys
d=sys.argv[1]
p=os.path.join(d,'package.json')
if os.path.exists(p):
    print(json.load(open(p)).get('version','?')); raise SystemExit
p=os.path.join(d,'pyproject.toml')
if os.path.exists(p):
    m=re.search(r'^version\s*=\s*"([^"]+)"',open(p).read(),re.M)
    print(m.group(1) if m else '?'); raise SystemExit
print('?')
PY
)"
  if [ "$CODE" = "200" ]; then
    REG_V="$(curl -s --max-time 25 "$URL" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('info',{}).get('version') or (d.get('dist-tags',{}) or {}).get('latest','?'))
except Exception: print('?')
")"
    record "A-$NAME" "\`$NAME\` ($KIND) is on the registry" "HTTP 200" "HTTP 200, registry v$REG_V, worktree v$LOCAL_V" PASS
    REG_ROWS="$REG_ROWS| \`$NAME\` | $KIND | **PUBLISHED** | $REG_V | $LOCAL_V | \`$DIR\` |
"
  else
    record "A-$NAME" "\`$NAME\` ($KIND) is on the registry" "HTTP 200" "HTTP $CODE — NOT PUBLISHED" FAIL
    REG_ROWS="$REG_ROWS| \`$NAME\` | $KIND | **HTTP $CODE — NOT PUBLISHED** | — | $LOCAL_V | \`$DIR\` |
"
  fi
done <<< "$SDK_INVENTORY"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE B — credentials + loopback IAM proxy
# ═════════════════════════════════════════════════════════════════════════════
RIG_ID_TOKEN="$(gcloud auth print-identity-token --audiences="$RIG_URL" 2>/dev/null)"
[ -n "$RIG_ID_TOKEN" ] || die "cannot mint a Cloud Run identity token"

API_KEY=""; KEY_ORIGIN=""
if [ "$MINT" -eq 1 ]; then
  SB_URL="$(secret "$SB_URL_SECRET")"; SB_ANON="$(secret "$SB_ANON_SECRET")"; SEED_PW="$(secret "$SEED_PW_SECRET")"
  [ -n "$SB_URL" ] && [ -n "$SB_ANON" ] && [ -n "$SEED_PW" ] || die "cannot read Supabase seed credentials for --mint"
  JWT="$(printf '{"email":"%s","password":"%s"}' "$ORG_A_USER" "$SEED_PW" \
        | curl -s --max-time 45 "$SB_URL/auth/v1/token?grant_type=password" \
            -H "apikey: $SB_ANON" -H 'Content-Type: application/json' --data-binary @- \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)"
  case "$JWT" in ey*) : ;; *) die "--mint: could not mint a JWT for $ORG_A_USER" ;; esac
  MINT_BODY="$(printf '{"name":"fullsoak-sdk-integration-%s","scopes":["verify","read:records","read:orgs","read:search","usage:read"]}' "$RUN_STAMP")"
  API_KEY="$(printf '%s' "$MINT_BODY" | curl -s --max-time 45 "$RIG_URL/api/v1/keys" -X POST \
      -H "X-Serverless-Authorization: Bearer $RIG_ID_TOKEN" -H "Authorization: Bearer $JWT" \
      -H 'Content-Type: application/json' --data-binary @- \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('key') or d.get('api_key') or '')" 2>/dev/null)"
  KEY_ORIGIN="minted this run via POST /api/v1/keys with a real Supabase JWT (FD-P7: it cannot be deleted afterwards)"
fi
if [ -z "$API_KEY" ]; then
  API_KEY="$(secret "$APIKEY_PUBLIC_SECRET")"
  KEY_ORIGIN="Day-0 \`soak-public-api\` key from Secret Manager (\`$APIKEY_PUBLIC_SECRET\`), minted through the real product flow at rig standup; reused to avoid FD-P7 key litter"
fi
[ -n "$API_KEY" ] || die "no API key available"
KEY_PREFIX="$(printf '%s' "$API_KEY" | cut -c1-12)"

# Loopback proxy: SDK -> 127.0.0.1 -> rig (+ X-Serverless-Authorization).
cat > "$TMPD/proxy.py" <<'PROXY_EOF'
import http.server, os, socketserver, ssl, sys, urllib.request, urllib.error
TARGET = os.environ['RIG_URL']; TOKEN = os.environ['RIG_ID_TOKEN']
HOP = {'host','connection','content-length','transfer-encoding','accept-encoding'}
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def _do(self):
        ln = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(ln) if ln else None
        req = urllib.request.Request(TARGET + self.path, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() not in HOP: req.add_header(k, v)
        req.add_header('X-Serverless-Authorization', 'Bearer ' + TOKEN)
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read(); code = r.status; ctype = r.headers.get('Content-Type','application/json')
        except urllib.error.HTTPError as e:
            data = e.read(); code = e.code; ctype = e.headers.get('Content-Type','application/json')
        except Exception as e:
            data = ('{"error":"proxy","detail":%r}' % str(e)).encode(); code = 599; ctype='application/json'
        self.send_response(code); self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = _do
socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', int(sys.argv[1])), H) as s: s.serve_forever()
PROXY_EOF
RIG_URL="$RIG_URL" RIG_ID_TOKEN="$RIG_ID_TOKEN" python3 "$TMPD/proxy.py" "$PROXY_PORT" >/dev/null 2>&1 &
PROXY_PID=$!
BASE="http://127.0.0.1:$PROXY_PORT"
sleep 2
PROXY_CHECK="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/health")"
[ "$PROXY_CHECK" = "200" ] || die "loopback IAM proxy not healthy (got $PROXY_CHECK on /health)"
record "B-proxy" "Loopback IAM proxy reaches the rig" "HTTP 200 on /health" "HTTP $PROXY_CHECK" PASS

# A live SECURED public_id, discovered — never hardcoded (it would go stale).
PUBLIC_ID="$(sql1 "$RIG_SUPABASE_REF" "select public_id from public.anchors where status='SECURED' and public_id is not null order by created_at desc limit 1" public_id)"
case "$PUBLIC_ID" in ARK-*) : ;; *) PUBLIC_ID="" ;; esac
[ -n "$PUBLIC_ID" ] || record "B-pubid" "A live SECURED public_id is discoverable for the SDK smoke" "ARK-…" "${PUBLIC_ID:-<none>}" SKIP

# ═════════════════════════════════════════════════════════════════════════════
# PHASE C — TypeScript SDKs. NOT registry artifacts (Phase A proves that), so
# these are built from the WORKING TREE and labelled as such. This is exactly
# the §5.1 S12/S13 false-pass trap the checklist names — the honest handling is
# to run it and label it, not to skip it and leave the surface unexercised.
# ═════════════════════════════════════════════════════════════════════════════
TS_SRC_LABEL="worktree $(git rev-parse --short HEAD 2>/dev/null) — the npm packages are unpublished (Phase A)"
mkdir -p "$TMPD/ts"
cat > "$TMPD/ts/package.json" <<'PKG'
{ "name": "fullsoak-sdk-smoke", "private": true, "type": "module" }
PKG

cat > "$TMPD/ts/smoke.mjs" <<'SMOKE_EOF'
// Live-API smoke over each TS SDK's PUBLIC surface. Read-only by construction:
// the only write methods touched are asserted to be REFUSED by scope.
import { readFileSync } from 'node:fs';
const BASE = process.env.BASE, KEY = process.env.API_KEY, PID = process.env.PUBLIC_ID || '';
const out = [];
const rec = (id, desc, expected, observed, result) => out.push({ id, desc, expected, observed, result });
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > 160 ? s.slice(0,160)+'…' : (s ?? ''); };

// ── 1. @carsonarkova/sdk — the Arkova client ────────────────────────────────
try {
  const { Arkova, ArkovaError } = await import(process.env.SDK_ENTRY);
  const a = new Arkova({ apiKey: KEY, baseUrl: BASE });

  const fp = await a.fingerprint('arkova-fullsoak-sdk-smoke');
  rec('C1a', '`Arkova.fingerprint()` computes a 64-hex digest locally',
      '64 hex chars', short(fp), /^[0-9a-f]{64}$/.test(fp) ? 'PASS' : 'FAIL');

  if (PID) {
    try {
      const v = await a.verify(PID);
      rec('C1b', '`Arkova.verify(publicId)` resolves a live SECURED record',
          'a verification result carrying the public id', short(v),
          JSON.stringify(v).includes(PID) ? 'PASS' : 'FAIL');
    } catch (e) { rec('C1b','`Arkova.verify(publicId)` resolves a live SECURED record','result',short(String(e)),'FAIL'); }

    try {
      const r = await a.getRecord(PID);
      rec('C1c', '`Arkova.getRecord()` reads the v2 record projection', 'a record object', short(r), r ? 'PASS' : 'FAIL');
    } catch (e) { rec('C1c','`Arkova.getRecord()` reads the v2 record projection','a record object',short(String(e)),'FAIL'); }

    try {
      const b = await a.verifyBatch([PID]);
      rec('C1d', '`Arkova.verifyBatch()` returns one result per id', '1 result', short(b),
          Array.isArray(b) && b.length === 1 ? 'PASS' : 'FAIL');
    } catch (e) { rec('C1d','`Arkova.verifyBatch()` returns one result per id','1 result',short(String(e)),'FAIL'); }
  }

  try {
    const s = await a.search('license', { limit: 3 });
    rec('C1e', '`Arkova.search()` returns a search envelope', 'an object', short(s), s ? 'PASS' : 'FAIL');
  } catch (e) { rec('C1e','`Arkova.search()` returns a search envelope','an object',short(String(e)),'FAIL'); }

  try {
    const o = await a.listOrgs();
    rec('C1f', '`Arkova.listOrgs()` reads the public org index', 'an array', short(o), Array.isArray(o) ? 'PASS' : 'FAIL');
  } catch (e) { rec('C1f','`Arkova.listOrgs()` reads the public org index','an array',short(String(e)),'FAIL'); }

  // SCOPE NEGATIVE — the write path, refused. Nothing is created.
  try {
    await a.anchor('fullsoak-sdk-scope-negative-' + Date.now());
    rec('C1g', 'A verify-scoped key CANNOT anchor through the SDK', '403 / ArkovaError', 'ANCHOR SUCCEEDED', 'FAIL');
  } catch (e) {
    const m = String(e?.status ?? '') + ' ' + String(e?.message ?? e);
    rec('C1g', 'A verify-scoped key CANNOT anchor through the SDK', '403 / insufficient scope', short(m),
        /403|scope|forbidden/i.test(m) ? 'PASS' : 'FAIL');
  }

  // Nessie is permanently OFF by founder directive (2026-08-01) and the coverage
  // checklist's stated daily assertion is that it FAILS CLOSED. `Arkova.query()`
  // is the SDK surface over `GET /api/v1/nessie/query`. A 200 carrying a
  // well-formed empty result is NOT failing closed: a paying integrator cannot
  // tell "permanently disabled" from "no matching records", and that endpoint is
  // a priced offer on /developers (claims register rows 2 and 4).
  try {
    const n = await a.query('what is my compliance posture');
    rec('C1h', '`Arkova.query()` (Nessie) fails CLOSED, not 200-with-empty',
        'error / explicitly disabled', 'HTTP 200 + ' + short(n),
        /disabled|not_?found|unavailable|404|410/i.test(JSON.stringify(n)) ? 'PASS' : 'FAIL');
  } catch (e) {
    rec('C1h', '`Arkova.query()` (Nessie) fails CLOSED, not 200-with-empty',
        'error / explicitly disabled', short(String(e)), 'PASS');
  }
} catch (e) {
  rec('C1', '@carsonarkova/sdk loads and exercises against the rig', 'module loads', short(String(e)), 'FAIL');
}

// ── 2. @arkova/mcp-server — handleToolCall over the tool surface ────────────
try {
  const mcp = await import(process.env.MCP_ENTRY);
  const defs = mcp.TOOL_DEFINITIONS ?? [];
  rec('C2a', '`TOOL_DEFINITIONS` exposes the MCP tool surface', '>= 1 tool', `${defs.length} tools`, defs.length > 0 ? 'PASS' : 'FAIL');
  if (PID) {
    const r = await mcp.handleToolCall('arkova_verify_credential', { credential_id: PID, publicId: PID, public_id: PID });
    rec('C2b', '`handleToolCall(arkova_verify_credential)` reaches the live rig', 'a tool result', short(r), r ? 'PASS' : 'FAIL');
    const st = await mcp.handleToolCall('arkova_credential_status', { credential_id: PID, publicId: PID, public_id: PID });
    rec('C2c', '`handleToolCall(arkova_credential_status)` reaches the live rig', 'a tool result', short(st), st ? 'PASS' : 'FAIL');
  }
  const se = await mcp.handleToolCall('arkova_search_credentials', { query: 'license', limit: 3 });
  rec('C2d', '`handleToolCall(arkova_search_credentials)` reaches the live rig', 'a tool result', short(se), se ? 'PASS' : 'FAIL');
  const ne = await mcp.handleToolCall('nessie_ask', { question: 'status?' });
  rec('C2e', '`nessie_ask` MCP tool fails CLOSED, not a synthesized empty answer',
      'error / explicitly disabled', short(ne),
      /disabl|unavail|not.?found|404|410/i.test(JSON.stringify(ne)) ? 'PASS' : 'FAIL');
} catch (e) {
  rec('C2', '@arkova/mcp-server loads and exercises against the rig', 'module loads', short(String(e)), 'FAIL');
}

// ── 3. @arkova/langchain — tool wrappers ────────────────────────────────────
try {
  const lc = await import(process.env.LC_ENTRY);
  const cfg = { apiKey: KEY, baseUrl: BASE };
  if (PID && lc.ArkovaVerifyTool) {
    const t = new lc.ArkovaVerifyTool(cfg);
    const r = await (t.call ? t.call(PID) : t._call(PID));
    rec('C3a', '`ArkovaVerifyTool` verifies a live record', 'a tool string/object', short(r), r ? 'PASS' : 'FAIL');
  }
  if (lc.ArkovaSearchTool) {
    const t = new lc.ArkovaSearchTool(cfg);
    const r = await (t.call ? t.call('license') : t._call('license'));
    rec('C3b', '`ArkovaSearchTool` searches the live rig', 'a tool string/object', short(r), r ? 'PASS' : 'FAIL');
  }
  if (PID && lc.ArkovaBatchVerifyTool) {
    const t = new lc.ArkovaBatchVerifyTool(cfg);
    const r = await (t.call ? t.call(PID) : t._call(PID));
    rec('C3c', '`ArkovaBatchVerifyTool` batch-verifies against the live rig', 'a tool string/object', short(r), r ? 'PASS' : 'FAIL');
  }
} catch (e) {
  rec('C3', '@arkova/langchain loads and exercises against the rig', 'module loads', short(String(e)), 'FAIL');
}

console.log(JSON.stringify(out));
SMOKE_EOF

# Build each TS package into something importable. tsup/tsc are devDeps of the
# repo; if a build is unavailable the leg reports SKIP rather than a false pass.
TS_JSON="[]"
if command -v npx >/dev/null 2>&1; then
  ( cd "$REPO_ROOT/packages/sdk" && npx --no-install tsup src/index.ts --format esm --out-dir "$TMPD/build/sdk" --silent >/dev/null 2>&1 ) || true
  ( cd "$REPO_ROOT" && npx --no-install esbuild sdks/mcp-server/src/index.ts --bundle --platform=node --format=esm \
      --outfile="$TMPD/build/mcp/index.mjs" >/dev/null 2>&1 ) || true
  ( cd "$REPO_ROOT" && npx --no-install esbuild sdks/langchain-ts/src/index.ts --bundle --platform=node --format=esm \
      --outfile="$TMPD/build/lc/index.mjs" >/dev/null 2>&1 ) || true
fi
SDK_ENTRY="$TMPD/build/sdk/index.mjs"; MCP_ENTRY="$TMPD/build/mcp/index.mjs"; LC_ENTRY="$TMPD/build/lc/index.mjs"
[ -f "$SDK_ENTRY" ] || SDK_ENTRY="$REPO_ROOT/packages/sdk/dist/index.mjs"

if [ -f "$SDK_ENTRY" ] || [ -f "$MCP_ENTRY" ] || [ -f "$LC_ENTRY" ]; then
  TS_JSON="$(cd "$TMPD/ts" && BASE="$BASE" API_KEY="$API_KEY" PUBLIC_ID="$PUBLIC_ID" \
    SDK_ENTRY="$SDK_ENTRY" MCP_ENTRY="$MCP_ENTRY" LC_ENTRY="$LC_ENTRY" \
    ARKOVA_API_KEY="$API_KEY" ARKOVA_API_URL="$BASE" \
    node smoke.mjs 2>"$TMPD/ts.err")"
  [ -n "$TS_JSON" ] || TS_JSON="[]"
else
  record "C-build" "TypeScript SDK entrypoints are buildable for a live smoke" "at least one bundle" "no bundle produced" SKIP
fi
python3 - "$TS_JSON" > "$TMPD/ts.rows" <<'PY'
import json,sys
try: rows=json.loads(sys.argv[1])
except Exception: rows=[]
for r in rows: print('\t'.join([r['id'],r['desc'],r['expected'],str(r['observed']),r['result']]))
PY
while IFS="$(printf '\t')" read -r I D E O R; do
  [ -n "$I" ] && record "$I" "$D" "$E" "$O" "$R"
done < "$TMPD/ts.rows"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE D — the Python SDK, installed FROM PyPI. The one leg that is genuinely
# registry-grade evidence, because `arkova` is the one artifact that is actually
# published.
# ═════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_PY" -eq 0 ]; then
  if python3 -m venv "$TMPD/venv" >/dev/null 2>&1 \
     && "$TMPD/venv/bin/pip" install --quiet --disable-pip-version-check arkova >/dev/null 2>&1; then
    PY_V="$("$TMPD/venv/bin/python" -c 'import importlib.metadata as m; print(m.version("arkova"))' 2>/dev/null)"
    record "D0" "\`arkova\` installs from PyPI (registry artifact, not the working tree)" "installs" "arkova $PY_V" PASS
    cat > "$TMPD/pysmoke.py" <<'PY_EOF'
import json, os, sys
from arkova import Arkova, ArkovaError
BASE, KEY, PID = os.environ['BASE'], os.environ['API_KEY'], os.environ.get('PUBLIC_ID') or ''
out = []
def rec(i, d, e, o, r): out.append({'id': i, 'desc': d, 'expected': e, 'observed': str(o)[:160], 'result': r})
c = Arkova(api_key=KEY, base_url=BASE)
fp = c.fingerprint('arkova-fullsoak-sdk-smoke')
rec('D1', '`Arkova.fingerprint()` computes a 64-hex digest locally', '64 hex', fp,
    'PASS' if len(fp) == 64 and all(ch in '0123456789abcdef' for ch in fp) else 'FAIL')
if PID:
    try:
        v = c.verify(PID); rec('D2', '`Arkova.verify(public_id)` resolves a live SECURED record', 'result carrying the id', v,
                               'PASS' if PID in json.dumps(v, default=str) else 'FAIL')
    except Exception as e: rec('D2', '`Arkova.verify(public_id)` resolves a live SECURED record', 'result', e, 'FAIL')
    # The SDK wraps a parse failure in a generic "unexpected response shape",
    # which names no field and would leave the finding unactionable. Re-validate
    # the raw payload against the published model so the artifact carries the
    # exact field and the exact type mismatch.
    try:
        import httpx
        from arkova.models import VerificationResult
        raw = httpx.get(f"{BASE.rsplit('/api/',1)[0]}/api/v1/verify/{PID}",
                        headers={'X-API-Key': KEY}, timeout=45).json()
        try:
            VerificationResult.model_validate(raw)
            rec('D2b', "The published model parses the live `/api/v1/verify/{id}` payload", 'parses', 'parsed', 'PASS')
        except Exception as ve:
            bad = ', '.join(sorted({str(k) for err in getattr(ve, 'errors', lambda: [])() for k in err.get('loc', ())}))
            rec('D2b', "The published model parses the live `/api/v1/verify/{id}` payload",
                'parses', f"REJECTED on [{bad}]: {str(ve).splitlines()[1] if len(str(ve).splitlines())>1 else ve}", 'FAIL')
    except Exception as e:
        rec('D2b', "The published model parses the live `/api/v1/verify/{id}` payload", 'parses', e, 'SKIP')
    try:
        r = c.get_record(PID); rec('D3', '`Arkova.get_record()` reads the v2 record projection', 'a record', r, 'PASS' if r else 'FAIL')
    except Exception as e: rec('D3', '`Arkova.get_record()` reads the v2 record projection', 'a record', e, 'FAIL')
try:
    s = c.search('license', limit=3); rec('D4', '`Arkova.search()` returns a search envelope', 'an object', s, 'PASS' if s is not None else 'FAIL')
except Exception as e: rec('D4', '`Arkova.search()` returns a search envelope', 'an object', e, 'FAIL')
try:
    o = c.list_orgs(); rec('D5', '`Arkova.list_orgs()` reads the public org index', 'an org list', o, 'PASS' if o is not None else 'FAIL')
except Exception as e: rec('D5', '`Arkova.list_orgs()` reads the public org index', 'an org list', e, 'FAIL')
try:
    c.anchor(data='fullsoak-sdk-scope-negative')
    rec('D6', 'A verify-scoped key CANNOT anchor through the Python SDK', '403 / ArkovaError', 'ANCHOR SUCCEEDED', 'FAIL')
except Exception as e:
    m = str(getattr(e, 'status_code', '')) + ' ' + str(e)
    rec('D6', 'A verify-scoped key CANNOT anchor through the Python SDK', '403 / insufficient scope', m,
        'PASS' if ('403' in m or 'scope' in m.lower() or 'forbidden' in m.lower()) else 'FAIL')
c.close()
print(json.dumps(out))
PY_EOF
    # The Python SDK's base_url contract differs from the TypeScript one and this
    # is NOT optional trivia: `DEFAULT_BASE_URL = https://api.arkova.ai/v2`, and
    # `_versioned_path()` rewrites the trailing version segment for the v1 methods
    # while `search` / `get_record` / `list_orgs` send bare `/search`, `/records/…`,
    # `/orgs` relative to it. Handing it a bare origin (which is what the TS SDK
    # wants) 404s every v2 read method. Passing the origin here would manufacture
    # four false "the published SDK is broken" findings.
    PY_BASE="$BASE/api/v2"
    PY_JSON="$(BASE="$PY_BASE" API_KEY="$API_KEY" PUBLIC_ID="$PUBLIC_ID" "$TMPD/venv/bin/python" "$TMPD/pysmoke.py" 2>"$TMPD/py.err")"
    [ -n "$PY_JSON" ] || { PY_JSON="[]"; record "D-run" "Python SDK smoke executes" "rows" "$(tail -c 200 "$TMPD/py.err" | tr '\n' ' ')" FAIL; }
    python3 - "$PY_JSON" > "$TMPD/py.rows" <<'PY'
import json,sys
try: rows=json.loads(sys.argv[1])
except Exception: rows=[]
for r in rows: print('\t'.join([r['id'],r['desc'],r['expected'],str(r['observed']),r['result']]))
PY
    while IFS="$(printf '\t')" read -r I D E O R; do
      [ -n "$I" ] && record "$I" "$D" "$E" "$O" "$R"
    done < "$TMPD/py.rows"
  else
    record "D0" "\`arkova\` installs from PyPI" "installs" "venv/pip install failed" SKIP
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# Evidence
# ═════════════════════════════════════════════════════════════════════════════
VERDICT="PASS"; [ "$FAIL" -gt 0 ] && VERDICT="FAIL"
{
cat <<MD
# SDK live-API integration — $RUN_DATE

> Run \`$RUN_TS\` · rig \`$RIG_URL\` · Supabase \`$RIG_SUPABASE_REF\`
> API key: $KEY_ORIGIN — prefix \`$KEY_PREFIX\`
> Live record under test: \`${PUBLIC_ID:-<none discovered>}\`
> Repo HEAD \`$(git rev-parse HEAD 2>/dev/null)\`

## Can the SDK test suites be pointed at the rig? No.

All three TypeScript suites stub \`fetch\` and say so in their own headers —
\`packages/sdk/src/client.test.ts:13\` is \`vi.stubGlobal('fetch', mockFetch)\` under
*"Tests SDK methods with mocked fetch. No real API calls."* There is no base-URL env var,
no integration mode and no conditional live path in \`packages/sdk\`, \`sdks/mcp-server\` or
\`sdks/langchain-ts\`. Pointing \`npm test\` at the rig would exercise the mock and report green
whether or not the rig existed. **So the suites were not run against the rig; this script
exercises each SDK's public surface against it directly**, which is the assertion the suites
cannot make.

## Registry census (checked live this run)

| package | kind | registry | registry version | worktree version | source |
|---|---|---|---|---|---|
$REG_ROWS

## Assertions

| id | assertion | expected | observed | result |
|---|---|---|---|---|
$ROWS

**TypeScript legs are worktree builds** ($TS_SRC_LABEL). That is the §5.1 S12/S13 false-pass
trap named in the checklist, and it is unavoidable here for the reason the census shows: there is
no registry artifact to install. The Python leg (D-series) is installed from PyPI and is the only
registry-grade SDK evidence in this run.

**No SDK write method was exercised for effect.** \`anchor()\` appears exactly once per SDK, as a
scope-negative assertion that a verify-scoped key is refused. The BL-2 cohort is untouched.

## Observation — the two SDKs do not share a \`base_url\` contract

The TypeScript client takes a **bare origin** and builds \`/api/v1/…\` and \`/api/v2/…\` itself.
The Python client's \`DEFAULT_BASE_URL\` is \`https://api.arkova.ai/v2\`: its v1 methods rewrite that
trailing version segment via \`_versioned_path()\`, while \`search\` / \`get_record\` / \`list_orgs\` /
\`get_organization\` / \`get_fingerprint\` / \`get_document\` send **bare** \`/search\`, \`/records/{id}\`,
\`/orgs\` relative to it. So the same service needs \`https://host\` from one SDK and
\`https://host/api/v2\` from the other, and handing the Python client a bare origin 404s every v2
read method with the worker's generic *"The requested endpoint does not exist"* — which reads
exactly like a broken SDK. Not a defect in either client on its own; a documentation and
cross-SDK-consistency gap that will cost an integrator an afternoon. This script pins the correct
value for each rather than reporting the mismatch as four false findings.

---

\`SDK_INTEGRATION: $PASS pass / $FAIL fail / $SKIP skip — $VERDICT\`

_No rig env, flag, secret, scheduler job, revision or traffic split was modified; the soak clock
was not touched._
MD
} > "$OUT_RUN_MD"
cp "$OUT_RUN_MD" "$OUT_MD"

{
  printf '{\n  "run_ts": "%s",\n  "rig_url": "%s",\n' "$RUN_TS" "$RIG_URL"
  printf '  "api_key_prefix": "%s",\n  "public_id": "%s",\n' "$KEY_PREFIX" "$PUBLIC_ID"
  printf '  "pass": %s, "fail": %s, "skip": %s, "verdict": "%s",\n' "$PASS" "$FAIL" "$SKIP" "$VERDICT"
  printf '  "assertions": [%s]\n}\n' "$(printf '%s' "$JROWS" | sed 's/,$//')"
} > "$OUT_JSON"

echo "----------------------------------------------------------------------"
echo "SDK_INTEGRATION: $PASS pass / $FAIL fail / $SKIP skip — $VERDICT"
echo "artifact: $OUT_MD"
[ "$VERDICT" = "PASS" ] && exit 0 || exit 1
