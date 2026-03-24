# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | -0.027 |
| Expected Calibration Error | 15.9% |
| Max Calibration Error | 81.9% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 3 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 9 | 10.3% | 92.2% | -81.9pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 4 | 55.5% | 95.8% | -40.3pp (underconfident) |
| 60-80% | 179 | 73.6% | 90.4% | -16.8pp (underconfident) |
| 80-90% | 112 | 83.8% | 92.5% | -8.7pp |
| 90-100% | 6 | 92.8% | 83.9% | +8.9pp |

## Recalibration Recommendations

- Pearson r = -0.027 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 15.9% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 81.9pp (reports 10% confidence, actual 92% accuracy).
- Bucket 40-60%: underconfident by 40.3pp (reports 56% confidence, actual 96% accuracy).
- Bucket 60-80%: underconfident by 16.8pp (reports 74% confidence, actual 90% accuracy).
- PROMPT FIX: Add instruction "Your confidence scores are 16pp lower than actual accuracy. Be more confident in your extractions."