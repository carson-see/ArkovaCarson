# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.000 |
| Expected Calibration Error | 13.1% |
| Max Calibration Error | 13.1% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 1 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 3 | 0.0% | 13.1% | -13.1pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 0 | — | — | — |
| 60-80% | 0 | — | — | — |
| 80-90% | 0 | — | — | — |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.000 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 13.1pp (reports 0% confidence, actual 13% accuracy).