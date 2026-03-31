#!/bin/bash
# NMT-05: Upload Nessie v5 Weights to HuggingFace
#
# Downloads the fine-tuned v5 model from Together AI and pushes to
# carsonarkova/nessie-v5-llama-3.1-8b on HuggingFace.
#
# Prerequisites:
#   - TOGETHER_API_KEY env var set (for model download)
#   - HF_TOKEN env var set (for HuggingFace upload, write access)
#   - huggingface-cli installed (pip install huggingface_hub)
#   - ~16GB disk space for model weights
#
# Usage:
#   TOGETHER_API_KEY=xxx HF_TOKEN=xxx ./upload-hf-v5.sh

set -euo pipefail

TOGETHER_MODEL="carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v5-87e1d401"
HF_REPO="carsonarkova/nessie-v5-llama-3.1-8b"
DOWNLOAD_DIR="${TMPDIR:-/tmp}/nessie-v5-weights"

if [ -z "${TOGETHER_API_KEY:-}" ]; then
  echo "ERROR: TOGETHER_API_KEY not set."
  exit 1
fi

if [ -z "${HF_TOKEN:-}" ]; then
  echo "ERROR: HF_TOKEN not set."
  echo "Create a write token at https://huggingface.co/settings/tokens"
  exit 1
fi

echo "=== NMT-05: Upload Nessie v5 to HuggingFace ==="
echo "Source:      Together AI ($TOGETHER_MODEL)"
echo "Destination: $HF_REPO"
echo "Download:    $DOWNLOAD_DIR"
echo ""

# Step 1: Install dependencies if needed
if ! command -v huggingface-cli &> /dev/null; then
  echo "Installing huggingface_hub..."
  pip install -q huggingface_hub[cli]
fi

# Step 2: Login to HuggingFace
echo "Logging into HuggingFace..."
huggingface-cli login --token "$HF_TOKEN"

# Step 3: Download model from Together AI
# Together AI stores fine-tuned models in HF-compatible format
echo "Downloading v5 weights from Together AI..."
mkdir -p "$DOWNLOAD_DIR"

# Together AI uses the same format as HF — download via the HF Hub
# The TOGETHER_API_KEY works as an HF token for Together-hosted models
export HF_TOKEN_DOWNLOAD="${TOGETHER_API_KEY}"
huggingface-cli download "$TOGETHER_MODEL" \
  --local-dir "$DOWNLOAD_DIR" \
  --token "$HF_TOKEN_DOWNLOAD" \
  --local-dir-use-symlinks False

echo ""
echo "Download complete. Contents:"
ls -lh "$DOWNLOAD_DIR"
echo ""

# Step 4: Create model card
cat > "$DOWNLOAD_DIR/README.md" << 'MODELCARD'
---
license: llama3.1
base_model: meta-llama/Meta-Llama-3.1-8B-Instruct
tags:
  - credential-verification
  - document-extraction
  - fine-tuned
  - arkova
  - nessie
datasets:
  - custom
language:
  - en
pipeline_tag: text-generation
model-index:
  - name: nessie-v5-llama-3.1-8b
    results:
      - task:
          type: text-generation
          name: Credential Metadata Extraction
        metrics:
          - type: weighted-f1
            value: 87.2
            name: Weighted F1
          - type: macro-f1
            value: 75.7
            name: Macro F1
---

# Nessie v5 (Llama 3.1 8B Fine-tune)

**Nessie** is Arkova's credential metadata extraction model, fine-tuned from Meta Llama 3.1 8B Instruct for structured extraction of credential metadata from PII-stripped document text.

## Model Details

- **Base model:** meta-llama/Meta-Llama-3.1-8B-Instruct
- **Fine-tuning:** Together AI (job ft-b8594db6-80f9)
- **Training data:** 1,903 train + 211 validation examples
- **Precision:** float16
- **Context length:** 32,768 tokens
- **Training mix:** 75% domain-specific + 25% general credential data

## Evaluation Results (v5)

| Metric | Value |
|--------|-------|
| Weighted F1 | 87.2% |
| Macro F1 | 75.7% |
| Mean Confidence | 72.5% |
| Mean Accuracy | 83.5% |
| Confidence Correlation (r) | 0.539 |
| Mean Latency | 1,543ms |

### Per-Type Performance (Top 10)

| Type | Weighted F1 | Sample Size |
|------|------------|-------------|
| FINANCIAL | 100.0% | n=2 |
| TRANSCRIPT | 100.0% | n=2 |
| RESUME | 100.0% | n=2 |
| DEGREE | 98.5% | n=11 |
| PATENT | 97.1% | n=4 |
| LICENSE | 96.6% | n=10 |
| PROFESSIONAL | 95.8% | n=7 |
| INSURANCE | 93.3% | n=4 |
| LEGAL | 92.9% | n=3 |
| CLE | 91.1% | n=2 |

## Intended Use

Nessie extracts structured metadata from PII-stripped credential text. Input is pre-processed to remove personally identifiable information before reaching the model.

**Important:** This model must be used with its trained condensed prompt (~1.5K chars). Using the full extraction prompt (58K chars) causes 0% F1 due to prompt template mismatch.

## Credential Types Supported

DEGREE, LICENSE, CERTIFICATE, BADGE, SEC_FILING, LEGAL, REGULATION, PATENT, PUBLICATION, ATTESTATION, INSURANCE, FINANCIAL, MILITARY, CLE, RESUME, MEDICAL, IDENTITY, TRANSCRIPT, PROFESSIONAL, OTHER

## Domain-Specific Adapters

Nessie v5 includes domain-specific LoRA adapters trained on specialized corpora:

- **SEC** (45K examples): SEC filings, financial disclosures
- **Academic** (45K examples): Degrees, transcripts, publications
- **Legal** (13K examples): Legal documents, bar admissions, CLE
- **Regulatory** (13K examples): Licenses, regulations, compliance

## Limitations

- Only processes PII-stripped text (by design)
- Small sample sizes for some credential types (FINANCIAL, TRANSCRIPT, RESUME at n=2)
- fraudSignals field has 0% F1 (known limitation, under improvement)
- Confidence calibration ECE of 11% (recalibrated via piecewise linear function)

## Citation

```
@software{nessie-v5,
  title={Nessie v5: Credential Metadata Extraction Model},
  author={Arkova},
  year={2026},
  url={https://arkova.ai}
}
```

## License

This model is released under the Llama 3.1 Community License. See META's license for details.
MODELCARD

echo "Model card created."

# Step 5: Upload to HuggingFace
echo "Uploading to $HF_REPO..."
huggingface-cli upload "$HF_REPO" "$DOWNLOAD_DIR" \
  --repo-type model \
  --token "$HF_TOKEN"

echo ""
echo "=== Upload COMPLETE ==="
echo "Model available at: https://huggingface.co/$HF_REPO"
echo ""

# Step 6: Cleanup
read -p "Delete local weights ($DOWNLOAD_DIR)? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  rm -rf "$DOWNLOAD_DIR"
  echo "Cleaned up."
fi
