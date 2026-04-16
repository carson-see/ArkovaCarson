# Gemini Golden v7 — Weak-Type Expansion + Calibration Recovery + Schema Enforcement

> **Status:** Authoritative design for the next Gemini extraction-tuning generation.
> **Date:** 2026-04-16 (post v6 eval)
> **Parent:** [v6 design](./gemini-golden-v6-design-2026-04-16.md) | [v6 eval](../../services/worker/docs/eval/eval-gemini-golden-v6-2026-04-16.md)
> **Predecessor:** v6 (`arkova-gemini-golden-v6`, endpoint `740332515062972416`) — 77.1% Macro F1, 83.6% Weighted, 3.24s p50, 88% subType, 100% description. **READY for production cutover.**

## 1. What v6 proved + what it didn't fix

### Kept (don't touch in v7)
1. **gemini-2.5-flash is the right base** — 5× faster than 2.5-pro, minimal quality loss, 4× cheaper per request.
2. **subType + description work** — model learned both structured fields; 88% / 100% emission.
3. **6 epochs + ADAPTER_SIZE_FOUR + LR 1.0** — proven hyperparameter stack.
4. **Dropping reasoning chain** — 95% token reduction (35K → 1.7K tokens per request), 3.5× latency win.
5. **v6 training system prompt** — tuned model requires the training prompt at inference (new `extraction-v6.ts`).

### Unfixed (v7's job)
| Problem | v6 evidence | Root cause | v7 approach |
|---|---|---|---|
| Sparse-type F1 collapse | IDENTITY 55.6%, REGULATION 57.8%, TRANSCRIPT 63.9%, RESUME 60%, BADGE 68%, MILITARY 50%, CHARITY 50% | 2-4 golden entries per type — statistically unreliable | Hand-curate 20+ entries per weak type (~140 new) |
| Confidence regression | v6 r=0.117 (vs v5-reasoning 0.396), model 30pp underconfident | Flash base produces lower confidence than pro; v6 never calibrated | Retrain isotonic calibration layer on v7 eval data (no base retrain) |
| JSON parse under drift | 100% in eval, no guard against future drift | No structural enforcement | Add Vertex `responseSchema` to tuned-model calls |
| Code not yet in prod | v6 code changes are local-only | Needs commit + Cloud Run deploy | Ship v6 code path → v7 inherits it |

### v7 explicitly NOT doing (separate sprints)
- Multi-modal image input (v8-v9 territory; expensive)
- Multilingual (v9; separate data pipeline)
- Bulk pathway (`POST /api/v1/extract/bulk`) — separate infra sprint
- Domain-specific extraction adapters (v10+)

## 2. v7 Definition of Done

| Metric | v6 actual | v7 target | Mandatory? |
|---|---|---|---|
| Macro F1 | 77.1% | **≥80%** (+3pp) | ✅ |
| Weighted F1 | 83.6% | **≥85%** | ✅ |
| **Per-type F1 ≥75% for ALL types** | 4 types miss | **0 types miss** | ✅ NEW |
| p50 latency | 3.24s | **≤3.5s** (hold v6) | ✅ |
| p95 latency | 4.93s | **≤5.5s** (hold v6) | ✅ |
| subType non-"other" | 88% | ≥90% | ✅ |
| description emission | 100% | 100% | ✅ |
| JSON parse success | 100% | 100% | ✅ |
| **Confidence Pearson r** | 0.117 | **≥0.5** | ✅ NEW |
| Confidence ECE | 29.2% | ≤10% | stretch |

"Per-type F1 ≥75% for ALL types" is the single most important new bar — it forces weak-type expansion to actually land.

## 3. Dataset expansion plan (Phase 1)

Current weak types + target counts:

