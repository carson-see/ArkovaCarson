# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.251 |
| Expected Calibration Error | 7.2% |
| Max Calibration Error | 50.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 1 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 1 | 0.0% | 50.0% | -50.0pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 1 | 45.0% | 50.0% | -5.0pp |
| 60-80% | 22 | 75.7% | 70.8% | +4.9pp |
| 80-90% | 6 | 83.7% | 75.1% | +8.6pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.251 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 50.0pp (reports 0% confidence, actual 50% accuracy).