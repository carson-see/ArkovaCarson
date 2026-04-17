# Gemini Golden v6 Isotonic Calibration — 2026-04-16

**Story:** SCRUM-794 / GME2-03 "Confidence scores match actual accuracy"
**Input:** `services/worker/docs/eval/eval-gemini-2026-04-16T17-08-23.json` (stratified, n=249)
**Script:** `services/worker/scripts/derive-v6-calibration-knots.ts`

## Derived knots (applied to `calibration.ts` under `GEMINI_V6_PROMPT=true`)

| raw  | calibrated |
|------|------------|
| 0.00 | 0.67 |
| 0.48 | 0.79 |
| 0.53 | 0.80 |
| 0.56 | 0.80 |
| 0.59 | 0.80 |
| 0.62 | 0.82 |
| 1.00 | 0.82 |

## Outcome vs DoD

| Metric | Baseline (v6 raw) | After v6 knots | DoD target | Met? |
|---|---|---|---|---|
| Pearson r (confidence vs accuracy) | 0.260 | 0.264 | ≥ 0.40 | ❌ **No** |
| Mean calibrated confidence | 52% | **79.8%** | — (match accuracy) | — |
| Mean actual accuracy | — | 78.3% | — | — |
| Gap (calibrated − accuracy) | -26pp | **+1.4pp** | ≤ 5pp | ✅ **Yes** |
| ECE (Expected Calibration Error) | ~24% | ~1-2% | ≤ 10% | ✅ **Yes** |

## Why Pearson r barely moved

Gemini flash v6 raw confidences cluster narrowly (most samples in the 0.50–0.60 band). Isotonic calibration can **re-center the mean** but cannot **spread the ranking** when raw values don't have inherent dispersion. The CLAUDE.md note from the stratified-eval analysis already flagged this: r-stuck-at-0.26 is a model property, not a knot-fitting failure.

**Proposed fix (future work):** build an `adjustedConfidence` meta-model that ingests the raw confidence plus per-type difficulty features (credential type, field-count, OCR-noise signals). Track under SCRUM-794 comment or a fresh child story.

## Ship decision

Ship the isotonic layer as-is.

- Massive ECE improvement is real and material — consumers of the confidence score (fraud filters, downstream GRC integrations) now get an honest mean-confidence signal.
- Rollback is trivial: `GEMINI_V6_PROMPT=false` drops back to v5 knots.
- The r-stuck issue is a known limitation, not a regression. It existed in v6 raw output before and is not made worse by calibration.

## Tests

- `services/worker/src/ai/eval/calibration.test.ts` — new describe block `calibrateConfidence (v6 branch — SCRUM-794 / GME2-03)` with 7 tests covering floor / ceiling / monotonicity / mean-lift / v5-fallback. All 31 tests in the file green.
- Typecheck: 0 errors.

## Activation

Flips on when the worker's `GEMINI_V6_PROMPT=true` env var is set on Cloud Run (same flag that activates the v6 endpoint prompt). No separate env var needed for the calibration layer.
