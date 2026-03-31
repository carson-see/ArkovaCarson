#!/bin/bash
# Task 5: Deploy Nessie v5 to RunPod Serverless Endpoint
#
# Updates the existing endpoint hmayoqhxvy5k5y to serve the v5 model.
# Uses RunPod's Serverless API to update the endpoint configuration.
#
# Prerequisites:
#   - RUNPOD_API_KEY env var set
#   - Endpoint hmayoqhxvy5k5y exists (currently serving v2/v3)
#
# Usage:
#   ./deploy-runpod-v5.sh
#   RUNPOD_ENDPOINT_ID=custom_id ./deploy-runpod-v5.sh

set -euo pipefail

ENDPOINT_ID="${RUNPOD_ENDPOINT_ID:-hmayoqhxvy5k5y}"
MODEL_ID="carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v5-87e1d401"
WORKER_IMAGE="runpod/worker-vllm:stable-cuda12.1.0"

if [ -z "${RUNPOD_API_KEY:-}" ]; then
  echo "ERROR: RUNPOD_API_KEY not set."
  echo "Get your API key from https://www.runpod.io/console/user/settings"
  exit 1
fi

echo "=== Deploying Nessie v5 to RunPod Serverless ==="
echo "Endpoint:  $ENDPOINT_ID"
echo "Model:     $MODEL_ID"
echo "Image:     $WORKER_IMAGE"
echo ""

# Step 1: Check current endpoint status
echo "Checking endpoint status..."
CURRENT=$(curl -s -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  "https://api.runpod.io/v2/${ENDPOINT_ID}/health")
echo "Current health: $CURRENT"
echo ""

# Step 2: Update the endpoint template with v5 model via GraphQL API
echo "Updating endpoint to v5 model..."
RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
  -d "{
    \"query\": \"mutation { saveEndpoint(input: { id: \\\"${ENDPOINT_ID}\\\", templateId: null, env: [ { key: \\\"MODEL_NAME\\\", value: \\\"${MODEL_ID}\\\" }, { key: \\\"DTYPE\\\", value: \\\"float16\\\" }, { key: \\\"MAX_MODEL_LEN\\\", value: \\\"32768\\\" }, { key: \\\"GPU_MEMORY_UTILIZATION\\\", value: \\\"0.90\\\" }, { key: \\\"DISABLE_LOG_STATS\\\", value: \\\"true\\\" } ] }) { id name gpuIds workersMax workersMin } }\"
  }")

echo "Update response: $RESPONSE"
echo ""

# Step 3: Verify the update
echo "Verifying deployment..."
sleep 5
HEALTH=$(curl -s -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  "https://api.runpod.io/v2/${ENDPOINT_ID}/health")
echo "Post-update health: $HEALTH"
echo ""

# Step 4: Run a smoke test
echo "Running smoke test..."
SMOKE_RESULT=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  "https://api.runpod.ai/v2/${ENDPOINT_ID}/openai/v1/chat/completions" \
  -d '{
    "model": "'"${MODEL_ID}"'",
    "messages": [
      {"role": "system", "content": "You are a credential metadata extraction assistant. Extract structured metadata from PII-stripped credential text."},
      {"role": "user", "content": "The State Bar of California. Certificate of Completion. [NAME_REDACTED] completed Professional Responsibility and Ethics. 3.0 CLE Hours. March 2026."}
    ],
    "max_tokens": 512,
    "temperature": 0.0
  }')

echo "Smoke test result: $SMOKE_RESULT"
echo ""

# Check if smoke test succeeded
if echo "$SMOKE_RESULT" | grep -q '"choices"'; then
  echo "=== Deployment SUCCESSFUL ==="
  echo "Nessie v5 is now serving on endpoint $ENDPOINT_ID"
  echo ""
  echo "Verify in production with:"
  echo "  RUNPOD_API_KEY=\$KEY RUNPOD_ENDPOINT_ID=$ENDPOINT_ID npx tsx services/worker/src/ai/eval/run-eval.ts --provider nessie --sample 10"
else
  echo "=== WARNING: Smoke test did not return expected format ==="
  echo "This may be due to cold start (30-60s). Retry in a minute."
  echo "Or check: https://www.runpod.io/console/serverless/user/endpoints"
fi
