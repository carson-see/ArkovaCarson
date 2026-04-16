# Confidence Calibration Report (AI-EVAL-02)

## Calibration Status: NEEDS RECALIBRATION

| Metric | Value |
|--------|-------|
| Pearson Correlation (r) | 0.117 |
| Expected Calibration Error | 29.2% |
| Max Calibration Error | 80.0% |
| Overconfident Buckets | 0 |
| Underconfident Buckets | 4 |

## Calibration Table

| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |
|-------------------|-------|-----------------|---------------|-----|
| 0-20% | 1 | 20.0% | 100.0% | -80.0pp (underconfident) |
| 20-40% | 7 | 28.6% | 72.6% | -44.0pp (underconfident) |
| 40-60% | 25 | 51.0% | 79.4% | -28.4pp (underconfident) |
| 60-80% | 17 | 64.7% | 86.1% | -21.4pp (underconfident) |
| 80-90% | 0 | — | — | — |
| 90-100% | 0 | — | — | — |

## Recalibration Recommendations

- Pearson r = 0.117 (target >= 0.80). Confidence scores do not reliably predict accuracy.
- ECE = 29.2% — expected calibration error is high. Model is generally underconfident.
- Bucket 0-20%: underconfident by 80.0pp (reports 20% confidence, actual 100% accuracy).
- Bucket 20-40%: underconfident by 44.0pp (reports 29% confidence, actual 73% accuracy).
- Bucket 40-60%: underconfident by 28.4pp (reports 51% confidence, actual 79% accuracy).
- Bucket 60-80%: underconfident by 21.4pp (reports 65% confidence, actual 86% accuracy).
- PROMPT FIX: Add instruction "Your confidence scores are 29pp lower than actual accuracy. Be more confident in your extractions."