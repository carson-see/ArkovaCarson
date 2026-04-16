# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.297 |
| Expected Calibration Error | 5.8% |
| Max Calibration Error | 50.0% |
| Overconfident Buckets | 1 |
| Underconfident Buckets | 1 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 1 | 0.0% | 50.0% | -50.0pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 1 | 53.0% | 40.0% | +13.0pp (overconfident) |
| 60-80% | 22 | 75.6% | 72.0% | +3.5pp |
| 80-90% | 6 | 83.2% | 77.5% | +5.7pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.297 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 40-60%: overconfident by 13.0pp (reports 53% confidence, actual 40% accuracy). Consider adding a prompt instruction to lower confidence when 40-60 confidence.
- Bucket 0-20%: underconfident by 50.0pp (reports 0% confidence, actual 50% accuracy).