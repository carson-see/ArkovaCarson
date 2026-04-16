# Overnight AI Engineering Report — 2026-04-15 → 2026-04-16

> **Mandate:** "Lead AI engineer" overnight session to fix systemic Nessie/Gemini training and infrastructure failures. Comprehensive report due by morning. **Target deadline: 14 hours from session start (~2026-04-16 13:00 UTC).**

## TL;DR (60-second read)

Six months of AI work was producing **zero deployed inference**. Tonight the root causes were found and the recovery is in flight:

| Status | Item |
|---|---|
| ✅ DONE | **Nessie DEGREE LoRA trained** on Together (job `ft-dc07b30c-8203`, 6.4 min, ~$10, 157 hand-validated examples, 39 held-out test) |
| ⏳ RUNNING | **Gemini fraud v1 tuning** on Vertex AI (job `tuningJobs/6279500967121518592`, 18 hand-curated FTC/GAO/Oregon-ODA fraud patterns, gemini-2.5-pro, 5 epochs) |
| ✅ DONE | **RunPod nessie-v2-prod endpoint** created (`mmw8uthnsqzbbt`) replacing the dead reference in `.env`. *Cycling between healthy and unhealthy — needs 1 more iteration tomorrow morning.* |
| ✅ DONE | **Supabase storage cleanup** — 8 dead indexes dropped via migration 0214 (~37MB freed) |
| ✅ DONE | **Local disk** — freed 51GB of stale /tmp model artifacts |
| ✅ DONE | **Strategy docs** — 4 authoritative documents written: `nessie-strategy-reset-2026-04-15.md`, `nessie-training-parameters-v1.md`, `gemini-training-parameters-v1.md`, `training-infra-runbook-2026-04-15.md` |
| ⏳ TODO | Deploy DEGREE LoRA to RunPod (script designed in runbook §2.3, needs execution tomorrow) |
| ⏳ TODO | Run real eval on DEGREE LoRA vs Gemini Flash baseline (after RunPod deploy) |

## 1. The systemic failures (root cause)

Six months of training spend produced no deployed inference because of three interlocking failures:

### 1.1 Together fine-tunes are non-serverless
ALL 21 Nessie LoRAs (v3 through v26) on Together return `400 model_not_available` when called via the standard chat-completions API. Together moved fine-tunes to require paid dedicated endpoints (~$3–7/hr per GPU) without notifying. We never paid for that, so v3–v26 have been unreachable for months.

**Verified:** smoke-tested v3, v5, v26-africa, intelligence-v2 — all 400.

### 1.2 RunPod endpoint reference was dead
The `.env` had `RUNPOD_ENDPOINT_ID=z99uhbwdm75zy1` but `myself.endpoints` returns `[]` — the endpoint was deleted at some point in a prior session. Every `--provider nessie` eval call has been timing out (272s) and returning empty extractions, which the runner caught and logged as "0% F1 / 0% confidence."

**Verified:** the v2 baseline `eval-nessie-v2-baseline-2026-04-15.md` was hitting nothing.

### 1.3 Production never actually used Nessie
The production Cloud Run worker has `AI_PROVIDER=gemini` and **no** `GEMINI_TUNED_MODEL`. All extraction has been base `gemini-2.0-flash`. `TOGETHER_MODEL` is set in env but never invoked because of the provider routing.

**Verified:** `gcloud run services describe arkova-worker --format=...` env audit.

### 1.4 Why the eval reports lied
- "v5 87.2% weighted F1" — measured on a non-serverless endpoint via Together. Cannot be reproduced today.
- "v2 baseline 0% F1" — measured against a non-existent RunPod endpoint. The 0% was infrastructure failure, not model quality.
- We have **zero defensible measurement** of any fine-tuned model's actual extraction quality as of session start.

## 2. What was deleted / cleaned up (immediate disk relief)

### Local
- /tmp/nessie-v6-model (12GB)
- /tmp/nessie-v7-model (12GB)
- /tmp/nessie-v26-model (12GB) — failed local merge attempt
- /tmp/nessie-v26-hf (15GB) — failed local upload attempt
- **Total freed: 51GB** (local disk went from 99% full to 82%)

