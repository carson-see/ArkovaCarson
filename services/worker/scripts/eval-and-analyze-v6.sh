#!/bin/bash
#
# Gemini Golden v6 — eval → analyze pipeline
# One-shot: given a v6 endpoint path, runs 50-sample eval, then the v6 analyzer.
# Prints final DoD verdict.
#
# Usage:
#   ./scripts/eval-and-analyze-v6.sh projects/270018525501/locations/us-central1/endpoints/<id>
#
# Exit 0 = all DoD targets met (safe to cut production over)
# Exit 1 = at least one DoD target missed (hold cutover)

set -e

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <v6-endpoint-path>" >&2
  exit 2
fi
ENDPOINT="$1"

cd "$(dirname "$0")/.."

echo "--- v6 eval → analyze pipeline ---"
echo "endpoint: $ENDPOINT"
echo

# 1. Load env
set -a
# shellcheck disable=SC1091
source .env
set +a
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/.config/gcloud/arkova-cli-key.json}"
export GEMINI_TUNED_MODEL="$ENDPOINT"
# v6 endpoints require the v6 system+user prompts they were trained on (see
# services/worker/src/ai/gemini.ts:115 — flag gates prompt selection). Missing
# this flag runs the v5 prompt against the v6 endpoint and regresses metrics.
export GEMINI_V6_PROMPT=true

# 2. Smoke test (fails fast on auth / schema / endpoint issues)
echo "=== Smoke test ==="
if ! npx tsx scripts/smoke-test-gemini-golden-v6.ts; then
  echo "Smoke test FAILED — aborting"
  exit 1
fi
echo

# 3. Full 50-sample eval
echo "=== 50-sample extraction eval ==="
TS=$(date -u +%Y-%m-%dT%H-%M-%S)
EVAL_OUT_DIR=docs/eval
mkdir -p "$EVAL_OUT_DIR"
npx tsx src/ai/eval/run-eval.ts --provider gemini --sample 50 --output "$EVAL_OUT_DIR"
EVAL_JSON=$(ls -t "$EVAL_OUT_DIR"/eval-gemini-*.json | head -1)
echo "Eval raw:  $EVAL_JSON"

# 4. v6-specific post-eval analysis
echo
echo "=== v6 analyzer ==="
ANALYSIS_OUT="$EVAL_OUT_DIR/eval-gemini-golden-v6-${TS}.md"
if npx tsx scripts/analyze-gemini-golden-v6-eval.ts --input "$EVAL_JSON" --output "$ANALYSIS_OUT"; then
  echo
  echo "=== VERDICT: DoD met — cleared for production cutover ==="
  echo "Analysis saved to: $ANALYSIS_OUT"
  echo
  echo "To cut over:"
  echo "  gcloud run services update arkova-worker --region us-central1 --project arkova1 \\"
  echo "    --update-env-vars \"GEMINI_TUNED_MODEL=$ENDPOINT,GEMINI_V6_PROMPT=true\""
  exit 0
else
  rc=$?
  echo
  echo "=== VERDICT: DoD NOT MET — hold production cutover ==="
  echo "Analysis saved to: $ANALYSIS_OUT"
  echo "Investigate failed metrics before cutover."
  exit $rc
fi
