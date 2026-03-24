# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.238 |
| Expected Calibration Error | 20.8% |
| Max Calibration Error | 56.3% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 4 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 8 | 10.4% | 66.7% | -56.3pp (underconfident) |
| 20-40% | 3 | 31.7% | 80.0% | -48.3pp (underconfident) |
| 40-60% | 87 | 54.3% | 81.5% | -27.2pp (underconfident) |
| 60-80% | 198 | 68.2% | 85.8% | -17.5pp (underconfident) |
| 80-90% | 14 | 83.7% | 81.6% | +2.1pp |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.238 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 20.8% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 56.3pp (reports 10% confidence, actual 67% accuracy).
- Bucket 20-40%: underconfident by 48.3pp (reports 32% confidence, actual 80% accuracy).
- Bucket 40-60%: underconfident by 27.2pp (reports 54% confidence, actual 82% accuracy).
- Bucket 60-80%: underconfident by 17.5pp (reports 68% confidence, actual 86% accuracy).
- PROMPT FIX: Add instruction "Your confidence scores are 21pp lower than actual accuracy. Be more confident in your extractions."