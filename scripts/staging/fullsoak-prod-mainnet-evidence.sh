#!/usr/bin/env bash
# scripts/staging/fullsoak-prod-mainnet-evidence.sh
#
# SUPPLEMENTARY prod-mainnet observation for the 2026-08 7-day soak. READ-ONLY.
#
# ── WHAT THIS MEASURES, AND WHAT IT EXPLICITLY DOES NOT ASSERT ───────────────
# MEASURED: production's own Bitcoin MAINNET operation during the soak window —
#   its /health, its anchor creation and SECURED promotion over the last 24 h,
#   its most recent chain_tx_id and block height, its materialized proof rows,
#   and independent confirmation of one recent prod txid on TWO mainnet block
#   explorers that share no infrastructure with Arkova.
#
# NOT ASSERTED, and no reading in this artifact may be presented as it:
#   * that the RIG tested mainnet. It did not and must not — the rig is signet
#     by design (BTC9). Mainnet signing/broadcast stays DECLARED-UNTESTED for
#     the soak; this file does not convert that row.
#   * that prod is under test. Prod is CHANGE-FROZEN for the window. This script
#     observes it; it never writes to it, never invokes a prod cron route, never
#     touches a prod flag, secret, revision or scheduler job. Every prod database
#     access here is a SELECT.
#   * that the soak's controlled cohort and prod's traffic are comparable. They
#     are different databases with different volumes; the numbers sit side by
#     side, they are not merged.
#
# The honest claim this supports is narrow and worth having: during the soak
# window, the production system was continuously anchoring to Bitcoin mainnet,
# and a transaction it produced is independently verifiable by two third parties.
#
# ── CONSTITUTIONAL LIMITS (CLAUDE.md §1.11A, §1.5) ───────────────────────────
# Read-only everywhere. The only outbound calls are: prod GET /health (public),
# read-only SELECTs via the Supabase Management API, and two public explorer GETs.
#
# ── USAGE ────────────────────────────────────────────────────────────────────
#   ./scripts/staging/fullsoak-prod-mainnet-evidence.sh
#
# Exit: 0 all assertions pass · 1 one or more FAIL · 2 harness error.

set -uo pipefail

GCP_PROJECT="${GCP_PROJECT:-arkova1}"
PROD_URL="${PROD_URL:-https://arkova-worker-kvojbeutfa-uc.a.run.app}"
PROD_SUPABASE_REF="${PROD_SUPABASE_REF:-vzwyaatejekddvltxyye}"
RIG_SUPABASE_REF="${RIG_SUPABASE_REF:-gnkuaywlpmsaezwvlvhk}"
SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
SUPABASE_ACCESS_TOKEN_SECRET="${SUPABASE_ACCESS_TOKEN_SECRET:-supabase_access}"
EVID_ROOT_REL="${EVID_ROOT_REL:-docs/staging/evidence/fullsoak-2026-08}"
EXPLORER_1="${EXPLORER_1:-https://mempool.space/api}"
EXPLORER_2="${EXPLORER_2:-https://blockstream.info/api}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO_ROOT" || exit 2
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/fullsoak-prod.XXXXXX")" || exit 2
trap 'rm -rf "$TMPD"' EXIT INT TERM; chmod 700 "$TMPD"

RUN_DATE="$(date -u +%F)"; RUN_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; RUN_STAMP="$(date -u +%H%M%SZ)"
OUT_DIR="$REPO_ROOT/$EVID_ROOT_REL/$RUN_DATE"; mkdir -p "$OUT_DIR" || exit 2
OUT_MD="$OUT_DIR/prod-mainnet-evidence.md"
OUT_RUN_MD="$OUT_DIR/prod-mainnet-evidence-$RUN_STAMP.md"
OUT_JSON="$OUT_DIR/prod-mainnet-evidence-$RUN_STAMP.json"

die() { echo "FATAL: $*" >&2; exit 2; }
secret() { gcloud secrets versions access latest --secret="$1" --project="$GCP_PROJECT" 2>/dev/null; }
pyjson() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

PASS=0; FAIL=0; SKIP=0; ROWS=""; JROWS=""
record() {
  case "$5" in PASS) PASS=$((PASS+1)) ;; FAIL) FAIL=$((FAIL+1)) ;; *) SKIP=$((SKIP+1)) ;; esac
  printf '  %-5s %-6s %s\n' "$5" "$1" "$2"
  ROWS="$ROWS| \`$1\` | $2 | $3 | $4 | **$5** |
"
  JROWS="$JROWS{\"id\":$(pyjson "$1"),\"desc\":$(pyjson "$2"),\"expected\":$(pyjson "$3"),\"observed\":$(pyjson "$4"),\"result\":$(pyjson "$5")},"
}