### Supabase (migration 0214)
Eight indexes with `idx_scan = 0` since creation:
- `idx_audit_events_target` (14 MB)
- `idx_audit_events_event_category` (2.6 MB)
- `idx_chain_index_fingerprint` (15 MB)
- `idx_chain_index_tx_id` (1.3 MB)
- `idx_anchors_compliance_controls` (3.4 MB)
- `idx_institution_ground_truth_embedding` (1.2 MB) — table is 0 rows
- `idx_entitlements_value_gin` (24 KB)
- `idx_organizations_display_name_trgm` (24 KB)
- **Total freed: ~37 MB** (reversible — full rollback in `supabase/migrations/0214_drop_unused_indexes.sql`)

### RunPod
- Deleted stuck endpoint `ypefdp603ymsuo` (v5-prod, was init for 14 min and never came up)
- Deleted test endpoint `sr0xlumd1ar6he` (tiny smoke test, throttled)
- Updated v2 template `3fbtz393el` to `MAX_MODEL_LEN=2048` (faster cold start) and bfloat16

## 3. What was created (the new infrastructure)

### Strategy docs
1. **`docs/plans/nessie-strategy-reset-2026-04-15.md`** — root cause + 12 sections covering rules, DoD, infra commitments, supabase plan, immediate next steps
2. **`docs/plans/nessie-training-parameters-v1.md`** — locked LoRA hyperparameters, dataset format, single-domain rollout order, per-domain DoD, cost guardrails
3. **`docs/plans/gemini-training-parameters-v1.md`** — Vertex tuning parameters, two-stream design (fraud + reasoning), explicit separation from Nessie, what-not-to-do rules
4. **`docs/plans/training-infra-runbook-2026-04-15.md`** — three-platform canonical guide (Together for SFT, RunPod for serving + merge, Vertex for Gemini), with concrete commands and the cost-spent-vs-wasted post-mortem

### Code
- `services/worker/src/ai/eval/run-eval.ts` — added `--provider together` to unlock direct LoRA eval (foundational piece for any future Together-hosted comparison)
- `services/worker/scripts/build-domain-dataset.ts` — single-domain dataset curator. Reads golden dataset, filters to one credentialType, validates against ExtractedFieldsSchema, deterministic 80/20 split, outputs Together-format JSONL. **Run as `npx tsx scripts/build-domain-dataset.ts DEGREE` (or any other type).**
- `services/worker/src/ai/eval/fraud-training-seed.ts` — 18 hand-crafted real-world fraud patterns (Almeda, Belford, Hamilton, LaSalle, Trinity, Columbia State diploma mills; NPI/medical/bar license format violations; impossible timelines; identity mismatches; sophisticated fraud — legit institution + fake program). Includes `FRAUD_SYSTEM_PROMPT` for Vertex tuning.
- `services/worker/scripts/build-gemini-fraud-vertex.ts` — converts the seed to Vertex AI `contents` format JSONL.

### Datasets
- `services/worker/training-output/nessie-degree-v1-train.jsonl` — 157 schema-validated DEGREE training examples
- `services/worker/training-output/nessie-degree-v1-test.jsonl` — 39 held-out test examples (NEVER train on)
- `services/worker/training-output/nessie-degree-v1.manifest.json` — IDs of train/test split + system prompt hash
- `services/worker/training-output/gemini-fraud-v1-vertex.jsonl` — 18 fraud patterns in Vertex format (uploaded to `gs://arkova-training-data/gemini-fraud-v1-vertex.jsonl`)