| Type | Current golden | v7 target | Focus areas |
|---|---:|---:|---|
| IDENTITY | 3 | 25 | Passport, state-issued ID, driver's license, military ID, international variants |
| REGULATION | 3 | 25 | Federal Register notices, state agency orders, CFR excerpts, municipal ordinances, EU/UK equivalents |
| TRANSCRIPT | 2 | 25 | Official undergrad/grad transcripts across 10+ universities, 3+ countries |
| RESUME | 2 | 25 | CVs from academic/medical/legal/engineering, multi-page, multi-language (English variants) |
| BADGE | 3 | 25 | AWS/GCP/Azure skill badges, LinkedIn Learning, Credly, Acclaim, Open Badges |
| MILITARY | 3 | 25 | DD-214 variants, discharge forms, service records, foreign military |
| CHARITY | 4 | 25 | 501(c)(3)/(4)/(6), international nonprofit (UK CIO, Canadian RCN), state filings |
| **Subtotal** | 20 | **175** | **+155 new entries** |

**Golden file placement:** new `services/worker/src/ai/eval/golden-dataset-phase18-weak-types.ts`. Pattern mirrors existing phase files (`phase17`).

**Quality bar for new entries:**
- Each entry MUST have ≥5 non-null ground-truth fields (not just credentialType + issuerName).
- Each entry MUST have a concrete `subType` in ground truth.
- Near-duplicate detection: no two entries within a type should share >80% token overlap.
- Mix of clean + noisy (OCR-corrupted) + edge-case (expired, redacted, multi-issuer) in each type.

**Curation effort estimate:** 20 entries × 7 types × 5–10 min each = ~12–20 hours hand-curation. Can be split across 2-3 sessions.

**Re-enrichment:** existing `services/worker/scripts/enrich-gemini-golden-v6.ts` already handles all phases via `FULL_GOLDEN_DATASET`. Rename to `enrich-gemini-golden-v7.ts` and update:
- Output path → `gs://arkova-training-data/gemini-golden-v7-vertex.jsonl`
- DoD checks in stats report → ≥90% subType emission at training time (up from 80%)
- No other logic changes needed

## 4. Training config (Phase 2)

**Unchanged from v6:**
```json
{
  "baseModel": "gemini-2.5-flash",
  "supervisedTuningSpec": {
    "trainingDatasetUri":   "gs://arkova-training-data/gemini-golden-v7-vertex.jsonl",
    "validationDatasetUri": "gs://arkova-training-data/gemini-golden-v7-vertex-validation.jsonl",
    "hyperParameters": {
      "epochCount": "6",
      "adapterSize": "ADAPTER_SIZE_FOUR",
      "learningRateMultiplier": 1.0
    }
  },
  "tunedModelDisplayName": "arkova-gemini-golden-v7"
}
```

Changing tuning hyperparameters breaks the ceteris paribus comparison with v6. Only the dataset should change.

**Expected:**
- Cost: ~$30–35 (slightly larger dataset)
- Duration: 40–60 min
- Endpoint: auto-assigned on success (no quota concerns after cleanup)

## 5. Eval (Phase 3)

Identical to v6 methodology:
```bash
export GEMINI_TUNED_MODEL=projects/270018525501/locations/us-central1/endpoints/<v7-endpoint>
export GEMINI_V6_PROMPT=true     # v7 uses the same inference prompt as v6
./scripts/eval-and-analyze-v6.sh <v7-endpoint>
```

**Critical:** keep the 50-sample golden eval identical so v5→v6→v7 comparisons are valid. New weak-type entries go into the training set, not the eval set.

## 6. Calibration retrain (Phase 4) — post-training, no GPU needed

v6 confidence correlation = 0.117 (systematically underconfident). Path:

1. Run full eval on v7 validation set (248 held-out entries) → raw (confidence, actual_accuracy) pairs.
2. Fit isotonic regression in `services/worker/src/ai/eval/calibration.ts`:
   ```typescript
   export function calibrateConfidence(raw: number): number {
     // Piecewise isotonic fit from v7 val data
     return v7_isotonic_fn(raw);
   }
   ```
3. Re-run eval, verify calibrated Pearson r ≥ 0.5.

Cost: zero (local compute). Time: ~15 min. No base-model retrain needed.

## 7. responseSchema constrained decoding (Phase 5)

Vertex Gemini supports JSON-schema-constrained generation. Add to `callTunedModel` in `gemini.ts` when `GEMINI_V6_PROMPT=true`:

