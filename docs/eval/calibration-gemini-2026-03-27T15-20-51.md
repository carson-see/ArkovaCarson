# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.240 |
| Expected Calibration Error | 6.6% |
| Max Calibration Error | 61.5% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 3 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 28 | 9.4% | 70.9% | -61.5pp (underconfident) |
| 20-40% | 21 | 29.7% | 71.3% | -41.6pp (underconfident) |
| 40-60% | 50 | 46.3% | 71.7% | -25.4pp (underconfident) |
| 60-80% | 425 | 75.4% | 79.8% | -4.3pp |
| 80-90% | 468 | 83.8% | 85.6% | -1.8pp |
| 90-100% | 38 | 91.9% | 86.8% | +5.1pp |

## Recalibration Recommendations

- Pearson r = 0.240 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 61.5pp (reports 9% confidence, actual 71% accuracy).
- Bucket 20-40%: underconfident by 41.6pp (reports 30% confidence, actual 71% accuracy).
- Bucket 40-60%: underconfident by 25.4pp (reports 46% confidence, actual 72% accuracy).