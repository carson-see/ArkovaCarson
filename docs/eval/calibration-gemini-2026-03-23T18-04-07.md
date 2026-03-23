# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.301 |
| Expected Calibration Error | 3.0% |
| Max Calibration Error | 75.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 4 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 4 | 12.0% | 58.3% | -46.3pp (underconfident) |
| 20-40% | 1 | 25.0% | 100.0% | -75.0pp (underconfident) |
| 40-60% | 1 | 45.0% | 60.0% | -15.0pp (underconfident) |
| 60-80% | 20 | 75.3% | 87.0% | -11.7pp (underconfident) |
| 80-90% | 164 | 85.6% | 85.2% | +0.4pp |
| 90-100% | 20 | 91.1% | 94.2% | -3.1pp |

## Recalibration Recommendations

- Pearson r = 0.301 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 0-20%: underconfident by 46.3pp (reports 12% confidence, actual 58% accuracy).
- Bucket 20-40%: underconfident by 75.0pp (reports 25% confidence, actual 100% accuracy).
- Bucket 40-60%: underconfident by 15.0pp (reports 45% confidence, actual 60% accuracy).
- Bucket 60-80%: underconfident by 11.7pp (reports 75% confidence, actual 87% accuracy).