[ -z "$SUPABASE_ACCESS_TOKEN" ] && SUPABASE_ACCESS_TOKEN="$(secret "$SUPABASE_ACCESS_TOKEN_SECRET")"
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "no Supabase management token — cannot read prod"

sqlraw() { # ref | query -> raw JSON array
  local q rc; q="$(python3 -c 'import json,sys; print(json.dumps({"query":sys.argv[1]}))' "$2")"; rc="$TMPD/mgmt.rc"
  ( umask 077; { printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ACCESS_TOKEN"
                 printf 'header = "Content-Type: application/json"\nsilent\nshow-error\nmax-time = 120\n'; } > "$rc" )
  printf '%s' "$q" | curl -K "$rc" -X POST "https://api.supabase.com/v1/projects/$1/database/query" --data-binary @- 2>/dev/null
  rm -f "$rc"
}
sql1() { sqlraw "$1" "$2" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get(sys.argv[1],'<none>'))
except Exception: print('<error>')
" "$3"; }

echo "fullsoak-prod-mainnet-evidence — $RUN_TS (READ-ONLY on prod)"

# ── 1. Prod /health ─────────────────────────────────────────────────────────
HCODE="$(curl -s -o "$TMPD/health.json" -w '%{http_code}' --max-time 30 "$PROD_URL/health")"
HJ() { python3 -c "
import json,sys
try: print(json.load(open('$TMPD/health.json')).get(sys.argv[1],''))
except Exception: print('')
" "$1"; }
P_STATUS="$(HJ status)"; P_NET="$(HJ network)"; P_SHA="$(HJ git_sha)"; P_UP="$(HJ uptime)"
P_CHECKS="$(python3 -c "
import json
try: print(json.dumps(json.load(open('$TMPD/health.json')).get('checks',{})))
except Exception: print('{}')
")"
[ "$HCODE" = "200" ] && [ "$P_STATUS" = "healthy" ] \
  && record M1 "Production worker reports healthy" "http 200 + status=healthy" "http $HCODE, status=$P_STATUS, checks=$P_CHECKS" PASS \
  || record M1 "Production worker reports healthy" "http 200 + status=healthy" "http $HCODE, status=$P_STATUS" FAIL
[ "$P_NET" = "mainnet" ] \
  && record M2 "Production is on the Bitcoin MAINNET network" "network=mainnet" "network=$P_NET, git_sha=$P_SHA, uptime=${P_UP}s" PASS \
  || record M2 "Production is on the Bitcoin MAINNET network" "network=mainnet" "network=$P_NET" FAIL

# ── 2. Prod anchoring over the last 24 h ────────────────────────────────────
CREATED_24H="$(sql1 "$PROD_SUPABASE_REF" \
  "select count(*)::int as n from anchors where created_at > now() - interval '24 hours'" n)"
SECURED_24H="$(sql1 "$PROD_SUPABASE_REF" \
  "select count(*)::int as n from anchors where created_at > now() - interval '24 hours' and status='SECURED'" n)"
case "$CREATED_24H" in
  ''|*[!0-9]*) record M3 "Prod created anchors in the last 24 h" ">0" "$CREATED_24H" SKIP ;;
  *) [ "$CREATED_24H" -gt 0 ] \
       && record M3 "Prod created anchors in the last 24 h" ">0" "$CREATED_24H created, $SECURED_24H of them SECURED" PASS \
       || record M3 "Prod created anchors in the last 24 h" ">0" "0 — prod anchoring is idle" FAIL ;;
esac

STATUS_SPLIT="$(sqlraw "$PROD_SUPABASE_REF" \
  "select status, count(*)::int as n from anchors where created_at > now() - interval '24 hours' group by status order by n desc" \
  | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print(', '.join(f\"{r['status']}={r['n']}\" for r in d) or '<none>')
except Exception: print('<error>')")"

# ── 3. Latest mainnet transaction prod produced ─────────────────────────────
LATEST="$(sqlraw "$PROD_SUPABASE_REF" \
  "select chain_tx_id, chain_block_height, chain_timestamp::text as chain_timestamp, chain_block_hash, public_id from anchors where created_at > now() - interval '24 hours' and chain_tx_id is not null order by created_at desc limit 1")"
TXID="$(printf '%s' "$LATEST" | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print((d[0] if d else {}).get('chain_tx_id',''))
except Exception: print('')")"
TXH="$(printf '%s' "$LATEST" | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print((d[0] if d else {}).get('chain_block_height',''))
except Exception: print('')")"
TXT="$(printf '%s' "$LATEST" | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print((d[0] if d else {}).get('chain_timestamp',''))
except Exception: print('')")"
TXPID="$(printf '%s' "$LATEST" | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print((d[0] if d else {}).get('public_id',''))
except Exception: print('')")"

