# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.260 |
| Expected Calibration Error | 24.2% |
| Max Calibration Error | 41.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 5 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 6 | 18.7% | 50.0% | -31.3pp (underconfident) |
| 20-40% | 19 | 32.4% | 73.3% | -41.0pp (underconfident) |
| 40-60% | 138 | 52.6% | 78.4% | -25.8pp (underconfident) |
| 60-80% | 85 | 63.7% | 81.1% | -17.3pp (underconfident) |
| 80-90% | 1 | 82.0% | 100.0% | -18.0pp (underconfident) |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.260 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 24.2% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 31.3pp (reports 19% confidence, actual 50% accuracy).
- Bucket 20-40%: underconfident by 41.0pp (reports 32% confidence, actual 73% accuracy).
- Bucket 40-60%: underconfident by 25.8pp (reports 53% confidence, actual 78% accuracy).
- Bucket 60-80%: underconfident by 17.3pp (reports 64% confidence, actual 81% accuracy).
- Bucket 80-90%: underconfident by 18.0pp (reports 82% confidence, actual 100% accuracy).
- PROMPT FIX: Add instruction "Your confidence scores are 24pp lower than actual accuracy. Be more confident in your extractions."