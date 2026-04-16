# Continuation Prompt for Next Session

> **Copy/paste the section below into the next session.** Everything below the line is the actual prompt — the heading above is just a label.

---

# CONTINUATION — Arkova AI session 2026-04-16 (Nessie v27 + Gemini Golden v6)

Read these first, in order:
1. `CLAUDE.md`
2. `docs/plans/nessie-v27-cco-design-2026-04-16.md` (Nessie v27 strategy)
3. `docs/plans/gemini-golden-v6-design-2026-04-16.md` (Gemini Golden v6 strategy)
4. `docs/plans/OVERNIGHT_REPORT_2026-04-15.md` (last session report)
5. `docs/plans/nessie-strategy-reset-2026-04-15.md` (root-cause document)
6. Confluence: https://arkova.atlassian.net/wiki/spaces/A/pages/11894785

## Where things stand right now (verifiable)

### In production
- Cloud Run revision `arkova-worker-00318-kxc` is live with `GEMINI_TUNED_MODEL=projects/270018525501/locations/us-central1/endpoints/8811908947217743872` (v5-reasoning Gemini Golden, +3.1pp Macro F1 / +2.9pp Weighted F1 over base).
- Production is **NOT** routing to Nessie. No `RUNPOD_API_KEY`/`RUNPOD_ENDPOINT_ID` in prod env.

### Training in flight
- **Nessie v27 FCRA** on Together — job `ft-56fd901e-669e`, status `pending` when submitted at ~13:05 UTC 2026-04-16. LoRA r=32, alpha=64, 5 epochs, lr 5e-5, 64 train + 16 test examples. Should complete in 30-90 min.
- Job info: `services/worker/training-output/nessie-v27-fcra-job.json`

### Currently deployed (RunPod serverless)
- `nessie-v26-prod-8k` endpoint `qgp44409nbsgi0` serves `carsonarkova/nessie-v26-llama-3.1-8b` (16GB merged Llama 3.1 8B + v26 LoRA). Working but v26 is the OLD generalist model and will be replaced by v27.
- Template `3fbtz393el` (nessie-v2-bfloat16) — patched to MAX_MODEL_LEN=8192, image `runpod/worker-v1-vllm:v2.7.0stable-cuda12.1.0`, DTYPE=bfloat16, GPU_MEMORY_UTILIZATION=0.85.

### Vertex AI tuned models (kept)
- v5-reasoning Gemini Golden — `endpoints/8811908947217743872` (in production)
- fraud-v1 — `endpoints/2117308101131501568` (kept for future fraud routing)
- All 7 wasteful duplicate endpoints undeployed (~$70/day saved)

### Authoritative eval numbers (post eval-framework fix)

**Extraction (50-sample golden set):**
| Model | Macro F1 | Weighted F1 | Latency |
|---|---|---|---|
| Gemini base (gemini-3-flash-preview) | 70.7% | 77.2% | 1.5s |
| Vertex v5-reasoning (PROD) | 73.8% | 80.1% | 11.4s |
| Vertex fraud-v1 | 70.3% | 81.0% | 8.5s |
| Vertex v5-extraction-deep | 68.3% | 78.6% | 11.4s |
| Nessie v26 RunPod | 55.5% | 70.7% | 30.9s |

**Intelligence (8 FCRA entries, RAG):**
| Model | Citation | Faithfulness | Relevance | Risk Recall | Confidence r |
|---|---|---|---|---|---|
| Nessie v26 | 0% | 31% | 14% | 0% | **0.895** |
| Gemini base | 0% | 16% | 47% | 38% | 0.642 |

v26 BEATS Gemini on faithfulness, confidence calibration, latency. LOSES on relevance and risk detection. Both fail citation accuracy (eval framework bug — both models hit 0% which is suspicious).

## What to do next (priority order)