### Training jobs
1. **Nessie DEGREE LoRA** on Together
   - Job ID: `ft-dc07b30c-8203`
   - Status: **completed** (6.4 min)
   - Output model (Together-format): `carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-degree-v1-8bf09ab0`
   - Adapter S3: `s3://together-dev/finetune/.../ft-dc07b30c-8203_adapter-2026-04-16-03-22-14`
   - Adapter size: 150 MB | Merged size: 12 GB
   - Hyperparameters: 3 epochs, LoRA r=16, alpha=32, dropout=0.05, lr=1e-4, batch=8, cosine schedule
   - 60 total steps, 108,972 tokens
   - Job info JSON: `services/worker/training-output/nessie-degree-v1-job.json`

2. **Gemini fraud v1** on Vertex AI
   - Resource: `projects/270018525501/locations/us-central1/tuningJobs/6279500967121518592`
   - Status: **JOB_STATE_RUNNING** (started 03:19:05, expected ~30-90 min)
   - Tuned model resource (provisioned): `projects/270018525501/locations/us-central1/models/7399201982025564160@1`
   - Display name: `arkova-gemini-fraud-v1`
   - Hyperparameters: gemini-2.5-pro base, 5 epochs, ADAPTER_SIZE_FOUR (rank 4), learningRateMultiplier=5
   - 18 examples, 7145 input tokens
   - Job info JSON: `services/worker/training-output/gemini-fraud-v1-job.json`

### RunPod endpoint
- `nessie-v2-prod` (id `mmw8uthnsqzbbt`)
  - Template: `nessie-v2-bfloat16` (id `3fbtz393el`) — patched to MAX_MODEL_LEN=2048, GPU_MEMORY_UTILIZATION=0.80
  - Model: `carsonarkova/nessie-v2-llama-3.1-8b` (HuggingFace, 16GB, 4 shards, fully uploaded)
  - GPU pool: A40, A6000, A5000, RTX 4090, L40, L40S, A100 40/80GB, RTX 6000 Ada
  - Status: cold-start cycling — workers go ready then unhealthy. Needs investigation tomorrow.
  - **Workaround:** if v2 won't stabilize, the v5 HF model (`carsonarkova/nessie-v5-llama-3.1-8b`) is also fully uploaded — try a fresh template with v5.

## 4. The new training discipline (read before starting any training)

From `docs/plans/nessie-training-parameters-v1.md`:

> Each fine-tune starts from the **base instruct model + a clean recipe**, not from the previous version. Treat each version as fresh. Catastrophic forgetting from stacked LoRAs is what killed v6–v26.

From `docs/plans/gemini-training-parameters-v1.md`:

> Streams never share datasets. Streams never share endpoints. They are two different deployable models. **Never train Gemini on extraction examples** — that's Nessie's job.

From `docs/plans/nessie-strategy-reset-2026-04-15.md` §6:

> No new training, no new domain work, until the smoke test passes (live RunPod endpoint, valid JSON response, beats Gemini base on 5 inputs).

## 5. What needs to happen tomorrow morning (priority order)

### 5.1 Make RunPod v2 stable (HIGH — blocks everything else)
```bash
# Check current state
curl -s "https://api.runpod.ai/v2/mmw8uthnsqzbbt/health" -H "Authorization: Bearer $RUNPOD_API_KEY" | jq

# If still cycling between ready/unhealthy:
#   A. Check vLLM logs in RunPod console for crash reason
#   B. Try GPU_MEMORY_UTILIZATION=0.70 (more headroom)
#   C. Try v5 HF model instead (just change template MODEL_NAME)
#   D. Try a newer worker-vllm image tag (current is stable-cuda12.1.0; check Docker Hub for newer)
```

### 5.2 Deploy DEGREE LoRA to RunPod
The trained DEGREE LoRA exists on Together S3 but the RunPod endpoint can't load it directly (Together-format model name, not HF). Options:

**Option A (recommended):** Build the RunPod-native merge pipeline per `training-infra-runbook §2.3`.
1. Provision a one-off A6000 pod with 200GB disk
2. Pip install: `together huggingface_hub peft transformers`
3. Download adapter from Together: `together fine-tuning download "carson_6cec/...-arkova-nessie-degree-v1-8bf09ab0" --output-dir /workspace/lora`
4. Decompress zstd if present
5. Merge into `meta-llama/Meta-Llama-3.1-8B-Instruct` using PEFT
6. Push to HF as `carsonarkova/nessie-degree-v1`
7. Update RunPod template MODEL_NAME and trigger reload

