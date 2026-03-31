# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | -0.313 |
| Expected Calibration Error | 23.3% |
| Max Calibration Error | 88.0% |
| Overconfident Buckets | 1 |
| Underconfident Buckets | 1 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 1 | 12.0% | 100.0% | -88.0pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 1 | 50.0% | 57.1% | -7.1pp |
| 60-80% | 1 | 77.0% | 60.0% | +17.0pp (overconfident) |
| 80-90% | 2 | 84.5% | 86.6% | -2.1pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = -0.313 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 23.3% — expected calibration error is high. Model is generally underconfident.
- Bucket 60-80%: overconfident by 17.0pp (reports 77% confidence, actual 60% accuracy). Consider adding a prompt instruction to lower confidence when 60-80 confidence.
- Bucket 0-20%: underconfident by 88.0pp (reports 12% confidence, actual 100% accuracy).