### IMMEDIATELY: check v27 training
```bash
cd services/worker
set -a && source .env && set +a
python3 -c "
import os
from together import Together
c = Together(api_key=os.environ['TOGETHER_API_KEY'])
job = c.fine_tuning.retrieve('ft-56fd901e-669e')
print(f'status={job.status}')
print(f'output={getattr(job,\"x_model_output_name\",\"?\")}')"
```

If status=`completed`, proceed to deploy.

### Phase 1: Deploy v27 to RunPod (use proven pipeline from session 2026-04-15)

The merge pipeline that WORKS (v26 used it successfully):
1. Provision RunPod pod with image `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`, 200GB disk, A6000-class GPU
2. Use Python SDK `client.fine_tuning.content(ft_id='ft-56fd901e-669e', checkpoint='adapter')` to download adapter (the `together fine-tuning download` CLI is BROKEN — returns "not in completed state" for all completed jobs)
3. Decompress zstd blob (Together returns it as zstd)
4. Strip these keys from `adapter_config.json` (newer PEFT keys not in 0.15): `corda_config`, `eva_config`, `arrow_config`, `qalora_config`, `lora_bias`, `trainable_token_indices`, `exclude_modules`, `use_dora`, `layer_replication`
5. Override `base_model_name_or_path` to `meta-llama/Meta-Llama-3.1-8B-Instruct`
6. Use `peft==0.15.0` + `transformers>=4.46.0,<5` + `PeftModel.from_pretrained(base, '/workspace/adapter', autocast_adapter_dtype=False)` (autocast=False bypasses torch float8_e8m0fnu issue)
7. Merge + push to `carsonarkova/nessie-v27-fcra` on HuggingFace
8. SSH access: `ssh -p <port> root@<publicIp>` (RunPod's PUBLIC_KEY env is auto-set from your SSH key)

Reference script template: `services/worker/scripts/runpod-merge-and-deploy.sh` (designed but not yet executed end-to-end).

### Phase 2: Update RunPod template + create v27 endpoint

```bash
# Update template MODEL_NAME to v27
curl -X PATCH "https://rest.runpod.io/v1/templates/3fbtz393el" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"env":{"MODEL_NAME":"carsonarkova/nessie-v27-fcra","DTYPE":"bfloat16","GPU_MEMORY_UTILIZATION":"0.85","HF_TOKEN":"<token>","HUGGING_FACE_HUB_TOKEN":"<token>","MAX_MODEL_LEN":"8192"},"imageName":"runpod/worker-v1-vllm:v2.7.0stable-cuda12.1.0"}'

# Delete old v26 endpoint
curl -X DELETE "https://rest.runpod.io/v1/endpoints/qgp44409nbsgi0" -H "Authorization: Bearer $RUNPOD_API_KEY"

# Create new v27 endpoint
curl -X POST "https://rest.runpod.io/v1/endpoints" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"nessie-v27-fcra-prod","templateId":"3fbtz393el","computeType":"GPU","gpuTypeIds":["NVIDIA RTX A6000","NVIDIA L40S","NVIDIA A40","NVIDIA RTX 6000 Ada Generation"],"workersMin":0,"workersMax":2,"idleTimeout":60,"scalerType":"QUEUE_DELAY","scalerValue":4,"executionTimeoutMs":120000}'
```

### Phase 3: Eval v27 against intelligence dataset

```bash
cd services/worker && set -a && source .env && set +a
# Update RUNPOD_ENDPOINT_ID in .env to new v27 endpoint
# Then:
npx tsx scripts/eval-intelligence.ts --provider runpod --dataset v1 --limit 8

# Expected v27 results (per design doc DoD):
# Citation Accuracy: ≥95%
# Faithfulness: ≥90%
# Answer Relevance: ≥85%
# Risk Detection Recall: ≥80%
# Confidence Correlation: ≥0.85
# Mean Latency: ≤5s
```

If v27 hits 5/7+ targets: ship and start v28 (HIPAA).
If v27 misses badly: investigate categories with low scores, expand dataset, retrain v27.1.

### Phase 4: After v27 ships, design + train v28 (HIPAA)
- Same pattern as v27. New domain. Start fresh from base Llama 3.1 8B Instruct (NOT from v27 weights).
- Build HIPAA-specific dataset using `services/worker/scripts/build-hipaa-intelligence-dataset.ts` (write similar to FCRA script).

### Parallel: Gemini Golden v6 (extraction speed + bulk + sub-categorization)

Per `docs/plans/gemini-golden-v6-design-2026-04-16.md`:
1. Write `services/worker/scripts/enrich-gemini-golden-v6.ts` — adds subType + description to existing v4 dataset
2. Hand-curate 500 NEW subType-diverse examples (all PMI certs, AWS certs, etc.)
3. Submit Vertex tuning job: source_model=`gemini-2.5-flash`, epochs=6, responseSchema=v6 locked
4. Eval against extraction goldens — preserve ≥75% Macro F1, achieve <2s p50 latency
5. Build bulk endpoint: POST /api/v1/extract/bulk + Cloud Tasks queue + Vertex batch-prediction-jobs

## Critical rules (DON'T break these)

1. **NO local model artifacts.** All training data uploads via API; all model files live on Together / HF / RunPod / Vertex. Never use local disk for >100MB model files.
2. **The Together CLI download command is BROKEN** — use SDK `fine_tuning.content()` instead.
3. **PEFT 0.15 + autocast_adapter_dtype=False is the ONLY working stack** for merging Together adapters with current torch (2.4.x).
4. **MAX_MODEL_LEN=8192 minimum** on RunPod template (4096 caused context-overflow on every extraction request).
5. **NESSIE_DOMAIN_ROUTING=false** in worker .env — domain adapters use Together-format model names that aren't served on RunPod.
6. **Production extraction stays on Gemini.** Nessie is for compliance intelligence/RAG, NOT extraction. They are different jobs with different metrics.
7. **Eval framework `confidenceReasoning` schema fix** is in commit `a6d5191b` — DO NOT regress this.
8. **Always commit + push** after meaningful work. Update Jira (SCRUM-769 NTF, SCRUM-772 GME2) and Confluence (page 11894785) per CLAUDE.md mandates.
9. **Cost guardrails:** if you spin up new Vertex endpoints for testing, undeploy them within the same session (each idle endpoint bills hourly).
10. **Single-domain mastery, not generalist sprawl** — v26's failure was cramming 12+ domains into one LoRA.

## Files / IDs you'll need

- Together v27 job: `ft-56fd901e-669e`
- HF target: `carsonarkova/nessie-v27-fcra`
- RunPod template: `3fbtz393el`
- Old v26 endpoint to delete after v27 ships: `qgp44409nbsgi0`
- Vertex prod endpoint (Gemini Golden v5-reasoning, KEEP): `8811908947217743872`
- Vertex fraud-v1 endpoint (KEEP): `2117308101131501568`
- GCP service account key: `~/.config/gcloud/arkova-cli-key.json`
- Atlassian cloudId: `d6c466a9-c4e8-4385-a1b8-fb4edca3c760`

## Recent commits (context)
- `b8763f1a` — v26 deployed end-to-end + GCP/Vertex cleanup + production wired
- `3ad303e9` — Final scoreboard + fraud-v1 authoritative eval (this is the 7th commit of last session)
- `a6d5191b` — Eval framework root-cause fix (`confidenceReasoning` schema)

## What you should NOT do
- Do NOT re-train any v6–v25 Nessie model (generalist sprawl, abandoned)
- Do NOT touch local disk with model files
- Do NOT trust the `together fine-tuning download` CLI (use SDK content() method)
- Do NOT re-deploy duplicate Vertex endpoints
- Do NOT report eval numbers without verifying which model and dataset they correspond to

Go.

---
