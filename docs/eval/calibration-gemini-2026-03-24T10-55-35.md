# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.124 |
| Expected Calibration Error | 18.2% |
| Max Calibration Error | 73.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 4 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 9 | 10.3% | 83.3% | -73.0pp (underconfident) |
| 20-40% | 0 | — | — | — |
| 40-60% | 2 | 56.0% | 100.0% | -44.0pp (underconfident) |
| 60-80% | 176 | 73.4% | 93.8% | -20.4pp (underconfident) |
| 80-90% | 117 | 83.7% | 94.7% | -10.9pp (underconfident) |
| 90-100% | 6 | 92.3% | 91.1% | +1.3pp |

## Recalibration Recommendations

- Pearson r = 0.124 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 18.2% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 73.0pp (reports 10% confidence, actual 83% accuracy).
- Bucket 40-60%: underconfident by 44.0pp (reports 56% confidence, actual 100% accuracy).
- Bucket 60-80%: underconfident by 20.4pp (reports 73% confidence, actual 94% accuracy).
- Bucket 80-90%: underconfident by 10.9pp (reports 84% confidence, actual 95% accuracy).
- PROMPT FIX: Add instruction "Your confidence scores are 18pp lower than actual accuracy. Be more confident in your extractions."