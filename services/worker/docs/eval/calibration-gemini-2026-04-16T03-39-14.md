# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.000 |
| Expected Calibration Error | 21.2% |
| Max Calibration Error | 21.2% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 1 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 50 | 0.0% | 21.2% | -21.2pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 0 | — | — | — |
| 60-80% | 0 | — | — | — |
| 80-90% | 0 | — | — | — |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.000 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 21.2% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 21.2pp (reports 0% confidence, actual 21% accuracy).
- PROMPT FIX: Add instruction "Your confidence scores are 21pp lower than actual accuracy. Be more confident in your extractions."