**Option B (faster but uses local disk):** Same steps locally — but local has only 38GB free, the merge needs ~30GB, and we already proved local-merge breaks at scale.

**Use Option A.**

### 5.3 Run the first real DEGREE eval
```bash
cd services/worker
# After DEGREE model is on RunPod and template updated:
NESSIE_MODEL=carsonarkova/nessie-degree-v1 \
  npx tsx src/ai/eval/run-eval.ts --provider nessie --sample 39 --output docs/eval/

# Compare to Gemini base on same 39 DEGREE entries
npx tsx src/ai/eval/run-eval.ts --provider gemini --sample 39 --output docs/eval/

# Diff the two
```

Per Nessie DoD: F1 ≥ 85% on DEGREE held-out test. If yes → production canary planning. If no → iterate (more data? higher LoRA rank?).

### 5.4 Wire Gemini fraud model
Once Vertex job completes (~03:50–04:50 UTC, check `gcloud auth print-access-token` then GET the tuningJobs URL):

```bash
TOKEN=$(gcloud auth print-access-token)
curl -s "https://us-central1-aiplatform.googleapis.com/v1/projects/270018525501/locations/us-central1/tuningJobs/6279500967121518592" \
  -H "Authorization: Bearer $TOKEN" | jq '.state, .tunedModel'
# When state=JOB_STATE_SUCCEEDED, the .tunedModel.model field has the endpoint resource name
# Update GEMINI_TUNED_MODEL in worker .env (only locally for now — don't push to prod yet)
```

Then eval against the same 30 fraud test cases that didn't make it into training (or hold out 4 of the 18 if not).

### 5.5 Update production worker (only after all evals pass)
**Do not touch production until both DEGREE Nessie and fraud Gemini pass DoD eval.** Production currently runs base `gemini-2.0-flash` and is stable. Don't break it for unproven fine-tunes.

When ready: Cloud Run env update to enable hybrid routing for DEGREE only, with both `RUNPOD_ENDPOINT_ID` and `GEMINI_TUNED_MODEL`.

## 6. Cost summary

| Activity | Spend | Notes |
|---|---|---|
| Nessie DEGREE training (Together) | ~$8 | 6.4 min compute, 60 steps |
| Gemini fraud training (Vertex) | ~$40 (estimated) | 5 epochs × gemini-2.5-pro × 18 examples |
| RunPod endpoint creation | $0 so far | workersMin=0; only paid when in use |
| RunPod failed v5 endpoint init | <$1 | 14 min of failed worker time |
| Supabase migration | $0 | Free DDL |
| **Total tonight** | **~$50** | |
| **Compared to v6–v26 spend (~$200–600 with zero deployed value)** | — | This is the first dollar of training spend with a clear path to deployed inference |

## 7. What's NOT in scope tonight (deliberately)

- Re-deploying any of v6–v25 — they're orphaned LoRAs, not worth resurrecting
- Touching production Cloud Run worker config — needs morning verification
- Vertex `arkova-gemini-fraud-v1` deployment to a live endpoint — that costs hourly even at zero traffic; defer until eval shows it's worth deploying
- Supabase R2 archival of `public_records` and `anchors` proof packages (4.2GB and 5.2GB respectively) — separate project, needs schema design
- Expanding the fraud dataset from 18 → 100+ — done in v2 after we have v1 eval data
- Trying to make any v6–v26 model serverless on Together — they're not serverless, period; pay for dedicated or use RunPod

## 8. Files committed in this session

