#!/usr/bin/env bash
#
# runpod-rotate-endpoint.sh
#
# Rotates the Nessie RunPod serverless endpoint to a new HF model.
# Used once a freshly-merged Nessie version has been pushed to HF by the
# runpod-merge-nessie.py pipeline.
#
# Steps:
#   1. PATCH template MODEL_NAME → new HF repo
#   2. DELETE old endpoint (if --old-endpoint provided)
#   3. POST new endpoint (prints new endpoint ID to stdout)
#
# Usage:
#   ./runpod-rotate-endpoint.sh \
#     --hf-repo       carsonarkova/nessie-v27-fcra \
#     --template      3fbtz393el \
#     --endpoint-name nessie-v27-fcra-prod \
#     --old-endpoint  qgp44409nbsgi0
#
# Env required: RUNPOD_API_KEY, HF_TOKEN
set -euo pipefail

HF_REPO=""
TEMPLATE=""
ENDPOINT_NAME=""
OLD_ENDPOINT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --hf-repo)       HF_REPO="$2";       shift 2 ;;
    --template)      TEMPLATE="$2";      shift 2 ;;
    --endpoint-name) ENDPOINT_NAME="$2"; shift 2 ;;
    --old-endpoint)  OLD_ENDPOINT="$2";  shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[ -z "$HF_REPO" ]       && { echo "--hf-repo required"; exit 1; }
[ -z "$TEMPLATE" ]      && { echo "--template required"; exit 1; }
[ -z "$ENDPOINT_NAME" ] && { echo "--endpoint-name required"; exit 1; }
[ -z "${RUNPOD_API_KEY:-}" ] && { echo "RUNPOD_API_KEY not set"; exit 1; }
[ -z "${HF_TOKEN:-}" ]       && { echo "HF_TOKEN not set"; exit 1; }

echo "[1/3] Patching template $TEMPLATE MODEL_NAME -> $HF_REPO..."
curl -s -X PATCH "https://rest.runpod.io/v1/templates/$TEMPLATE" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"env\":{\"MODEL_NAME\":\"$HF_REPO\",\"DTYPE\":\"bfloat16\",\"GPU_MEMORY_UTILIZATION\":\"0.85\",\"MAX_MODEL_LEN\":\"8192\",\"HF_TOKEN\":\"$HF_TOKEN\",\"HUGGING_FACE_HUB_TOKEN\":\"$HF_TOKEN\"},\"imageName\":\"runpod/worker-v1-vllm:v2.7.0stable-cuda12.1.0\"}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('  template.env.MODEL_NAME =', d.get('env',{}).get('MODEL_NAME','?'))"

if [ -n "$OLD_ENDPOINT" ]; then
  echo "[2/3] Deleting old endpoint $OLD_ENDPOINT..."
  curl -s -X DELETE "https://rest.runpod.io/v1/endpoints/$OLD_ENDPOINT" \
    -H "Authorization: Bearer $RUNPOD_API_KEY" -o /tmp/delete-resp.txt
  echo "  deleted (HTTP response in /tmp/delete-resp.txt)"
else
  echo "[2/3] Skipping delete — no --old-endpoint."
fi

echo "[3/3] Creating new endpoint $ENDPOINT_NAME..."
curl -s -X POST "https://rest.runpod.io/v1/endpoints" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\":\"$ENDPOINT_NAME\",
    \"templateId\":\"$TEMPLATE\",
    \"computeType\":\"GPU\",
    \"gpuTypeIds\":[\"NVIDIA RTX A6000\",\"NVIDIA L40S\",\"NVIDIA A40\",\"NVIDIA RTX 6000 Ada Generation\"],
    \"workersMin\":0,
    \"workersMax\":2,
    \"idleTimeout\":60,
    \"scalerType\":\"QUEUE_DELAY\",
    \"scalerValue\":4,
    \"executionTimeoutMs\":120000
  }" | tee /tmp/new-endpoint.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('  new endpoint ID:', d.get('id','?'))
print('  name:', d.get('name','?'))
print('  model:', d.get('template',{}).get('env',{}).get('MODEL_NAME','?'))
"

echo ""
echo "DONE. Update worker .env RUNPOD_ENDPOINT_ID to the new ID printed above."
