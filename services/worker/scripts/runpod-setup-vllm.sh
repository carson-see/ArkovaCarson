#!/bin/bash
# NMT-04: Setup vLLM on RunPod pod for full-precision Nessie eval
# Usage: ssh into RunPod pod, then run this script with the model name
#
# Example:
#   ./runpod-setup-vllm.sh v3
#   ./runpod-setup-vllm.sh reasoning

set -e

MODEL_VARIANT="${1:-v3}"
PORT="${2:-8000}"

case "$MODEL_VARIANT" in
  v3)
    MODEL_ID="carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v3-22458d86"
    ;;
  reasoning)
    MODEL_ID="carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-reasoning-v1-54f2324d"
    ;;
  dpo)
    MODEL_ID="carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-dpo-v1-d81529d8"
    ;;
  *)
    echo "Usage: $0 [v3|reasoning|dpo] [port]"
    exit 1
    ;;
esac

echo "=== NMT-04: RunPod vLLM Setup ==="
echo "Model:    $MODEL_VARIANT ($MODEL_ID)"
echo "Port:     $PORT"
echo "Dtype:    float16 (full precision)"
echo "Max ctx:  32768 tokens"
echo ""

# Install vLLM if not present
if ! command -v vllm &> /dev/null; then
  echo "Installing vLLM..."
  pip install vllm==0.6.6 --quiet
fi

# Ensure Together AI token is set for model download
if [ -z "$TOGETHER_API_KEY" ]; then
  echo "ERROR: TOGETHER_API_KEY not set. Export it before running."
  exit 1
fi

# Set HF token to Together API key (Together models use HF-compatible download)
export HF_TOKEN="${TOGETHER_API_KEY}"

echo "Starting vLLM server..."
echo "  Model: $MODEL_ID"
echo "  Dtype: float16"
echo "  Max model len: 32768"
echo "  Port: $PORT"
echo ""

python -m vllm.entrypoints.openai.api_server \
  --host 0.0.0.0 \
  --port "$PORT" \
  --model "$MODEL_ID" \
  --dtype float16 \
  --max-model-len 32768 \
  --download-dir /runpod-volume/models \
  --trust-remote-code \
  --gpu-memory-utilization 0.90
