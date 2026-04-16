# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.211 |
| Expected Calibration Error | 4.2% |
| Max Calibration Error | 50.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 2 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 1 | 0.0% | 50.0% | -50.0pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 1 | 53.0% | 66.7% | -13.7pp (underconfident) |
| 60-80% | 22 | 76.1% | 74.6% | +1.4pp |
| 80-90% | 6 | 82.3% | 77.5% | +4.9pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.211 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 50.0pp (reports 0% confidence, actual 50% accuracy).
- Bucket 40-60%: underconfident by 13.7pp (reports 53% confidence, actual 67% accuracy).