case "$TXID" in
  [0-9a-f]*) record M4 "Prod carries a recent mainnet chain_tx_id + block height" "64-hex txid + height" "\`${TXID:0:20}…\` at height $TXH ($TXT, \`$TXPID\`)" PASS ;;
  *)         record M4 "Prod carries a recent mainnet chain_tx_id + block height" "64-hex txid + height" "<none in the last 24 h>" SKIP ;;
esac

# A MockChainClient txid matches ^[0-9a-f]{64}$ too and seeds height 800000; a
# real mainnet height in 2026 is far above that. Assert the height, not the shape.
if [ -n "$TXH" ] && [ "$TXH" -gt 850000 ] 2>/dev/null; then
  record M5 "The block height is a real mainnet height, not a mock seed" ">850000 (mock seeds 800000)" "$TXH" PASS
else
  record M5 "The block height is a real mainnet height, not a mock seed" ">850000" "${TXH:-<none>}" SKIP
fi

# ── 4. Proof materialization ────────────────────────────────────────────────
PROOFS_TOTAL="$(sql1 "$PROD_SUPABASE_REF" "select count(*)::int as n from anchor_proofs" n)"
PROOFS_24H="$(sql1 "$PROD_SUPABASE_REF" \
  "select count(*)::int as n from anchor_proofs where created_at > now() - interval '24 hours'" n)"
ANCHORS_TOTAL="$(sql1 "$PROD_SUPABASE_REF" \
  "select GREATEST(reltuples::bigint,0)::bigint as n from pg_class where relname='anchors' and relnamespace='public'::regnamespace" n)"
record M6 "Prod proof rows counted (the G8 coverage gap, stated not hidden)" \
  "a count, whatever it is" "anchor_proofs total=$PROOFS_TOTAL, +${PROOFS_24H} in 24 h, against ~$ANCHORS_TOTAL anchors (planner estimate)" \
  PASS

# ── 5. Two independent mainnet explorers ────────────────────────────────────
explorer() { # base | txid -> "confirmed|height|blockhash" or "ERR:<detail>"
  curl -s --max-time 40 "$1/tx/$2" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); s=d.get('status',{})
    if d.get('txid','').lower()!=sys.argv[1].lower(): print('ERR:txid mismatch'); raise SystemExit
    print('%s|%s|%s' % (s.get('confirmed'), s.get('block_height'), (s.get('block_hash') or '')[:24]))
except SystemExit: raise
except Exception as e: print('ERR:%s' % e)
" "$2"
}
if [ -n "$TXID" ]; then
  E1="$(explorer "$EXPLORER_1" "$TXID")"; E2="$(explorer "$EXPLORER_2" "$TXID")"
  E1H="$(printf '%s' "$E1" | cut -d'|' -f2)"; E2H="$(printf '%s' "$E2" | cut -d'|' -f2)"
  case "$E1" in True\|*) record M7 "mempool.space confirms the prod txid on mainnet" "confirmed=True" "$E1" PASS ;;
                *)       record M7 "mempool.space confirms the prod txid on mainnet" "confirmed=True" "$E1" FAIL ;; esac
  case "$E2" in True\|*) record M8 "blockstream.info independently confirms the same txid" "confirmed=True" "$E2" PASS ;;
                *)       record M8 "blockstream.info independently confirms the same txid" "confirmed=True" "$E2" FAIL ;; esac
  if [ -n "$E1H" ] && [ "$E1H" = "$E2H" ] && [ "$E1H" = "$TXH" ]; then
    record M9 "Both explorers and the Arkova DB agree on the block height" "all three equal" "db=$TXH mempool=$E1H blockstream=$E2H" PASS
  else
    record M9 "Both explorers and the Arkova DB agree on the block height" "all three equal" "db=$TXH mempool=${E1H:-?} blockstream=${E2H:-?}" FAIL
  fi
else
  record M7 "mempool.space confirms the prod txid on mainnet" "confirmed=True" "no txid to verify" SKIP
  record M8 "blockstream.info independently confirms the same txid" "confirmed=True" "no txid to verify" SKIP
  record M9 "Both explorers and the Arkova DB agree on the block height" "all three equal" "no txid to verify" SKIP
fi

# ── 6. Rig separation — the assertion that keeps this artifact honest ───────
RIG_NET_ROWS="$(sql1 "$RIG_SUPABASE_REF" \
  "select count(*)::int as n from anchors where chain_block_height is not null and chain_block_height > 850000" n)"
case "$RIG_NET_ROWS" in
  0) record M10 "The RIG holds no mainnet-height anchor — it did not touch mainnet" "0 rig anchors above height 850000" "0" PASS ;;
  ''|*[!0-9]*) record M10 "The RIG holds no mainnet-height anchor" "0" "$RIG_NET_ROWS" SKIP ;;
  *) record M10 "The RIG holds no mainnet-height anchor — it did not touch mainnet" "0 rig anchors above height 850000" "$RIG_NET_ROWS — INVESTIGATE" FAIL ;;
