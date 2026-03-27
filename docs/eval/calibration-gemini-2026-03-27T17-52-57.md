# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.389 |
| Expected Calibration Error | 9.2% |
| Max Calibration Error | 59.6% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 3 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 35 | 2.8% | 44.2% | -41.4pp (underconfident) |
| 20-40% | 7 | 27.9% | 87.4% | -59.6pp (underconfident) |
| 40-60% | 14 | 50.1% | 80.0% | -29.9pp (underconfident) |
| 60-80% | 555 | 73.6% | 83.5% | -9.8pp |
| 80-90% | 380 | 83.7% | 87.7% | -3.9pp |
| 90-100% | 39 | 92.1% | 86.3% | +5.8pp |

## Recalibration Recommendations

- Pearson r = 0.389 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 41.4pp (reports 3% confidence, actual 44% accuracy).
- Bucket 20-40%: underconfident by 59.6pp (reports 28% confidence, actual 87% accuracy).
- Bucket 40-60%: underconfident by 29.9pp (reports 50% confidence, actual 80% accuracy).