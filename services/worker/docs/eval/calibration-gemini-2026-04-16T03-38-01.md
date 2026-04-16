# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.375 |
| Expected Calibration Error | 7.0% |
| Max Calibration Error | 40.6% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 2 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 3 | 6.7% | 47.2% | -40.6pp (underconfident) |
| 20-40% | 1 | 30.0% | 42.9% | -12.9pp (underconfident) |
| 40-60% | 0 | — | — | — |
| 60-80% | 39 | 73.5% | 69.3% | +4.2pp |
| 80-90% | 7 | 82.7% | 90.2% | -7.5pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.375 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 40.6pp (reports 7% confidence, actual 47% accuracy).
- Bucket 20-40%: underconfident by 12.9pp (reports 30% confidence, actual 43% accuracy).