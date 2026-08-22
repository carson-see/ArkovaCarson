#!/usr/bin/env bash
#
# soak-liveness-check.sh — assert that a running soak is actually MEASURING something.
#
# WHY THIS EXISTS
# ---------------
# On 2026-08-20 three separate soak defects were found by hand, not by the soak:
#
#   FD-CLOCK-1   the clock measured instance uptime, which is not the soak clock
#   FD-TRIGGER-1 Trigger A/B thresholds were structurally unreachable at the driven rate,
#                so a T3 window could only ever evidence Trigger D
#   FD-WAVE3-1   the wave3 driver sent an empty bearer token for 5h10m and produced
#                ZERO valid requests
#
# All three share one root cause: **soak health was judged by "did the clock run and is
# /health green", and never by "did the soak actually exercise anything."** Under those
# criteria a soak measuring nothing is indistinguishable from a healthy soak. wave3 sat
# green for five hours while every single request it made failed.
#
# This script asserts on the EVIDENCE, not on the rig. A rig can be perfectly healthy and
# still be producing worthless evidence; that is the case this catches.
#
# USAGE
#   soak-liveness-check.sh <name> <evidence-dir> [expected-revision] [service]
#
#   name              label used in output, e.g. wave3
#   evidence-dir      dir the driver writes its evidence JSON into
#   expected-revision  optional; serving revision the clock is pinned to
#   service           optional; Cloud Run service to read the live revision from
#
# ENV
#   MAX_EVIDENCE_AGE_MIN  default 90 (three missed 30-minute cycles)
#   GCP_PROJECT           default arkova1
#   GCP_REGION            default us-central1
#
# EXIT
#   0 healthy   1 evidence stale/absent/empty, or revision drifted
#
set -uo pipefail

NAME="${1:?usage: soak-liveness-check.sh <name> <evidence-dir> [expected-revision] [service]}"
EVID_DIR="${2:?evidence dir required}"
EXPECT_REV="${3:-}"
SERVICE="${4:-}"

MAX_AGE_MIN="${MAX_EVIDENCE_AGE_MIN:-90}"
GCP_PROJECT="${GCP_PROJECT:-arkova1}"
GCP_REGION="${GCP_REGION:-us-central1}"

fail=0
say()  { printf '[%s] %s\n' "$NAME" "$1"; }
bad()  { printf '[%s] FAIL: %s\n' "$NAME" "$1" >&2; fail=1; }

# --- 1. Evidence exists at all -----------------------------------------------------
if [[ ! -d "$EVID_DIR" ]]; then
  bad "evidence dir does not exist: $EVID_DIR"
  exit 1
fi

newest="$(find "$EVID_DIR" -maxdepth 1 -name '*.json' -type f -print0 2>/dev/null \
          | xargs -0 ls -t 2>/dev/null | head -1)"

if [[ -z "$newest" ]]; then
  bad "no evidence JSON in $EVID_DIR — the driver has never written a cycle"
  exit 1
fi

# --- 2. Evidence is fresh ----------------------------------------------------------
age_min=$(( ( $(date +%s) - $(stat -f %m "$newest" 2>/dev/null || stat -c %Y "$newest") ) / 60 ))
if (( age_min > MAX_AGE_MIN )); then
  bad "newest evidence is ${age_min}m old (limit ${MAX_AGE_MIN}m): $(basename "$newest")"
else
  say "evidence fresh: $(basename "$newest") (${age_min}m old)"
fi

# --- 3. Evidence is NON-EMPTY ------------------------------------------------------
# THE check. wave3 wrote no evidence at all; a subtler break writes a file whose every
# request failed. Both are "green" to a health probe and worthless as soak evidence.
ok_total="$(python3 - "$newest" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(-1); raise SystemExit
# shape A (bespoke drivers): {"requests": {"ok": N}}
r = d.get("requests")
if isinstance(r, dict) and "ok" in r:
    print(int(r["ok"] or 0)); raise SystemExit
# shape B (load-harness): {"byMode": {"<mode>": {"ok": N}}}
bm = d.get("byMode")
if isinstance(bm, dict):
    print(sum(int((v or {}).get("ok") or 0) for v in bm.values())); raise SystemExit
print(-1)
PY
)"

case "$ok_total" in
  -1|"") bad "cannot read an ok-count from $(basename "$newest") — unrecognised evidence shape" ;;
  0)     bad "evidence reports ok=0 — the soak ran but exercised NOTHING (this is the wave3/FD-WAVE3-1 signature: check the driver's auth, not the rig)" ;;
  *)     say "evidence non-empty: ok=$ok_total successful requests" ;;
esac

# --- 4. Clock integrity: serving revision unchanged --------------------------------
# Per FD-CLOCK-1 the clock is the serving revision's creationTimestamp plus integrity
# conditions. A changed revision resets the clock; instance recycling does not.
if [[ -n "$EXPECT_REV" && -n "$SERVICE" ]]; then
  live_rev="$(gcloud run services describe "$SERVICE" \
                --project "$GCP_PROJECT" --region "$GCP_REGION" \
                --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"
  if [[ -z "$live_rev" ]]; then
    bad "could not read serving revision for $SERVICE"
  elif [[ "$live_rev" != *"$EXPECT_REV"* ]]; then
    bad "revision drifted: expected *${EXPECT_REV}, serving ${live_rev} — SOAK CLOCK IS RESET"
  else
    say "revision pinned: $live_rev"
  fi
fi

if (( fail )); then
  printf '[%s] SOAK IS NOT PRODUCING VALID EVIDENCE — do not count this window.\n' "$NAME" >&2
  exit 1
fi
say "liveness OK"
