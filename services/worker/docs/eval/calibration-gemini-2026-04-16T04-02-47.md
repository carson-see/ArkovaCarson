# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.718 |
| Expected Calibration Error | 5.7% |
| Max Calibration Error | 10.9% |
| Overconfident Buckets | 1 |
| Underconfident Buckets | 0 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 0 | — | — | — |
| 20-40% | 0 | — | — | — |
| 40-60% | 0 | — | — | — |
| 60-80% | 2 | 77.0% | 66.1% | +10.9pp (overconfident) |
| 80-90% | 3 | 82.7% | 84.8% | -2.2pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.718 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- Bucket 60-80%: overconfident by 10.9pp (reports 77% confidence, actual 66% accuracy). Consider adding a prompt instruction to lower confidence when 60-80 confidence.