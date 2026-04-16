# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.018 |
| Expected Calibration Error | 50.9% |
| Max Calibration Error | 57.5% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 2 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 19 | 10.2% | 67.7% | -57.5pp (underconfident) |
| 20-40% | 11 | 29.4% | 69.0% | -39.5pp (underconfident) |
| 40-60% | 0 | — | — | — |
| 60-80% | 0 | — | — | — |
| 80-90% | 0 | — | — | — |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.018 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 50.9% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 57.5pp (reports 10% confidence, actual 68% accuracy).
- Bucket 20-40%: underconfident by 39.5pp (reports 29% confidence, actual 69% accuracy).