# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.278 |
| Expected Calibration Error | 17.6% |
| Max Calibration Error | 34.4% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 4 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 3 | 6.7% | 22.2% | -15.6pp (underconfident) |
| 20-40% | 3 | 30.0% | 64.4% | -34.4pp (underconfident) |
| 40-60% | 102 | 53.4% | 76.1% | -22.7pp (underconfident) |
| 60-80% | 140 | 67.0% | 80.5% | -13.5pp (underconfident) |
| 80-90% | 1 | 83.0% | 91.7% | -8.7pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.278 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 17.6% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 15.6pp (reports 7% confidence, actual 22% accuracy).
- Bucket 20-40%: underconfident by 34.4pp (reports 30% confidence, actual 64% accuracy).
- Bucket 40-60%: underconfident by 22.7pp (reports 53% confidence, actual 76% accuracy).
- Bucket 60-80%: underconfident by 13.5pp (reports 67% confidence, actual 80% accuracy).
- PROMPT FIX: Add instruction "Your confidence scores are 18pp lower than actual accuracy. Be more confident in your extractions."