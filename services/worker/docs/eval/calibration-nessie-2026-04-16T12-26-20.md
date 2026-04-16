# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.000 |
| Expected Calibration Error | 14.3% |
| Max Calibration Error | 14.3% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 1 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 1 | 0.0% | 14.3% | -14.3pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 0 | — | — | — |
| 60-80% | 0 | — | — | — |
| 80-90% | 0 | — | — | — |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.000 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 14.3pp (reports 0% confidence, actual 14% accuracy).