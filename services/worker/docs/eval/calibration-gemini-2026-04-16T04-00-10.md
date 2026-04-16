# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.396 |
| Expected Calibration Error | 4.7% |
| Max Calibration Error | 35.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 2 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 4 | 11.2% | 44.2% | -32.9pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 1 | 40.0% | 75.0% | -35.0pp (underconfident) |
| 60-80% | 39 | 75.7% | 74.9% | +0.9pp |
| 80-90% | 6 | 82.5% | 88.1% | -5.6pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.396 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 32.9pp (reports 11% confidence, actual 44% accuracy).
- Bucket 40-60%: underconfident by 35.0pp (reports 40% confidence, actual 75% accuracy).