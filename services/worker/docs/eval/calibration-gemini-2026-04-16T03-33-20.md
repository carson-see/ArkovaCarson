# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.244 |
| Expected Calibration Error | 5.3% |
| Max Calibration Error | 5.5% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 0 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 0 | — | — | — |
| 20-40% | 0 | — | — | — |
| 40-60% | 0 | — | — | — |
| 60-80% | 3 | 74.0% | 68.5% | +5.5pp |
| 80-90% | 2 | 82.5% | 87.5% | -5.0pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.244 (target >= 0.80). Confidence scores do not reliably predict accuracy.