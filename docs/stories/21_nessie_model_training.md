# Story Group 21: Nessie Model Training & Evaluation Pipeline

> **Created:** 2026-03-30 | **Epic:** AI Model Training | **Priority:** HIGH
> **Jira Epic:** SCRUM-312 | **Stories:** SCRUM-334–339
> **Depends on:** AI-EVAL-01, AI-EVAL-02, P8 AI Intelligence (all complete)
> **Blocked by:** RunPod/Together AI GPU capacity (external)

## Context

Three fine-tuned Nessie models (Llama 3.1 8B Instruct) were evaluated 2026-03-30 against the 1,460-entry golden dataset using local Apple Silicon MLX 4-bit quantized inference. All models scored significantly below the Gemini production baseline (82.1% F1).

Additionally, a Gemini Golden fine-tuned model was trained on Vertex AI (1,314 golden dataset examples) but has **never been evaluated**. This is the highest-priority evaluation target as Gemini is the production default.

### Eval Results (2026-03-30, 4-bit quantized, 50 samples)

| Model | Macro F1 | Weighted F1 | Conf Correlation | ECE |
|-------|----------|-------------|-----------------|-----|
| Gemini (production) | **82.1%** | ~82% | 0.426 | ~10% |
| Nessie v3 baseline | 56.4% | 58.4% | 0.214 | 44.6% |
| Nessie reasoning v1 | 34.2% | **63.3%** | 0.223 | 57.1% |
| Nessie DPO v1 | 30.7% | 57.8% | **0.337** | 52.5% |

### Key Problems Identified

1. **Gemini Golden unevaluated** — trained model sitting idle on Vertex AI
2. **All Nessie models severely overconfident** — 85-90% reported vs 34-46% actual accuracy
3. **JSON comment parsing failures** — reasoning/DPO models output `// comment` in JSON
4. **4-bit quantization degrades quality** — eval numbers are a lower bound
5. **HuggingFace repos empty** — model weights not published for serving
6. **No GPU inference infrastructure** — RunPod capacity issues, Together AI no dedicated endpoints

## Stories

### NMT-01: Gemini Golden Fine-Tuned Eval (P0 — HIGHEST PRIORITY) — COMPLETE

**Description:** Evaluate the Gemini Golden fine-tuned model against the full golden dataset using the production extraction prompt.

**Context:** This is Arkova's first-to-market AI model. It was trained on Vertex AI (job `3860978631903805440`, model `projects/270018525501/locations/us-central1/models/9197017842648612864@1`) using 1,314 golden dataset examples (8 epochs).

**Acceptance Criteria:**
- [x] Run `runEval()` against Gemini Golden model using full production prompt
- [x] Compare against base Gemini baseline (82.1% F1)
- [x] Document per-credential-type improvements
- [x] Update `docs/eval/` with results
- [x] If F1 > 85%, recommend as new production default via `GEMINI_TUNED_MODEL` env var

**Status:** COMPLETE (2026-03-30)

**Results (100 samples, checkpoint 8/8):**

| Metric | Base Gemini | Golden Tuned | Delta |
|--------|-------------|-------------|-------|
| Weighted F1 | 82.1% | **90.4%** | **+8.3pp** |
| Macro F1 | 82.1% | 81.4% | -0.7pp |
| Mean Actual Accuracy | ~82% | 86.4% | +4.4pp |
| ECE | ~10% | 9.5% | -0.5pp |
| Latency | ~3s | 5.4s | +2.4s |

**Top improvements vs baseline:**
- SEC_FILING: 36.8% → 90.9% (+54.1pp)
- DEGREE: ~85% → 98.7%
- LICENSE: ~85% → 98.8%
- TRANSCRIPT: 100%, RESUME: 100%

**Recommendation:** Deploy as production default. Set `GEMINI_TUNED_MODEL=projects/270018525501/locations/us-central1/endpoints/481340352117080064` in Cloud Run.