```typescript
const V6_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: ['credentialType', 'confidence'],
  properties: {
    credentialType: { type: 'STRING', enum: CREDENTIAL_TYPES },  // 23 canonical
    subType: { type: 'STRING' },
    description: { type: 'STRING', maxLength: 500 },
    confidence: { type: 'NUMBER', minimum: 0, maximum: 1 },
    issuerName: { type: 'STRING' },
    issuedDate: { type: 'STRING' },
    expiryDate: { type: 'STRING' },
    // ...all optional fields from ExtractedFieldsSchema
    fraudSignals: { type: 'ARRAY', items: { type: 'STRING' } },
  },
};

// In callTunedModel:
generationConfig: {
  temperature: 0.1,
  responseMimeType: 'application/json',
  responseSchema: V6_RESPONSE_SCHEMA,  // NEW
}
```

Effect: Vertex enforces the schema server-side. Model CANNOT emit invalid JSON even if it wanted to. Belt-and-suspenders insurance against future distribution shift. Unlocks Nessie-style output guarantees.

**Testing:** add this BEFORE v7 eval so v7 gets the benefit + the eval measures whether it broke anything (regressions from over-constraining). If v6 endpoint starts failing with responseSchema, fall back to responseMimeType-only (the current v6 path).

## 8. Production cutover order

**Prerequisite (blocks everything below): ship v6 code to Cloud Run.**
1. Commit the 10 v6 files (listed in SCRUM-772 comment 11026) to main.
2. Cloud Run auto-deploys new revision.
3. Flip env vars: `GEMINI_TUNED_MODEL=<v6-endpoint>`, `GEMINI_V6_PROMPT=true`.
4. Prod smoke → confirm `description` + `subType` emit in prod.

**Then v7 cutover (additive):**
5. Complete v7 dataset curation.
6. Train v7.
7. Eval v7 — all DoD gates must pass.
8. Flip env var: `GEMINI_TUNED_MODEL=<v7-endpoint>`. (`GEMINI_V6_PROMPT=true` stays; prompt unchanged.)
9. Prod smoke.
10. Rollback to v6 endpoint if any regression.

## 9. Cost budget

| Phase | Cost | Time |
|---|---|---|
| Dataset curation (hand) | $0 | 12–20 hours |
| Vertex tune v7 | ~$35 | 40–60 min |
| Eval + calibration retrain | ~$2 | 30 min |
| Prod cutover | $0 | 10 min |
| **Total** | **~$40** | **~1 day** |

## 10. What makes v7 different from "just retrain"

Three deliberate bets:
1. **Dataset quality beats parameter tweaking.** v6 proved this (same hyperparams as v5-reasoning trained on a richer dataset → dramatically better). v7 doubles down.
2. **Calibration is a separate problem from extraction.** Don't mix them. Fix with an isotonic layer.
3. **Schema enforcement shifts the risk profile.** Training teaches the model the shape; `responseSchema` guarantees the shape. Both in place = robust to model drift.

If any of these bets fails at eval time, we know exactly which one to iterate on — they're orthogonal.

## 11. Risks + mitigations

| Risk | Mitigation |
|---|---|
| New golden entries bias the model (e.g., always say "bachelor" because sampling was skewed) | Category-balanced sampling in enrichment; stats report flags any >15% over-representation |
| responseSchema breaks tuned model (schema too strict, model can't satisfy) | Eval v7 with AND without responseSchema; ship whichever works |
| Calibration layer overfits v7 val → poorly generalizes to prod traffic | Hold out 20% of val set for calibration test (not fit); verify Pearson r holds |
| Hand-curation introduces subtle label errors | 10% cross-review pass; run v6 on new entries + diff flags mismatches for human review |
| v7 doesn't beat v6 on Macro F1 | Ship v7 anyway if it fixes the weak-type cluster (per-type ≥75%) — that's the bigger story |

## 12. Living document

Update after v7 ships with:
- Actual eval numbers
- Which weak types crossed 75% and which didn't
- Whether calibration layer held in prod
- responseSchema behavior under real traffic
- Time-to-curate actuals
