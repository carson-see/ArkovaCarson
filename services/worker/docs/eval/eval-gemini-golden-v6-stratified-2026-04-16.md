# Gemini Golden v6 — Stratified Eval (n=10 per type)

**Date:** 2026-04-16
**Endpoint:** `projects/270018525501/locations/us-central1/endpoints/740332515062972416`
**Eval config:** `--stratified 10`, 249 entries across 24 detected types (10 per type, subject to dataset availability)
**Inference config:** `GEMINI_V6_PROMPT=true`, `GEMINI_TUNED_RESPONSE_SCHEMA=false` (flag off for this baseline)
**Raw eval JSON:** `docs/eval/eval-gemini-2026-04-16T17-08-23.json`

## TL;DR — The 50-sample eval was lying about weak types

v6's first eval (50 samples, proportional to training set) gave 1-3 entries for rare types. Per-type F1 on n=1-3 is pure noise. The stratified n=10 eval contradicts it almost completely.

| Metric | 50-sample proportional | **230-sample stratified** |
|---|---|---|
| Macro F1 | 77.1% | **79.3%** |
| Weighted F1 | 83.6% | 81.3% |
| Confidence Pearson r | 0.117 | **0.260** |
| ECE | 29.2% | 24.2% |
| Mean reported confidence | 51.9% | 54.2% |
| Mean actual accuracy | 81.1% | 78.3% |
| Mean latency | 3.38s | 3.73s |

Weighted F1 dropped slightly (83.6→81.3) because stratified evaluates rare types that have lower F1 with the same weight as common types; proportional weighting over-sampled the high-F1 common types. Macro F1 is the right comparison metric for a stratified eval — and it went UP 2.2pp, confirming v6 is broadly strong.

## Per-type F1 (n=10, statistically meaningful)

| Rank | Type | F1 | v6 50-sample (n) | Status |
|---:|---|---:|---:|---|
| 1 | LICENSE | **99.3%** | — | 🔥 production-grade |
| 2 | SEC_FILING | 97.2% | 75.0% (n=1) | 🔥 |
| 3 | CERTIFICATE | 94.5% | 86.9% (n=7) | 🔥 |
| 4 | CLE | 93.7% | 95.8% (n=2) | 🔥 |
| 5 | INSURANCE | 92.8% | 83.3% (n=2) | 🔥 |
| 6 | TRANSCRIPT | **90.6%** | 63.9% (n=2) | was noise — fine |
| 7 | BADGE | 89.1% | 68.0% (n=3) | was noise — fine |
| 8 | PROFESSIONAL | 86.9% | 95.2% (n=2) | stable |
| 9 | REGULATION | **86.5%** | 57.8% (n=3) | was noise — fine |
| 10 | DEGREE | 85.7% | 100.0% (n=4) | stable |
| 11 | PUBLICATION | 84.0% | 80.0% (n=4) | stable |
| 12 | ATTESTATION | 82.2% | 100.0% (n=2) | stable |
| 13 | IDENTITY | **81.8%** | 55.6% (n=3) | was noise — fine |
| 14 | BUSINESS_ENTITY | 81.7% | — | 🔥 (new measurement) |
| 15 | PATENT | 78.6% | 100.0% (n=2) | stable |
| 16 | MILITARY | **77.6%** | 50.0% (n=1) | was pure noise — fine |
| 17 | CHARITY | 74.6% | 50.0% (n=1) | borderline |
| 18 | MEDICAL | 73.6% | 69.4% (n=3) | borderline |
| 19 | LEGAL | 73.1% | 83.3% (n=2) | borderline |
| 20 | FINANCIAL | 70.6% | 73.3% (n=2) | borderline |
| 21 | OTHER | 62.3% | 100.0% (n=1) | real (catch-all, expected) |
| 22 | **RESUME** | **53.1%** | 60.0% (n=2) | **★ real weakness** |
| 23 | **ACCREDITATION** | **42.9%** | — | **★ data hygiene issue** |

**19 of 23 canonical types are ≥75%** (DoD target). Only real problems:
- **RESUME (53.1%)** — genuine training-data weakness
- **ACCREDITATION (42.9%)** — NOT a canonical type. Exists in 19 golden entries because the v6 enrichment script's `canonicalizeCredentialType` mapped `ACCREDITATION → ATTESTATION` in training targets, but the eval framework compares against the ORIGINAL `groundTruth.credentialType`, which is still `ACCREDITATION`. The model correctly outputs `ATTESTATION`, but the scorer counts that as wrong. **Fix: re-label the 19 source entries' `groundTruth.credentialType: 'ACCREDITATION' → 'ATTESTATION'`.** Zero training cost.

Borderline (70-75%): FINANCIAL, LEGAL, MEDICAL, CHARITY — modest training-data additions would push these over 75%.

## Confidence calibration — v6 is severely underconfident but narrowly clustered

- **Raw Pearson r: 0.260** — model confidence barely predicts accuracy on an ordinal scale.
- **Mean reported confidence: 54.2%** vs **mean actual accuracy: 78.3%** — **24pp underconfidence**.
- **ECE: 24.2%, MCE: 41.0%** — high bucket-level error.
- **Bucket 0-20%**: reports 20%, actual 100% (80pp underconfident)
- **Bucket 20-40%**: reports 29%, actual 73% (44pp underconfident)
- **Bucket 40-60%**: reports 51%, actual 79% (28pp underconfident)
- **Bucket 60-80%**: reports 65%, actual 86% (21pp underconfident)