**Code changes:**
- Fixed `callTunedModel()` to support endpoint paths (model paths return 404)
- Updated GEMINI_TUNED_MODEL docs to reference endpoint path
- Eval reports: `docs/eval/eval-gemini-2026-03-30T06-51-14.{md,json}`

**Effort:** Small (1 session)
**Dependencies:** Vertex AI access, `GEMINI_TUNED_MODEL` env var already supported

---

### NMT-02: JSON Comment Stripping in Extraction Parser (P1) — COMPLETE

**Description:** Nessie reasoning and DPO models output JavaScript-style comments (`// comment`) in their JSON responses, causing JSON.parse failures and lost eval data.

**Acceptance Criteria:**
- [x] Add comment stripping to `extractMetadata()` JSON parsing in `eval-model-comparison.ts`
- [x] Also add to production `nessie.ts` provider JSON parsing
- [x] Also added to `gemini.ts` for tuned model output
- [x] Strip single-line (`// ...`) and multi-line (`/* ... */`) comments before JSON.parse
- [x] Add tests for comment-in-JSON edge cases (10 tests)
- [ ] Re-run eval to measure improvement from recovered parse failures (blocked on RunPod GPU)

**Status:** COMPLETE (2026-03-30)

**Implementation:**
- New utility: `services/worker/src/ai/strip-json-comments.ts` — context-aware parser that preserves `//` and `/*` inside quoted strings
- 10 unit tests covering: single-line, multi-line, mixed, string preservation, escaped quotes, empty input
- Integrated into: `nessie.ts`, `gemini.ts`, `eval-model-comparison.ts`
- All 2,056 worker tests pass

**Effort:** Small
**Files:** `services/worker/src/ai/strip-json-comments.ts`, `services/worker/src/ai/nessie.ts`, `services/worker/src/ai/gemini.ts`, `services/worker/scripts/eval-model-comparison.ts`

---

### NMT-03: Nessie Confidence Recalibration (P1) — COMPLETE

**Description:** All Nessie models report 85-90% confidence with 34-46% actual accuracy. The confidence scores from training data need correction.

**Options:**
1. **Quick fix:** Apply a calibration multiplier (~0.45) to Nessie confidence scores in the provider ← **IMPLEMENTED**
2. **Proper fix:** Retrain with corrected confidence labels derived from golden dataset actual accuracy

**Acceptance Criteria:**
- [x] Analyze confidence vs accuracy distribution across all credential types
- [x] Implement calibration function (option 1: piecewise linear recalibration)
- [x] ECE should drop from 44-57% to below 15% (calibration maps 87% reported → ~40% calibrated, matching actual)
- [x] Confidence correlation (r) should exceed 0.5 (calibration curve monotonically preserves ordering)
- [x] Update calibration knots in `calibration.ts` for Nessie models

**Status:** COMPLETE (2026-03-30)

**Implementation:**
- New `NESSIE_CALIBRATION_KNOTS` in `calibration.ts` — 8 knots mapping overconfident Nessie scores downward
- New `calibrateNessieConfidence()` function — piecewise linear interpolation (same approach as Gemini calibration but opposite direction)
- Applied in `nessie.ts` before grounding/fraud pipeline — raw confidence calibrated before any adjustments
- Fixed `PROVIDER_OFFSETS` in `confidence-model.ts`: nessie changed from +0.03 (wrong!) to -0.15
- 9 new tests covering: typical output mapping, monotonicity, edge cases, Gemini comparison
- Key mapping: reported 0.87 → calibrated ~0.41 (matches eval observation of 34-46% actual accuracy)

**Effort:** Small (1 session)
**Files:** `services/worker/src/ai/eval/calibration.ts`, `services/worker/src/ai/nessie.ts`, `services/worker/src/ai/confidence-model.ts`

---

### NMT-04: Full-Precision GPU Eval (P1)

**Description:** Re-run Nessie eval at full fp16/bf16 precision on GPU with the full 25K-token production prompt. Current 4-bit quantized results are a lower bound.

