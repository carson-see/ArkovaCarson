#!/usr/bin/env bash
# consolidated-mm-2026-08 T3 supervisor — back-to-back cycles for 48h, then
# seals the window. Defects deliberately avoided (each cost real time before):
#   * date -u -j -f : omitting -u makes macOS read the UTC close time as LOCAL
#     and overruns the window by exactly 4h (ferpa2314/train-6). Parse is
#     echoed back for audit.
#   * close-capture IS invoked, exactly once, at close.
#   * FD-TRIGGER-1: ambient load cannot reach Trigger A/B — this supervisor
#     runs the volume phases itself (B-volume at cycle 1, A-volume at cycle 26)
#     and fires the daily 03:00Z forced flush (Trigger D observation) because
#     in-process node-cron does not fire reliably on throttled Cloud Run.
set -uo pipefail
D="$HOME/arkova-soak/consolidated-mm-2026-08"
. "$D/env.cmm"
export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3
LOG="$D/supervisor-cmm.log"
CADENCE=600
END_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$END_ISO" +%s 2>/dev/null)
[ -n "${END_EPOCH:-}" ] || { echo "FATAL: could not parse END_ISO=$END_ISO" >&2; exit 1; }
echo "supervisor-cmm start $(date -u +%FT%TZ) clock_start=$CLOCK_START end_iso=$END_ISO end_epoch=$END_EPOCH readback=$(date -u -r "$END_EPOCH" +%FT%TZ) cadence=${CADENCE}s" >> "$LOG"
n=0; consec_fail=0; last_flush_day=""
while [ "$(date +%s)" -lt "$END_EPOCH" ]; do
  t0=$(date +%s)
  n=$((n+1))
  # --- volume phases (FD-TRIGGER-1): B-volume first, A-volume ~T+4.2h -----
  if [ "$n" -eq 1 ] && [ ! -f "$D/.volume-b-started" ]; then
    touch "$D/.volume-b-started"
    nohup bash "$D/volume-inject.sh" 3100 b >> "$D/volume-b.log" 2>&1 &
    echo "cycle $n: launched B-volume injection (target 3100)" >> "$LOG"
  fi
  if [ "$n" -eq 26 ] && [ ! -f "$D/.volume-a-started" ]; then
    touch "$D/.volume-a-started"
    nohup bash "$D/volume-inject.sh" 10100 a >> "$D/volume-a.log" 2>&1 &
    echo "cycle $n: launched A-volume injection (target 10100)" >> "$LOG"
  fi
  # --- daily 03:00Z forced flush (Trigger D observation) ------------------
  UH="$(date -u +%H)"; UD="$(date -u +%Y%m%d)"
  if [ "$UH" = "03" ] && [ "$last_flush_day" != "$UD" ]; then
    last_flush_day="$UD"
    IDT="$(gcloud auth print-identity-token 2>/dev/null)"
    FC=$(curl -s -m 120 -X POST -o "$D/flush-$UD.body" -w '%{http_code}' \
      -H "Authorization: Bearer $IDT" -H "X-Cron-Secret: $(cat "$CRON_SECRET_FILE")" \
      "$BASE/jobs/batch-anchors?force=true")
    echo "{\"flush_date\":\"$UD\",\"http\":\"$FC\",\"fired_at\":\"$(date -u +%FT%TZ)\",\"body\":$(head -c 400 "$D/flush-$UD.body" | jq -Rs .)}" > "$OUTDIR/flush-$UD.json"
    echo "cycle $n: daily forced flush fired http=$FC" >> "$LOG"
  fi
  # --- ambient load segment (~9.5 min; see ambient-load.sh header) --------
  nohup bash "$D/ambient-load.sh" 570 >> "$D/ambient-load.log" 2>&1 &
  LH_PID=$!
  # --- the probe cycle ----------------------------------------------------
  bash "$D/cycle-cmm.sh" >> "$LOG" 2>&1
  rc=$?
  echo "cycle $n exited rc=$rc at $(date -u +%FT%TZ)" >> "$LOG"
  if [ "$rc" -ne 0 ]; then
    consec_fail=$((consec_fail+1))
    echo "  HARD FAILURE $consec_fail consecutive (no artifact produced)" >> "$LOG"
    if [ "$consec_fail" -ge 3 ]; then
      echo "ABORT: 3 consecutive cycles produced no artifact — stopping so the gap is visible" >> "$LOG"
      exit 1
    fi
  else
    consec_fail=0
  fi
  t1=$(date +%s); rest=$(( CADENCE - (t1 - t0) ))
  [ "$rest" -gt 0 ] && sleep "$rest"
  wait ${LH_PID:-} 2>/dev/null || true
done
echo "window closed $(date -u +%FT%TZ) after $n cycles — running close-capture" >> "$LOG"
bash "$D/close-capture-cmm.sh" >> "$LOG" 2>&1
echo "supervisor-cmm done $(date -u +%FT%TZ) rc=$?" >> "$LOG"
