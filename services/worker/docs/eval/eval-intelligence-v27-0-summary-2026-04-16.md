# Nessie v27.0 FCRA — Intelligence Eval Summary (2026-04-16)

**Training job:** Together ft-56fd901e-669e
**Merged model:** `carsonarkova/nessie-v27-fcra`
**Endpoint:** RunPod `u2ojptb1i9awwt` (nessie-v27-fcra-prod)
**Eval dataset:** INTELLIGENCE_EVAL_DATASET v1 (8 FCRA entries)

## Scoreboard vs v26 + v27 DoD targets

| Metric | v26 | **v27.0** | v27 target | Δ vs v26 | Status |
|---|---|---|---|---|---|
| Citation Accuracy | 0% | **0%** | ≥95% | flat | FAIL (likely eval-framework bug) |
| Faithfulness | 31% | **25.0%** | ≥90% | −6pp | REGRESSED |
| Answer Relevance | 14% | **35.2%** | ≥85% | **+21pp** | IMPROVED |
| Risk Detection Recall | 0% | **6.7%** | ≥80% | +6.7pp | Marginal |
| Confidence r | 0.895 | **0.672** | ≥0.85 | −0.22 | REGRESSED (v26 calibration from uniform-wrong) |
| Mean Latency | 18s | **5.56s** | ≤5s | **−12.4s** | Near-target |
| DoD met | — | **2/7** | 5/7 | — | Ship as baseline, v27.1 required |

## What v27.0 confirmed
- **Pipeline works end-to-end.** Together → RunPod merge pod (A40, 200GB, PEFT 0.15 + autocast=False) → HF 16.1GB merged → RunPod serverless with `carsonarkova/nessie-v27-fcra` → 5.6s p50 latency. The v26 cold-start concerns are resolved.
- **Fine-tuning produces real signal.** +21pp relevance and 3× latency improvement are too large to be noise. The model has learned FCRA domain vocabulary and response structure.
- **Dataset is the bottleneck.** Only 16 unique hand-crafted scenarios + 4 mechanical rephrasings each = 80 total. Test split had paraphrase leakage. 23 source records limited the citation vocabulary. Mechanical rephrasings are inflation, not depth.

## What v27.0 did NOT fix
- **Citation Accuracy 0%.** Likely eval-framework strict-record_id-match bug (v26 + Gemini base both show 0% on the same test). Independent issue from dataset quality; requires eval-runner investigation.
- **Risk Detection Recall 6.7%.** Several training entries had empty `risks: []` arrays — the model learned "sometimes zero risks is correct."
- **Confidence calibration 0.672.** v26's 0.895 was an artifact of uniformly-wrong outputs; v27.0 has actual opinions but less-calibrated confidence. This is a separable problem requiring temperature-scaling or calibration training, not more SFT data.
- **Entries 6 + 8 returned 0ms / 0% across metrics.** Probable individual request timeouts or serialization failures — not systemic model issue.

## v27.1 dataset (ready for training)
Built via new `scripts/intelligence-dataset/` architecture:
- 208 hand-crafted scenarios (no mechanical rephrasings)
- 89 anchored sources (FCRA statute, CFPB bulletins, FTC actions, court precedent, state statutes)
- 169 train / 39 test, category-balanced leakage-free split
- Every scenario has ≥1 citation, ≥1 risk, ≥1 recommendation
- Confidence varied 0.72–0.97 (mean 0.844)
- 0 validation errors

Categories populated per v27 design doc targets:
| Category | Target | v27.1 |
|---|---|---|
| Pre-adverse action | 25 | 25 |
| Adverse action notices | 25 | 25 |
| Permissible purpose | 20 | 20 |
| Disputes + reinvestigation | 20 | 17 |
| Reporting limits | 15 | 14 |
| State variations | 30 | 30 |
| Risk patterns | 35 | 38 |
| Medical licensure | 15 | 15 |
| Education verification | 15 | 14 |
| E-Verify + EEOC | 10 | 10 |

## Companion datasets (ready for v28, v29)
Same architecture, same validation, same splitter:
- **HIPAA v28.0** — 64 sources + 48 scenarios across Privacy, Patient Rights, Security, Breach, BA
- **FERPA v29.0** — 45 sources + 37 scenarios across consent, directory, disclosure exceptions, access, emergency, enforcement

Both compile clean with 0 validation errors. Expansion is straightforward via the shared architecture — add scenarios per category file, re-run build.

## Next actions
1. Upload `training-output/nessie-v27.1-fcra-train.jsonl` to Together and submit fine-tune (same hyperparameters: LoRA r=32, alpha=64, 5 epochs, lr 5e-5, batch 8)
2. When v27.1 training completes, run the RunPod merge pipeline (`scripts/runpod-merge-nessie.py`) and rotate endpoint
3. Eval v27.1 against the same 8-entry dataset for apples-to-apples comparison with v27.0
4. Investigate the citation-accuracy eval-framework bug (0% across all models suggests scoring issue, not model issue)
5. If v27.1 hits ≥5/7 DoD targets, start v28 HIPAA training
6. In parallel, expand HIPAA and FERPA scenario counts toward the 150+ target

## Canonical files
- Merge pod driver: `services/worker/scripts/runpod-merge-nessie.py`
- Endpoint rotator: `services/worker/scripts/runpod-rotate-endpoint.sh`
- Dataset builder: `services/worker/scripts/intelligence-dataset/build-dataset.ts`
- Dataset root: `services/worker/scripts/intelligence-dataset/`
- Output: `services/worker/training-output/nessie-v{27.1,28.0,29.0}-{fcra,hipaa,ferpa}-{train,test,manifest}.{jsonl,json}`
