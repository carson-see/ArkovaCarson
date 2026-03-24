# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | -0.089 |
| Expected Calibration Error | 16.0% |
| Max Calibration Error | 86.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 3 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 9 | 10.3% | 96.3% | -86.0pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 4 | 55.5% | 95.8% | -40.3pp (underconfident) |
| 60-80% | 178 | 73.6% | 90.7% | -17.1pp (underconfident) |
| 80-90% | 113 | 83.8% | 92.1% | -8.3pp |
| 90-100% | 6 | 92.3% | 83.9% | +8.4pp |

## Recalibration Recommendations

- Pearson r = -0.089 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 16.0% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 86.0pp (reports 10% confidence, actual 96% accuracy).
- Bucket 40-60%: underconfident by 40.3pp (reports 56% confidence, actual 96% accuracy).
- Bucket 60-80%: underconfident by 17.1pp (reports 74% confidence, actual 91% accuracy).
- PROMPT FIX: Add instruction "Your confidence scores are 16pp lower than actual accuracy. Be more confident in your extractions."