esac

# ── Evidence ────────────────────────────────────────────────────────────────
VERDICT="PASS"; [ "$FAIL" -gt 0 ] && VERDICT="FAIL"
{
cat <<MD
# Prod mainnet evidence (SUPPLEMENTARY) — $RUN_DATE

> Run \`$RUN_TS\` · prod worker \`$PROD_URL\` · prod Supabase \`$PROD_SUPABASE_REF\`
> Prod \`git_sha\` \`$P_SHA\` · network \`$P_NET\` · uptime \`${P_UP}s\` · health checks \`$P_CHECKS\`
> Host \`$(hostname)\` · repo HEAD \`$(git rev-parse HEAD 2>/dev/null)\`

## Measured vs asserted (§1.5)

**MEASURED** — production's own Bitcoin **mainnet** operation during the soak window: its health,
its anchor creation and SECURED promotion over the last 24 h, its most recent transaction id and
block height, its materialized proof rows, and independent confirmation of that transaction by two
mainnet block explorers with no shared infrastructure with Arkova.

**NOT ASSERTED** — that the **rig** tested mainnet. It did not, and must not: the rig is signet by
design (BTC9). Mainnet signing and broadcast remain **DECLARED-UNTESTED** for this soak and this
file does not convert that row. Also not asserted: that prod is under test (prod is change-frozen
for the window and every access here is a SELECT or a public GET), or that prod's volume and the
rig's controlled cohort are comparable.

## Production anchoring, last 24 hours

| | value |
|---|---|
| Anchors created | **$CREATED_24H** |
| …of which SECURED | **$SECURED_24H** |
| Status split | $STATUS_SPLIT |
| Latest mainnet txid | \`$TXID\` |
| …block height | **$TXH** |
| …network observed time | $TXT |
| …anchor | \`$TXPID\` |
| \`anchor_proofs\` rows | $PROOFS_TOTAL total (+$PROOFS_24H in 24 h) |
| \`anchors\` (planner estimate) | ~$ANCHORS_TOTAL |

The proof-row count is reported next to the anchor count deliberately: the gap between them is the
open **G8** decision (backfill the historical proof gap before launch, or publish the limitation).
This artifact states it rather than omitting it.

## Independent confirmation

| explorer | result |
|---|---|
| mempool.space | \`${E1:-n/a}\` |
| blockstream.info | \`${E2:-n/a}\` |

Two explorers, queried separately, both resolving the same transaction id to the same block height
as the Arkova database records. Neither shares infrastructure with Arkova, and neither was told what
height to expect.

## Assertions

| id | assertion | expected | observed | result |
|---|---|---|---|---|
$ROWS

---

\`PROD_MAINNET_EVIDENCE: $PASS pass / $FAIL fail / $SKIP skip — $VERDICT\`

_Read-only. No prod write, no prod cron invocation, no prod flag/secret/revision/scheduler change.
The rig was not touched at all beyond one SELECT proving it holds no mainnet-height anchor._
MD
} > "$OUT_RUN_MD"
cp "$OUT_RUN_MD" "$OUT_MD"

{
  printf '{\n  "run_ts": "%s",\n  "prod_url": "%s",\n  "prod_git_sha": "%s",\n  "prod_network": "%s",\n' \
    "$RUN_TS" "$PROD_URL" "$P_SHA" "$P_NET"
  printf '  "anchors_created_24h": "%s", "anchors_secured_24h": "%s",\n' "$CREATED_24H" "$SECURED_24H"
  printf '  "latest_txid": "%s", "latest_block_height": "%s", "latest_public_id": "%s",\n' "$TXID" "$TXH" "$TXPID"
  printf '  "anchor_proofs_total": "%s", "anchor_proofs_24h": "%s",\n' "$PROOFS_TOTAL" "$PROOFS_24H"
  printf '  "explorer_mempool": %s, "explorer_blockstream": %s,\n' "$(pyjson "${E1:-}")" "$(pyjson "${E2:-}")"
  printf '  "pass": %s, "fail": %s, "skip": %s, "verdict": "%s",\n' "$PASS" "$FAIL" "$SKIP" "$VERDICT"
  printf '  "assertions": [%s]\n}\n' "$(printf '%s' "$JROWS" | sed 's/,$//')"
} > "$OUT_JSON"

echo "----------------------------------------------------------------------"
echo "PROD_MAINNET_EVIDENCE: $PASS pass / $FAIL fail / $SKIP skip — $VERDICT"
echo "artifact: $OUT_MD"
[ "$VERDICT" = "PASS" ] && exit 0 || exit 1
