# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | -0.010 |
| Expected Calibration Error | 23.8% |
| Max Calibration Error | 81.1% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 3 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 9 | 9.2% | 90.4% | -81.1pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 39 | 53.2% | 90.0% | -36.8pp (underconfident) |
| 60-80% | 218 | 68.4% | 90.8% | -22.4pp (underconfident) |
| 80-90% | 40 | 82.5% | 90.0% | -7.6pp |
| 90-100% | 4 | 92.3% | 85.7% | +6.5pp |

## Recalibration Recommendations

- Pearson r = -0.010 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 23.8% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 81.1pp (reports 9% confidence, actual 90% accuracy).
- Bucket 40-60%: underconfident by 36.8pp (reports 53% confidence, actual 90% accuracy).
- Bucket 60-80%: underconfident by 22.4pp (reports 68% confidence, actual 91% accuracy).
- PROMPT FIX: Add instruction "Your confidence scores are 24pp lower than actual accuracy. Be more confident in your extractions."