#!/usr/bin/env bash
# ONE soak cycle for the consolidated merged-main soak (rc-deferred-2026-08-22
# pause_lift_obligation), tier T3, rig consolidated-mm-2026-08.
# Surfaces (all through the isolated rig; never prod, never shared staging):
#   1. Worker health + exact-head pin.
#   2. Public verification API (#2211/#2251/#2269): fixture 200, unknown 404,
#      rate-limit headers present.
#   3. API-key lifecycle (#2220 FD-P7 CC6.8): create -> use -> revoke -> refused.
#   4. Cron surface: queue-digest (#2272), platform-health-digest (#2276),
#      ingestion flag-gate (#2233), db-health.
#   5. Chain/batch observation (service-role read-only): status counts +
#      distinct txids (Trigger A/B/flush raw feed).
#   6. Per-org isolation: anon org read returns zero rows.
# Writes ONE artifact per cycle. Exit 1 only when no artifact was produced.
set -uo pipefail
D="$HOME/arkova-soak/consolidated-mm-2026-08"
. "$D/env.cmm"
export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3
mkdir -p "$OUTDIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
START="$(date -u +%FT%TZ)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
IDT="$(gcloud auth print-identity-token 2>/dev/null)"
SR="$(cat "$SR_KEY_FILE")"; ANON="$(cat "$ANON_KEY_FILE")"; CRON="$(cat "$CRON_SECRET_FILE")"

curl -s -m 30 -o "$TMP/health" -w '%{http_code}' -H "Authorization: Bearer $IDT" "$BASE/health" > "$TMP/health.code"
vget() { curl -s -m 30 -o "$TMP/body-$1" -D "$TMP/hdr-$1" -w '%{http_code}' \
  -H "X-Serverless-Authorization: Bearer $IDT" "$BASE$2" > "$TMP/code-$1"; }
vget verify_fixture "/api/v1/verify/$FIXTURE_PUBLIC_ID"
vget verify_unknown "/api/v1/verify/ARK-DOC-ZZZZ99"

JWT="$(bash "$D/mint-jwt.sh" 2>/dev/null || true)"
KC=""; KU=""; KR=""; KRU=""
if [ -n "$JWT" ]; then
  KC="$(curl -s -m 30 -X POST "$BASE/api/v1/keys" \
    -H "X-Serverless-Authorization: Bearer $IDT" -H "Authorization: Bearer $JWT" \
    -H 'Content-Type: application/json' \
    -d '{"name":"cmm-cycle-'"$STAMP"'","scopes":["verify"]}' \
    -o "$TMP/body-keycreate" -w '%{http_code}')"
  NKS="$(jq -r '.api_key // .key // empty' "$TMP/body-keycreate" 2>/dev/null)"
  NKI="$(jq -r '.id // .key_id // empty' "$TMP/body-keycreate" 2>/dev/null)"
  if [ -n "$NKS" ]; then
    KU="$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
      -H "X-Serverless-Authorization: Bearer $IDT" -H "Authorization: Bearer $NKS" \
      "$BASE/api/v1/verify/$FIXTURE_PUBLIC_ID")"
  fi
  if [ -n "$NKI" ]; then
    KR="$(curl -s -m 30 -X DELETE -o "$TMP/body-keyrevoke" -w '%{http_code}' \
      -H "X-Serverless-Authorization: Bearer $IDT" -H "Authorization: Bearer $JWT" \
      "$BASE/api/v1/keys/$NKI")"
    if [ -n "${NKS:-}" ]; then
      KRU="$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
        -H "X-Serverless-Authorization: Bearer $IDT" -H "Authorization: Bearer $NKS" \
        "$BASE/api/v1/verify/$FIXTURE_PUBLIC_ID")"
    fi
  fi
fi

cpost() { curl -s -m 60 -X POST -o "$TMP/body-$1" -w '%{http_code}' \
  -H "Authorization: Bearer $IDT" -H "X-Cron-Secret: $CRON" "$BASE$2" > "$TMP/code-$1"; }
cpost queue_digest /jobs/queue-digest
cpost platform_health_digest /jobs/platform-health-digest
cpost fetch_dapip /jobs/fetch-dapip
cpost db_health /jobs/db-health

sq() { curl -s -m 30 -H "apikey: $SR" -H "Authorization: Bearer $SR" \
  -H 'Prefer: count=exact' -o /dev/null -D - "$SUPA/rest/v1/$2&limit=1" 2>/dev/null \
  | grep -i '^content-range' | sed 's/.*\///' | tr -d '\r' > "$TMP/$1"; }
sq cnt_pending      "anchors?select=id&status=eq.PENDING"
sq cnt_submitted    "anchors?select=id&status=eq.SUBMITTED"
sq cnt_broadcasting "anchors?select=id&status=eq.BROADCASTING"
sq cnt_secured      "anchors?select=id&status=eq.SECURED"
curl -s -m 30 -H "apikey: $SR" -H "Authorization: Bearer $SR" \
  "$SUPA/rest/v1/anchors?select=chain_tx_id&chain_tx_id=not.is.null&order=updated_at.desc&limit=500" \
  2>/dev/null | jq -r '[.[].chain_tx_id] | unique | length' > "$TMP/distinct_txids" || echo 0 > "$TMP/distinct_txids"