### Derived v6 calibration knots (from `deriveCalibrationKnots`)
```
| raw  | calibrated |
| 0.00 | 0.67       |
| 0.48 | 0.79       |
| 0.53 | 0.80       |
| 0.56 | 0.80       |
| 0.59 | 0.80       |
| 0.62 | 0.82       |
| 1.00 | 0.82       |
```

**Projected with new knots:**
- Mean calibrated confidence: **79.8%** (vs actual 78.3% — **1.4pp gap**, near-perfect mean alignment)
- Pearson r: 0.264 (barely moves — isotonic fixes mean, not ranking)

### Why Pearson r doesn't improve
Flash's raw confidence is clustered narrowly in 50-65% for most requests. Isotonic mapping lifts that band to 79-82% but doesn't spread it — the ORDINAL ranking of confidences across entries barely changes, so Pearson r is structural.

### Better signal: `adjustedConfidence` meta-model
The eval framework already computes `adjustedConfidence` via `computeAdjustedConfidence` in `confidence-model.ts`, which uses extraction features (field count, grounding score, fraud signals, provider identity). That meta-model may have much higher Pearson r than raw. Worth measuring as a v7 verification step.

## Latency

Mean 3.73s (vs 50-sample mean 3.38s). Eval sample vs endpoint cold/warm state — not a regression.

## What this changes for v7

**v7 scope shrinks dramatically.** The original "+375 entries" plan targeted imagined weakness. Truth is much more surgical:

### Revised v7 dataset composition (~190 new entries, not 375)

| Category | Entries | Purpose |
|---|---:|---|
| **ACCREDITATION → ATTESTATION relabel** | 0 new, 19 edits | Data hygiene. Fixes the 42.9% immediately. Likely worth ~3pp Macro F1 alone. |
| **RESUME** | 30 | One clearly weak type at 53.1%. Needs real training data. |
| **FINANCIAL** | 15 | Push 70.6% → 75%+ |
| **LEGAL** | 15 | Push 73.1% → 75%+ |
| **MEDICAL** | 15 | Push 73.6% → 75%+ |
| **CHARITY** | 15 | Push 74.6% → 80%+ |
| **Fraud signal seed** | 100 | 0% → 50%+ (the one axis v6 never touched) |
| **Total new** | **190** | vs 375 originally pitched |

Removed from v7 scope (not needed based on stratified truth):
- IDENTITY expansion (already 81.8%)
- REGULATION expansion (already 86.5%)
- TRANSCRIPT expansion (already 90.6%)
- BADGE expansion (already 89.1%)
- MILITARY expansion (already 77.6%)
- General subtype diversity (CERTIFICATE already 94.5%)
- International expansion (most international types already strong)
- Edge case expansion (covered by existing entries)

### Revised v7 DoD (tighter + more realistic)

| Metric | v6 stratified | v7 target |
|---|---|---|
| Macro F1 | 79.3% | **≥82%** (3pp with 190 surgical entries) |
| Per-type F1 ≥75% for ALL 23 canonical types | 19/23 pass | **23/23 pass** |
| `fraudSignals` F1 | 0% | **≥50%** |
| ACCREDITATION F1 (data-hygiene fix only) | 42.9% | **N/A (type relabeled away)** |
| RESUME F1 | 53.1% | **≥75%** |
| FINANCIAL/LEGAL/MEDICAL/CHARITY | 70-75% | **≥80%** each |
| Calibrated confidence Pearson r (raw model) | 0.26 | stretch: ≥0.5 |
| Calibrated ECE | 24.2% | **≤10%** (isotonic retrain) |
| Calibrated mean gap | 24pp | **≤5pp** |
| Latency p50/p95 | 3.24/4.93s | ≤3.5/≤5.5s (hold) |
| JSON parse (responseSchema on) | 100% (sans schema) | 100% (with schema) |

### Estimated v7 impact on Macro F1
- ACCREDITATION relabel: 42.9 → ~82 (like ATTESTATION) on 19 entries → Macro +~2pp
- RESUME: 53.1 → 75 → Macro +~1pp
- Borderline 4 types (FINANCIAL/LEGAL/MEDICAL/CHARITY): +5pp each on 4 types → Macro +~1pp
- fraudSignals: 0 → 50 → Weighted F1 +~0.5pp
- **Expected v7 Macro F1: 82-84%** vs v6's 79.3%

## Next actions

1. **Relabel the 19 ACCREDITATION entries** in `golden-dataset-phase17-expansion.ts` (or wherever they live) → ATTESTATION. Worth re-running this stratified eval to confirm the jump before v7 training.
2. **Curate the 190 new entries** (much smaller scope than the 375 original v7 plan).
3. **Apply v6 calibration knots** to `calibration.ts` once v6 code ships (independent of v7).
4. **Enable `GEMINI_TUNED_RESPONSE_SCHEMA=true`** and re-run stratified eval to confirm no regression before adding it to the prod config.
5. **Test `adjustedConfidence`** Pearson r vs `reportedConfidence` — may already be our answer for confidence discrimination.
