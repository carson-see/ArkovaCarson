# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.262 |
| Expected Calibration Error | 9.5% |
| Max Calibration Error | 70.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 4 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 3 | 1.7% | 55.6% | -53.9pp (underconfident) |
| 20-40% | 1 | 30.0% | 100.0% | -70.0pp (underconfident) |
| 40-60% | 2 | 52.5% | 85.7% | -33.2pp (underconfident) |
| 60-80% | 39 | 74.9% | 87.8% | -12.9pp (underconfident) |
| 80-90% | 51 | 83.6% | 86.6% | -2.9pp |
| 90-100% | 4 | 92.0% | 91.7% | +0.3pp |

## Recalibration Recommendations

- Pearson r = 0.262 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 53.9pp (reports 2% confidence, actual 56% accuracy).
- Bucket 20-40%: underconfident by 70.0pp (reports 30% confidence, actual 100% accuracy).
- Bucket 40-60%: underconfident by 33.2pp (reports 53% confidence, actual 86% accuracy).
- Bucket 60-80%: underconfident by 12.9pp (reports 75% confidence, actual 88% accuracy).