ISO_CODE="$(curl -s -m 30 -o "$TMP/body-iso" -w '%{http_code}' \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  "$SUPA/rest/v1/organizations?select=id&limit=5")"
ISO_BODY="$(head -c 100 "$TMP/body-iso" 2>/dev/null)"

python3 - "$TMP" "$OUTDIR/load-$STAMP.json" "$START" "$HEAD_SHA" "$REVISION" \
  "$KC" "$KU" "$KR" "$KRU" "$ISO_CODE" "$ISO_BODY" <<'PY'
import json, sys, os, datetime
tmp, out, start, head, rev = sys.argv[1:6]
kc, ku, kr, kru, iso_code, iso_body = sys.argv[6:12]
def rd(p):
    try: return open(os.path.join(tmp, p)).read().strip()
    except Exception: return ""
def jl(p):
    try: return json.loads(rd(p))
    except Exception: return None
probes = []
def P(n, ok, detail): probes.append({"name": n, "status": "pass" if ok else "fail", "detail": detail})
h = jl("health"); hc = rd("health.code")
P("worker_health_200", hc == "200", f"HTTP {hc}")
P("worker_git_sha_is_exact_head", bool(h) and h.get("git_sha") == head,
  f"/health git_sha={(h or {}).get('git_sha')} expected={head}")
P("worker_checks_all_ok", bool(h) and all(v == "ok" for v in (h.get("checks") or {}).values()),
  f"checks={(h or {}).get('checks')} network={(h or {}).get('network')}")
vf = rd("code-verify_fixture"); vu = rd("code-verify_unknown")
P("verify_fixture_200", vf == "200", f"HTTP {vf} body={rd('body-verify_fixture')[:120]}")
P("verify_unknown_404", vu == "404", f"HTTP {vu} body={rd('body-verify_unknown')[:120]}")
hdr = ""
try: hdr = open(os.path.join(tmp, "hdr-verify_fixture")).read().lower()
except Exception: pass
P("ratelimit_headers_present", "ratelimit" in hdr, "RateLimit headers on anon verify")
P("apikey_create_ok", kc in ("200", "201"), f"POST /api/v1/keys HTTP {kc} body={rd('body-keycreate')[:100]}")
P("apikey_usable_before_revoke", ku == "200", f"verify w/ new key HTTP {ku}")
P("apikey_revoke_reachable", kr in ("200", "204"), f"DELETE /api/v1/keys/:id HTTP {kr} (FD-P7 CC6.8)")
P("apikey_refused_after_revoke", kru in ("401", "403"), f"verify w/ revoked key HTTP {kru}")
qd = rd("code-queue_digest"); ph = rd("code-platform_health_digest")
fd = rd("code-fetch_dapip"); db = rd("code-db_health")
P("cron_queue_digest_200", qd == "200", f"HTTP {qd} body={rd('body-queue_digest')[:100]}")
P("cron_platform_health_digest_200", ph == "200", f"HTTP {ph} body={rd('body-platform_health_digest')[:100]}")
P("cron_ingestion_flag_gate", fd in ("200", "503"),
  f"HTTP {fd} body={rd('body-fetch_dapip')[:140]} (#2233: disabled->200 / unconfigured->503)")
P("cron_db_health_200", db == "200", f"HTTP {db}")
try: iso_rows = len(json.loads(iso_body)) if iso_body.startswith("[") else -1
except Exception: iso_rows = -1
P("per_org_isolation_anon_zero_rows", (iso_code in ("401", "403")) or (iso_code == "200" and iso_rows == 0),
  f"anon organizations HTTP {iso_code} rows={iso_rows}")
def num(p):
    v = rd(p)
    try: return int(v)
    except Exception: return None
counts = {"pending": num("cnt_pending"), "submitted": num("cnt_submitted"),
          "broadcasting": num("cnt_broadcasting"), "secured": num("cnt_secured"),
          "distinct_chain_txids_recent": num("distinct_txids")}
status = "fail" if any(p["status"] == "fail" for p in probes) else "pass"
json.dump({"soak": "consolidated-mm-2026-08", "rc": "RC-2026-08-22-deferred-basedrift-exit",
    "tier": "T3", "cycle_start": start,
    "cycle_end": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "head_sha": head, "worker_revision": rev, "status": status,
    "probes": probes, "chain_observation": counts,
    "probes_total": len(probes),
    "probes_failed": len([p for p in probes if p["status"] == "fail"])}, open(out, "w"), indent=1)
print(f"cycle artifact {out} status={status} counts={counts}")
PY
rc=$?
[ -f "$OUTDIR/load-$STAMP.json" ] || exit 1
exit $rc