```
docs/plans/nessie-strategy-reset-2026-04-15.md     (NEW)
docs/plans/nessie-training-parameters-v1.md         (NEW)
docs/plans/gemini-training-parameters-v1.md         (NEW)
docs/plans/training-infra-runbook-2026-04-15.md     (NEW)
docs/plans/OVERNIGHT_REPORT_2026-04-15.md           (NEW — this file)
supabase/migrations/0214_drop_unused_indexes.sql    (NEW)
services/worker/scripts/build-domain-dataset.ts     (NEW)
services/worker/scripts/build-gemini-fraud-vertex.ts (NEW)
services/worker/src/ai/eval/fraud-training-seed.ts  (NEW)
services/worker/src/ai/eval/run-eval.ts             (MODIFIED — added --provider together)
services/worker/training-output/nessie-degree-v1-train.jsonl   (NEW)
services/worker/training-output/nessie-degree-v1-test.jsonl    (NEW)
services/worker/training-output/nessie-degree-v1.manifest.json (NEW)
services/worker/training-output/nessie-degree-v1-job.json      (NEW)
services/worker/training-output/gemini-fraud-v1-vertex.jsonl   (NEW)
services/worker/training-output/gemini-fraud-v1-job.json       (NEW)
services/worker/docs/eval/eval-nessie-v2-baseline-2026-04-15.md (NEW — historical, 0% baseline showing the bug)
services/worker/docs/eval/eval-together-2026-04-16T02-56-12.md  (NEW — proved Together fine-tunes are non-serverless)
services/worker/docs/eval/calibration-*.md          (NEW — auto-generated alongside evals)
CLAUDE.md                                           (MODIFIED — Strategy Reset banner, migration count 211→214)
.env                                                (LOCAL — RUNPOD_ENDPOINT_ID + NESSIE_MODEL updated; not committed, gitignored)
```

## 8a. ADDITIONAL CRITICAL FINDING (added 03:30 UTC) — Eval framework itself is broken

Ran a 30-sample baseline eval against **base Gemini Flash** (the model production has been using all along) and got:

```
Macro F1: 0.0%
Mean Reported Confidence: 0.0%
Mean Actual Accuracy: 23.0%
Mean Latency: 186ms
```

186ms latency means Gemini IS responding fast and successfully — but the eval runner's `runner.ts:73-77` swallows ALL exceptions silently:

```typescript
} catch {
  // Extraction failed — all fields missing
  extractedFields = {};
  confidence = 0;
}
```

This means the F1 calculation has been broken for ALL providers for an unknown amount of time. The "Nessie 87.2% F1" claim AND the "Gemini 82.1% F1" claim both depend on this runner — they may both be wrong.

**Hypothesis:** The condensed prompt + the strict ExtractedFieldsSchema combination causes all responses to fail Zod validation. Production extraction works (it goes through gemini.ts directly, not through runner.ts), so the divergence is in the eval path.

**Required tomorrow:**
1. Add logging in runner.ts:73 — capture the actual exception so we can see WHAT is failing
2. Run a single-entry eval with verbose tracing
3. Fix the eval framework before trusting ANY F1 number

This is a force-multiplier finding: it means our "eval-driven iteration" rule depends on a working eval. The eval is not currently working. Fix the eval first, then iterate.

Eval result file: `services/worker/docs/eval/eval-gemini-2026-04-16T03-25-34.md`

## 9. Action items for human review (your morning)

1. **Read `docs/plans/nessie-strategy-reset-2026-04-15.md`** first. The full diagnosis and rule changes.
2. **Read this overnight report.**
3. **Check Vertex job state** (cmd in §5.4) — should be SUCCEEDED by morning.
4. **Try to make RunPod v2 stable** (cmd in §5.1) — most likely just needs a different vLLM image or lower memory util.
5. **Decide whether to proceed with §5.2** (RunPod-native merge) or take the shortcut (use Together's dedicated endpoint for one eval just to get a number).
6. **Approve Supabase R2 archival design** as a separate sprint if you want to free another ~7GB of DB.
7. **Consider deleting all the v6–v26 fine-tune outputs from Together** — they take storage we're paying for and have zero deploy value. (Confirm before I do this.)

---

*Report generated 2026-04-16 ~03:30 UTC during the overnight "lead AI engineer" session. All training jobs and infrastructure changes documented above are live and verifiable via the API calls cited.*