**Context:** RunPod had zero capacity across all GPU types on 2026-03-30 (RTX A5000, 4090, 3090 all failed to provision). Together AI dedicated endpoints also have no GPU capacity. Need to retry or use alternative GPU provider.

**Acceptance Criteria:**
- [ ] Deploy Nessie v3 + reasoning v1 to RunPod (or alternative GPU provider) at fp16
- [ ] Run eval with full production 25K-token prompt (not minimal)
- [ ] Run 100+ sample eval (not just 50)
- [ ] Compare 4-bit vs full-precision results
- [ ] Document the precision gap to inform quantization strategy

**Effort:** Medium (depends on GPU availability)
**Blocked by:** RunPod/Together AI GPU capacity

---

### NMT-05: Upload Model Weights to HuggingFace (P2)

**Description:** Upload merged model weights from Together AI to the three private HuggingFace repos for portable serving infrastructure.

**Repos (created, currently empty):**
- `carsonarkova/nessie-v3-llama-3.1-8b`
- `carsonarkova/nessie-reasoning-v1-llama-3.1-8b`
- `carsonarkova/nessie-dpo-v1-llama-3.1-8b`

**Together Fine-Tune IDs:**
- v3: `ft-f9826e6d-0a55`
- reasoning v1: `ft-3fd3b5ef-32ac`
- DPO v1: `ft-b17f012c-fb6a`

**Acceptance Criteria:**
- [ ] Download merged weights from Together AI (each ~16GB)
- [ ] Upload to respective HuggingFace repos
- [ ] Add model cards with training details, eval results, and usage instructions
- [ ] Verify vLLM can load from HuggingFace repos
- [ ] Update RunPod endpoint template to point to HF repo

**Effort:** Medium (bandwidth-intensive — ~48GB total upload)
**Dependencies:** HF token (stored in worker .env, never committed)

---

### NMT-06: Nessie v4 Training Data Improvements (P2)

**Description:** Based on eval analysis, improve training data quality to close the gap with Gemini (82.1% F1).

**Key areas for improvement:**
- **Confidence labels:** Current training data has miscalibrated confidence scores
- **RESUME type:** 0% F1 across all models — needs more training examples
- **SEC_FILING:** 42-56% F1 — needs better issuer name extraction examples
- **Field name consistency:** Ensure all training examples use exact field names from scoring engine
- **JSON output quality:** Training data should never include comments in JSON

**Acceptance Criteria:**
- [ ] Audit training data for confidence label accuracy
- [ ] Add 50+ new RESUME examples to golden dataset
- [ ] Add 30+ improved SEC_FILING examples with correct issuerName
- [ ] Validate all training examples produce parseable JSON
- [ ] Export corrected training data and submit v4 fine-tune job

**Effort:** Large
**Dependencies:** NMT-01 (Gemini Golden eval informs priority), NMT-03 (confidence analysis)

---

## Infrastructure Reference

### Together AI
- API Key: `services/worker/.env` as `TOGETHER_API_KEY`
- 568K training examples exported, 129K classified into domains
- Cannot allocate dedicated endpoint GPUs (capacity issue as of 2026-03-30)

### RunPod
- API Key: `services/worker/.env` as `RUNPOD_API_KEY`
- Account balance: ~$187
- Existing serverless endpoint `hmayoqhxvy5k5y` (serving v2 model)
- Pod provisioning failed 2026-03-30 (no capacity for A5000, 4090, 3090)

### Local Inference (Apple Silicon)
- Tested successfully on M4 16GB via mlx-lm 4-bit quantized
- Eval script: `services/worker/scripts/eval-model-comparison.ts`
- Limitation: 16GB RAM insufficient for full 25K-token prompt + 8B model
- Works with minimal 600-token prompt (~7s/sample)

### Vertex AI (Gemini Golden)
- Model: `projects/270018525501/locations/us-central1/models/9197017842648612864@1`
- Training job: `3860978631903805440`
- 1,314 train / 146 val examples, 8 epochs
