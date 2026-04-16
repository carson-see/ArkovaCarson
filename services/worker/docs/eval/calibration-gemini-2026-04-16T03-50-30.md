# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.000 |
| Expected Calibration Error | 16.0% |
| Max Calibration Error | 16.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 1 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 0 | — | — | — |
| 20-40% | 0 | — | — | — |
| 40-60% | 0 | — | — | — |
| 60-80% | 0 | — | — | — |
| 80-90% | 1 | 84.0% | 100.0% | -16.0pp (underconfident) |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.000 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 16.0% — expected calibration error is high. Model is generally underconfident.
- Bucket 80-90%: underconfident by 16.0pp (reports 84% confidence, actual 100% accuracy).