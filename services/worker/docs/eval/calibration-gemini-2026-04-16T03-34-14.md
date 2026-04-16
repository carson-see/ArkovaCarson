# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.239 |
| Expected Calibration Error | 5.6% |
| Max Calibration Error | 50.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 2 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 1 | 0.0% | 50.0% | -50.0pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 1 | 50.0% | 80.0% | -30.0pp (underconfident) |
| 60-80% | 22 | 73.2% | 70.7% | +2.6pp |
| 80-90% | 6 | 82.7% | 77.6% | +5.1pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.239 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 50.0pp (reports 0% confidence, actual 50% accuracy).
- Bucket 40-60%: underconfident by 30.0pp (reports 50% confidence, actual 80% accuracy).