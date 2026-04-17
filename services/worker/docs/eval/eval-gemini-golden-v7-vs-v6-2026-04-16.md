# Gemini Golden v7 — Stratified Eval vs v6 Baseline (FAIL)

**Date:** 2026-04-16
**v7 endpoint (evaluated then undeployed):** `projects/270018525501/locations/us-central1/endpoints/1315385892482842624` (tuning job `tuningJobs/5456125087591694336`, job succeeded 19:41:05 UTC, 47m 39s)
**v6 endpoint (prior baseline):** `projects/270018525501/locations/us-central1/endpoints/740332515062972416` (undeployed 2026-04-16 post-eval, per Vertex hygiene mandate — v6 never hit prod)
**Eval config:** `--stratified 10`, 249 entries, `GEMINI_V6_PROMPT=true` (v7 shares v6's inference prompt), concurrency 1
**Raw JSON:** `eval-gemini-2026-04-16T20-03-56.json`
**Calibration report:** `calibration-gemini-2026-04-16T20-03-56.md`

## Verdict: **DO NOT CUT OVER. Hold v5-reasoning in prod.**

v7 fails **11 of 16** DoD gates. Two specific regressions on core business types (FINANCIAL -21pp, BUSINESS_ENTITY -19pp) disqualify it regardless of the average-case improvement. v6 never reached prod anyway, so the effective comparison is v5-reasoning vs v7 — and we are keeping v5-reasoning.

## DoD gate table

| Metric | v7 DoD | v7 actual | v6 baseline | Δ vs v6 | Pass |
|---|---|---|---|---:|:---:|
| Macro F1 | ≥82% | 80.5% | 79.3% | +1.2pp | ❌ |
| Weighted F1 | ≥85% | 81.4% | 81.3% | +0.1pp | ❌ |
| All 23 canonical types ≥75% F1 | 23/23 | **16/23** | 19/23 | **−3 types** | ❌ (regressed) |
| fraudSignals F1 | ≥50% | 7.4% | 0% | +7.4pp | ❌ |
| RESUME F1 (primary target type) | ≥75% | 53.3% | 53.1% | +0.2pp | ❌ didn't move |
| FINANCIAL F1 | ≥80% | **49.4%** | 70.6% | **−21.2pp** | ❌ regressed |
| LEGAL F1 | ≥80% | 67.8% | 73.1% | −5.3pp | ❌ regressed |
| MEDICAL F1 | ≥80% | 73.5% | 73.6% | −0.1pp | ❌ |
| CHARITY F1 | ≥80% | 77.2% | 74.6% | +2.6pp | ❌ |
| BUSINESS_ENTITY F1 | hold v6 (≥75%) | **62.9%** | 81.7% | **−18.8pp** | ❌ boolean schema bug |
| ACCREDITATION F1 (data-hygiene fix) | n/a — relabel | 64.2% | 42.9% | +21.3pp | ✅ partial |
| Mean latency | ≤v6 | 4,391ms | 3,730ms | +18% | ❌ |
| p50 latency | ≤3.5s | 3,772ms | 3,240ms | +16% | ❌ |
| p95 latency | ≤5.5s | **8,344ms** | 4,930ms | **+69%** | ❌ |
| p99 latency | — | 14,113ms | — | — | — |
| JSON parse success | 100% | 99.2% (247/249) | 100% | — | ❌ |
| subType non-"other" emission | ≥90% | **73.1%** | 88% | **−14.9pp** | ❌ regressed |
| description emission | 100% | 99.2% | 100% | −0.8pp | ❌ |
| Mean tokens/req | hold v6 | 1,991 | 1,741 | +14% | ❌ more expensive |
| Raw confidence Pearson r | retired (→ GME7) | 0.278 | 0.260 | +0.018 | n/a |
| Calibrated Pearson r | — | 0.339 | 0.264 | +0.075 | marginal improvement |
| Calibrated mean gap | ≤5pp | 2.9pp | 1.4pp | slight widening | ≈ acceptable |
| Calibrated ECE | ≤10% | 17.6% raw | 24.2% raw | −6.6pp | ≈ improved, still high |

## Per-canonical-type F1 (n=10/type)

| Type | v6 | v7 | Δ | Verdict |
|---|---:|---:|---:|---|
| ACCREDITATION | 42.9% | 64.2% | +21.3pp | ✅ big win (relabel hypothesis confirmed) |
| ATTESTATION | 82.2% | 82.1% | −0.1 | flat |
| BADGE | 89.1% | 94.4% | +5.3 | ✅ |
| BUSINESS_ENTITY | 81.7% | **62.9%** | **−18.8** | ❌ BROKEN (boolean schema) |
| CERTIFICATE | 94.5% | 94.5% | 0 | flat |
| CHARITY | 74.6% | 77.2% | +2.6 | slight gain |
| CLE | 93.7% | 87.0% | −6.7 | ❌ regressed |
| DEGREE | 85.7% | 82.0% | −3.7 | regressed |
| FINANCIAL | 70.6% | **49.4%** | **−21.2** | ❌ BROKEN |
| IDENTITY | 81.8% | 79.1% | −2.7 | slight regression |
| INSURANCE | 92.8% | 87.4% | −5.4 | regressed |
| LEGAL | 73.1% | 67.8% | −5.3 | ❌ regressed |
| LICENSE | 99.3% | 90.0% | −9.3 | regressed |
| MEDICAL | 73.6% | 73.5% | −0.1 | flat |
| MILITARY | 77.6% | 77.6% | 0 | flat |
| OTHER | 62.3% | 69.9% | +7.6 | ✅ |
| PATENT | 78.6% | 80.5% | +1.9 | flat |
| PROFESSIONAL | 86.9% | 85.9% | −1.0 | flat |
| PUBLICATION | 84.0% | 92.0% | +8.0 | ✅ |
| REGULATION | 86.5% | 92.6% | +6.1 | ✅ |
| RESUME | 53.1% | 53.3% | +0.2 | ❌ primary target didn't move |
| SEC_FILING | 97.2% | 97.5% | +0.3 | flat |
| TRANSCRIPT | 90.6% | 90.4% | −0.2 | flat |

**Score:** 5 real improvements (ACCREDITATION, BADGE, OTHER, PUBLICATION, REGULATION). 9 regressions including 4 major (FINANCIAL, BUSINESS_ENTITY, LICENSE, LEGAL). 9 flat.

Types below the 75% floor (was 4, now 7):
- **Below in both v6 and v7:** RESUME, MEDICAL, FINANCIAL (v6 borderline), LEGAL (v6 borderline — now clearly below)
- **New in v7:** BUSINESS_ENTITY (fell from 81.7), ACCREDITATION (came from 42.9, improved but still 64), OTHER (was 62, still 70)

## Per-field F1 (overall, not per-type)

| Field | P | R | F1 | Notes |
|---|---:|---:|---:|---|
| credentialType | 79.8% | 79.1% | 79.4% | type disambiguation regressed |
| issuerName | 84.8% | 90.9% | 87.8% | steady |
| issuedDate | 92.3% | 97.7% | 94.9% | steady |
| expiryDate | 84.2% | 92.3% | 88.1% | steady |
| fieldOfStudy | 66.7% | 79.4% | 72.5% | weak |
| accreditingBody | 64.1% | 78.1% | 70.4% | weak |
| jurisdiction | 61.7% | 71.5% | 66.3% | weak |
| **fraudSignals** | **6.3%** | **9.1%** | **7.4%** | **near-zero — the v7 fraud seed did not take** |
| licenseNumber | 45.0% | 94.7% | 61.0% | poor precision — spurious extractions |
| degreeLevel | 90.5% | 100% | 95.0% | strong |
| creditHours/Type/Activity/Provider/ApprovedBy | 90–100% | 90–100% | 90–100% | all strong (CLE-specific) |

## Root-cause analysis of v7 regressions

### 1. BUSINESS_ENTITY −18.8pp — `goodStandingStatus` schema mismatch

v7 emits `goodStandingStatus: boolean` (e.g., `true`). Schema at `services/worker/src/ai/schemas.ts:45` is `z.string().optional()`. Zod rejection → extraction throws → 3 retries all fail → empty extractedFields → scored as miss.

Measured in eval: 5+ Zod validation failures logged, all BUSINESS_ENTITY or CHARITY entries. Affects entire extraction (not just the bad field) because extraction throws on any schema failure.

**Fix for v7.1 (pick one):**
- Relax schema: `z.union([z.string(), z.boolean()]).transform(v => typeof v === 'boolean' ? (v ? 'good standing' : 'not in good standing') : v).optional()` — zero retrain cost.
- OR rewrite phase 18 training entries to stringify `goodStandingStatus` and retrain.

Schema relaxation is the faster path.

### 2. FINANCIAL −21.2pp — the 15 new golden entries hurt rather than helped

Phase 18 v7 added 15 FINANCIAL entries as part of the "push borderline types ≥80%" plan. Result: model confused. Hypothesis: the 15 new entries introduced distribution shift (different FINRA / SEC forms, different subType labels) that the model learned too aggressively, confusing existing FINANCIAL patterns.

**Fix for v7.1:**
- Drop or cross-review phase 18 FINANCIAL entries.
- Restore v6 baseline training corpus, then add CAREFULLY CURATED entries one batch at a time with cross-validation.

### 3. fraudSignals 7.4% — the 50-entry seed was never going to move the needle

`fraud-training-seed.ts` has 50 entries of diploma mills / license forgery / document tampering. v7 training absorbed this, but at 50 entries vs 2,391 total training it's <2% of the corpus — not enough signal to learn the task.

**Fix for v7.1:**
- Pull fraudSignals OUT of main golden and train a dedicated fraud stream (like `gemini-fraud-v1` already did, with 18 entries → deployed as separate endpoint `2117308101131501568`).
- Main extraction model should NOT also attempt fraud detection — split concerns. Chain the two: extraction first, then fraud-detection model on the extracted fields.

### 4. subType emission 88% → 73% — training data regression

v7's added 170 entries likely have inconsistent subType coverage. The model learned some entries don't need subType and generalized incorrectly.

**Fix for v7.1:**
- Audit phase 18 entries for subType: each MUST have a concrete subType (per v6 design doc quality bar).
- Reject any entry with missing subType from training.

### 5. Latency p95 +69% (4.93s → 8.34s)

v7's extraction is substantially slower in the tail. Likely cause: +14% more output tokens on average (1,741 → 1,991) and higher variance (the BUSINESS_ENTITY/CHARITY entries with retries blow up latency). **This is the worst single metric.**

Retries on schema failure also compound this — each Zod failure = +500ms base delay × exponential backoff + second full Vertex call. Fixing the schema regression above would also cut the p95 back to ~5s.

## Bright spots

- **ACCREDITATION: 42.9 → 64.2 (+21.3pp)** confirms the relabel-to-ATTESTATION hypothesis from the v6 stratified analysis. Further gain if we actually relabel the 19 source entries (GME2-04 / SCRUM-795).
- **PUBLICATION: 84 → 92 (+8pp)**, **REGULATION: 86 → 93 (+6pp)**, **OTHER: 62 → 70 (+8pp)** — the broader training expansion DID help these types.
- **Calibrated confidence:** mean gap 24pp → 2.9pp is a strong improvement. v6 knots (still shared between v6 and v7 via `isV6PromptActive()`) are serving v7 reasonably well; a v7-specific knot table would sharpen further (not needed now since v7 isn't shipping).
- **Raw tokens per request ≈ 2K** vs v5-reasoning's 35K (GRE-era) — v7 retains v6's 95% token reduction over v5.
- **Mean tokens ~1,991** keeps per-extraction cost <$0.001 at Standard-tier pricing.

## v7.1 plan (surgical retrain)

Cost target: <$40, <1 day. Scope:

1. **Schema fix** (code, not training): relax `goodStandingStatus` to accept boolean with coercion. Zero Vertex cost.
2. **Remove regression-causing phase 18 entries**: specifically the 15 FINANCIAL + any low-quality BUSINESS_ENTITY-touching entries. Audit by running v6 against each new entry; flag mismatches for human review. Keep the entries that improved types (ACCREDITATION, PUBLICATION, REGULATION).
3. **Hold subType quality bar**: every training entry must have concrete subType (no "other", no missing).
4. **Split fraud out of main training**: trim fraudSignals-heavy entries from main golden. Move fraud concerns to a separate fine-tune (fraud-v2 — GME8 could codify this as a routing concern).
5. **Ceteris paribus**: same hyperparameters as v6/v7 (6 epochs, ADAPTER_SIZE_FOUR, LR 1.0, gemini-2.5-flash base). Only the dataset changes.
6. **Re-eval identically**: stratified n=10, 249 entries. DoD unchanged.

Expected v7.1 target: Macro F1 ≥82%, all 23 types ≥75%, fraudSignals NOT evaluated here (split stream), latency p95 ≤5.5s (from schema-fix alone).

## Production impact

- **Prod remains v5-reasoning.** No env var changes. No Cloud Run deploy needed. `GEMINI_TUNED_MODEL=projects/.../endpoints/8811908947217743872` stays.
- **v6 endpoint undeployed** — was never in prod, artifact preserved. v6 rollback (from a hypothetical future v7.1 cutover) can be recreated in ~10 min from `models/6611494259700793344` if ever needed.
- **v7 endpoint undeployed + shell deleted** — model artifact `models/1576047663835512832` preserved for v7.1 design reference.
- **5 v7 intermediate checkpoint endpoints** (steps 60-300) undeployed + shells deleted. **fraud-v1 shell** deleted.
- **Vertex endpoints post-cleanup: 1 deployed** (v5-reasoning current prod). New HARD RULE in CLAUDE.md: audit Vertex before + after every run; target 1-2 deployed.

## What NOT to do next

- Do NOT start GME3 (Legal Expert, SCRUM-820) until v7.1 or a general-purpose extractor is in prod. Domain experts need a working general fallback.
- Do NOT start GME8 (Infrastructure, SCRUM-828) infrastructure work assuming v7 is shipped — its DoR "v7 general shipped" is NOT satisfied.
- Do NOT attempt fraudSignals detection in the main extractor again. Route it to a dedicated stream.

## Methodology caveat (applies to both v6 and v7 stratified)

The eval runner pulls from `FULL_GOLDEN_DATASET`, which includes training data (90/10 split used for enrichment). Statistically ~224 of the 249 stratified entries were in v7's training corpus. Scores are upper-bounds for production OOD traffic. The **comparison** between v6 and v7 is still valid (identical sampling methodology), but absolute numbers will likely be lower on totally-unseen documents. Production monitoring (via `adjustedConfidence` + error rate dashboards) is the authoritative out-of-sample validation.
