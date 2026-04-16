# Training Infrastructure Runbook — 2026-04-15

> Canonical "where to do what" guide for Arkova AI training. Read before starting any training run. Pairs with `nessie-training-parameters-v1.md` and `gemini-training-parameters-v1.md`.

## TL;DR — three platforms, three jobs

| Platform | What it's for | What it's NOT for |
|---|---|---|
| **Together AI** | Nessie LoRA SFT (cheap, fast) | Hosting fine-tunes for inference (they're non-serverless) |
| **RunPod** | Serving Nessie + one-off compute pods (merge, HF push) | Long training runs (Together is cheaper) |
| **Vertex AI** | Gemini 2.5-pro/flash/flash-lite tuning | Anything Llama-based |

**Rule of thumb:** training money goes to Together (LoRA) or Vertex (Gemini). Inference money goes to RunPod (Nessie) or Vertex (Gemini). **Local disk is never used for model artifacts.**

---

## 1. Together AI — Nessie SFT

### 1.1 Cost reality

- LoRA SFT on Llama 3.1 8B: $5–30 per run (depends on epochs × dataset size)
- **Fine-tuned model hosting: NOT serverless.** Trying to call a Together fine-tune via OpenAI-compat API returns `400 model_not_available` unless you pay for a dedicated endpoint (~$3–7/hr per GPU). We don't pay for that. We download the LoRA and serve via RunPod.

### 1.2 Submit a training job

```bash
cd services/worker
# 1. Build dataset
npx tsx scripts/build-domain-dataset.ts DEGREE
# Output: training-output/nessie-degree-v1-train.jsonl (validated against ExtractedFieldsSchema)

# 2. Validate before upload
npx tsx scripts/validate-training-jsonl.ts training-output/nessie-degree-v1-train.jsonl

# 3. Upload + train
together files upload training-output/nessie-degree-v1-train.jsonl
# → file ID: file-xxx
together fine-tuning create \
  --training-file file-xxx \
  --model meta-llama/Meta-Llama-3.1-8B-Instruct-Reference \
  --suffix arkova-nessie-degree-v1 \
  --lora --lora-r 16 --lora-alpha 32 --lora-dropout 0.05 \
  --n-epochs 3 --batch-size 8 --learning-rate 1e-4
# → job ID: ft-xxx
```

### 1.3 Monitor

```bash
together fine-tuning retrieve ft-xxx
# Status flow: pending → running → uploading → completed
```

### 1.4 Download for deploy

```bash
# DO NOT download to local. SSH into RunPod merge pod (see §2.3) and run there.
```

---

## 2. RunPod — Nessie serving + one-off merge pods

### 2.1 Two distinct uses

1. **Serverless endpoint** (long-lived, scales to zero): serves Nessie inference via vLLM
2. **One-off pod** (provisioned per deploy, terminated after): downloads LoRA, merges with base, pushes to HF

### 2.2 Live serverless endpoint

Current: `nessie-v5-prod` (id `ypefdp603ymsuo`)
- Template: `nessie-v5-serverless` (id `4yjqhdq2ra`)
- Image: `runpod/worker-vllm:stable-cuda12.1.0`
- Model: `carsonarkova/nessie-v5-llama-3.1-8b` (HuggingFace)
- DTYPE: `bfloat16` (NOT `half` — `half` crashes vLLM on these weights)
- Disk: 120 GB
- GPUs allowed: A6000, L40S, RTX 6000 Ada (cheap, 48GB VRAM)
- Workers: 0 min, 2 max
- Idle timeout: 60s

**Update endpoint to a new model:**

```bash
# 1. PATCH the template's MODEL_NAME
curl -X PATCH "https://rest.runpod.io/v1/templates/4yjqhdq2ra" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"env":{"MODEL_NAME":"carsonarkova/nessie-degree-v1","DTYPE":"bfloat16","GPU_MEMORY_UTILIZATION":"0.85","HF_TOKEN":"'$HF_TOKEN'","HUGGING_FACE_HUB_TOKEN":"'$HF_TOKEN'","MAX_MODEL_LEN":"4096"}}'
# 2. Wait 1-2 min for cold pull of new HF model
# 3. Smoke test (§2.4)
```

### 2.3 One-off merge + HF push pod (the path we use INSTEAD of local merge)

Whenever a Together LoRA finishes training and we need it on HF:

```bash
# Provision a single A6000 pod with 200GB disk
curl -X POST "https://rest.runpod.io/v1/pods" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "nessie-deploy-<domain>-<ver>",
    "imageName": "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
    "gpuTypeIds": ["NVIDIA RTX A6000"],
    "containerDiskInGb": 200,
    "env": {
      "TOGETHER_API_KEY": "<key>",
      "HF_TOKEN": "<token>",
      "TOGETHER_MODEL_ID": "carson_6cec/...arkova-nessie-degree-v1-xxx",
      "HF_TARGET_REPO": "carsonarkova/nessie-degree-v1"
    }
  }'

# Then SSH in and run:
pip install together huggingface_hub peft transformers
together fine-tuning download "$TOGETHER_MODEL_ID" --output-dir /workspace/lora
zstd -d /workspace/lora/tmp* -o /workspace/lora.tar  # if Together returned compressed blob
# Run merge_lora.py (writes to /workspace/merged/)
huggingface-cli upload "$HF_TARGET_REPO" /workspace/merged --commit-message "<domain> v<n> merged"
# Pod self-terminates when /workspace/merged is uploaded successfully
```

A `services/worker/scripts/runpod-deploy-nessie.sh` wrapper script implements all of the above as one command. Build it after the first manual run validates the steps.

### 2.4 Smoke test endpoint

```bash
curl -X POST "https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID/run" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "openai_route": "/v1/chat/completions",
      "openai_input": {
        "model": "carsonarkova/nessie-v5-llama-3.1-8b",
        "messages": [
          {"role":"system","content":"Return strict JSON."},
          {"role":"user","content":"Return: {\"ok\":true}"}
        ],
        "max_tokens": 50, "temperature": 0
      }
    }
  }'
# → {"id":"<job-id>","status":"IN_QUEUE"}

# Poll every 25s:
curl "https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID/status/<job-id>" \
  -H "Authorization: Bearer $RUNPOD_API_KEY"
```

**Rules:**
- Always use `/run` + `/status` polling. `/runsync` returns 200 even if the worker crashes mid-execution (the curl-side 30s timeout silently fires).
- First request after idle = cold start = 60–120s. Subsequent requests ~1–3s.
- If the cold start exceeds 180s, the model failed to load (check logs in RunPod console).

---

## 3. Vertex AI — Gemini fine-tuning

### 3.1 Cost reality

- Tuning gemini-2.5-pro: ~$15 per 1M tokens of training data, plus storage
- Per-run typical cost: $40–$100
- Tuned endpoint hosting: hourly pricing, persists at zero traffic. **Delete unused endpoints monthly.**

### 3.2 Submit a tuning job

```bash
# 1. Build dataset (Vertex contents schema)
npx tsx scripts/build-fraud-dataset.ts
# Output: training-output/gemini-fraud-v7-vertex.jsonl

# 2. Upload to GCS
gsutil cp training-output/gemini-fraud-v7-vertex.jsonl \
  gs://arkova-training-data/gemini-fraud-v7.jsonl

# 3. Submit via gcloud
gcloud ai supervised-tuning create \
  --project=arkova1 \
  --region=us-central1 \
  --source-model=gemini-2.5-pro \
  --tuned-model-display-name=arkova-gemini-fraud-v7 \
  --training-dataset-uri=gs://arkova-training-data/gemini-fraud-v7.jsonl \
  --epoch-count=5
# → operation name: projects/.../operations/<op-id>
```

### 3.3 Monitor

```bash
gcloud ai supervised-tuning describe <op-id> --region=us-central1
# Status flow: queued → running → succeeded
# When done, output includes the deployed endpoint resource name
```

### 3.4 Wire to worker

```bash
# In services/worker/.env:
GEMINI_TUNED_MODEL=projects/270018525501/locations/us-central1/endpoints/<endpoint-id>
# Restart worker (or push new Cloud Run revision)
```

---

## 4. Cross-platform sanity rules

1. **Never train Nessie on Vertex.** Nessie is a Llama LoRA, Vertex doesn't tune Llama.
2. **Never train Gemini on Together.** Vertex is the only legal Gemini tuning platform.
3. **Never serve a Nessie LoRA via Together's chat completions API.** They're non-serverless. Always merge → HF → RunPod.
4. **Never store model artifacts on local disk.** Local is for code. Models live on HF, GCS, or platform-internal storage.
5. **Always run an eval after deploy.** No deploy without an eval doc in `services/worker/docs/eval/`.
6. **Always verify endpoint health before declaring training complete.** "Job succeeded on Together" ≠ "model is reachable for inference." The v6–v26 disaster started because we conflated those.

---

## 5. Costs spent vs costs wasted (post-mortem on v6–v26)

| Activity | Approx spend | Outcome |
|---|---|---|
| Together LoRA training (v6–v26) | ~$200–600 | All 21 sit unused; non-serverless |
| HF storage (v2, v5, ~50GB total Pro storage) | ~$10/month | v2 + v5 USABLE — discovered today |
| Vertex Gemini tuning (v5-extraction, v5-reasoning, v6-compliance) | ~$200 | None deployed in production |
| RunPod failed deploy attempts | ~$5 | Endpoints created and abandoned |
| Local disk (51GB of model artifacts in /tmp) | n/a | Filled disk to 99%; freed today |
| **Total productive output** | — | **0 deployed inference paths** until today's v5 endpoint |

---

## 6. Going forward — the canonical loop

```
1. Pick ONE capability (e.g., DEGREE extraction OR fraud detection — never both)
2. Curate dataset (50–500 hand-validated examples)
3. Pick the right platform per §4
4. Submit training run with parameters from training-parameters-v1.md
5. When training completes: deploy via the platform's runbook section above
6. Smoke test the deployed endpoint
7. Run full eval, write doc to docs/eval/
8. If DoD met: production canary
9. Move to next capability
```

No skipping steps. No "let's just train one more version while we wait."
