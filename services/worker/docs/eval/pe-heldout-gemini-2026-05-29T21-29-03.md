# AI Extraction Eval Report

- **Date:** 2026-05-29T21:29:03.952Z
- **Provider:** gemini
- **Prompt Version:** 55995ed0e9cc
- **Entries Evaluated:** 18

## Overall Metrics

| Metric | Value |
|--------|-------|
| Macro F1 | 72.7% |
| Weighted F1 | 82.2% |
| Mean Reported Confidence | 91.4% |
| Mean Actual Accuracy | 74.0% |
| Confidence Correlation (r) — raw | -0.259 |
| Confidence Correlation (r) — calibrated | -0.468 |
| Mean Calibrated Confidence | 91.5% |
| Mean Latency | 8992ms |

## Per-Field Metrics

| Field | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| credentialType | 94.4% | 94.4% | 94.4% | 17 | 1 | 1 |
| issuerName | 100.0% | 100.0% | 100.0% | 18 | 0 | 0 |
| issuedDate | 100.0% | 100.0% | 100.0% | 2 | 0 | 0 |
| fieldOfStudy | 100.0% | 100.0% | 100.0% | 17 | 0 | 0 |
| accreditingBody | 50.0% | 66.7% | 57.1% | 4 | 4 | 2 |
| creditHours | 100.0% | 100.0% | 100.0% | 18 | 0 | 0 |
| creditType | 50.0% | 5.6% | 10.0% | 1 | 1 | 17 |
| activityNumber | 6.3% | 100.0% | 11.8% | 1 | 15 | 0 |
| courseId | 94.1% | 94.1% | 94.1% | 16 | 1 | 1 |
| providerName | 100.0% | 100.0% | 100.0% | 18 | 0 | 0 |
| approvedBy | 0.0% | 0.0% | 0.0% | 0 | 6 | 0 |
| deliveryMethod | 77.8% | 77.8% | 77.8% | 14 | 4 | 4 |
| nasbaStatus | 75.0% | 50.0% | 60.0% | 3 | 1 | 3 |
| fraudSignals | 0.0% | 0.0% | 0.0% | 0 | 0 | 2 |
| jurisdiction | 100.0% | 100.0% | 100.0% | 8 | 0 | 0 |
| ethicsHours | 100.0% | 75.0% | 85.7% | 6 | 0 | 2 |

## Per-Credential-Type Metrics

| Type | Entries | Macro F1 | Weighted F1 | Confidence Corr |
|------|---------|----------|-------------|-----------------|
| CPE | 10 | 71.2% | 82.0% | -0.531 |
| CLE | 8 | 73.1% | 83.6% | 0.589 |

## Worst-Performing Entries (Bottom 10)

| Entry | Type | Accuracy | Confidence | Errors |
|-------|------|----------|------------|--------|
| GD-PE-HO-013 | CPE | 58% | 90% | accreditingBody: false_negative, creditType: false_negative, activityNumber: false_positive, nasbaStatus: mismatch, fraudSignals: false_negative |
| GD-PE-HO-008 | CLE | 67% | 90% | accreditingBody: false_positive, creditType: false_negative, activityNumber: false_positive, deliveryMethod: mismatch |
| GD-PE-HO-018 | CLE | 67% | 90% | credentialType: mismatch, creditType: false_negative, activityNumber: false_positive, ethicsHours: false_negative |
| GD-PE-HO-004 | CPE | 69% | 95% | creditType: false_negative, activityNumber: false_positive, approvedBy: false_positive, nasbaStatus: false_negative |
| GD-PE-HO-012 | CPE | 70% | 85% | creditType: false_negative, activityNumber: false_positive, deliveryMethod: mismatch |
| GD-PE-HO-001 | CPE | 71% | 95% | activityNumber: false_positive, courseId: mismatch, approvedBy: false_positive, nasbaStatus: false_negative |
| GD-PE-HO-002 | CLE | 71% | 95% | accreditingBody: false_positive, creditType: false_negative, activityNumber: false_positive, approvedBy: false_positive |
| GD-PE-HO-003 | CPE | 71% | 95% | creditType: mismatch, activityNumber: false_positive, approvedBy: false_positive, ethicsHours: false_negative |
| GD-PE-HO-009 | CLE | 71% | 95% | accreditingBody: false_positive, creditType: false_negative, activityNumber: false_positive, approvedBy: false_positive |
| GD-PE-HO-007 | CPE | 73% | 95% | accreditingBody: false_negative, creditType: false_negative, deliveryMethod: mismatch |

## Confidence Calibration

| Confidence Bucket | Count | Mean Accuracy | Calibration Gap |
|-------------------|-------|---------------|-----------------|
| 0-30% | 0 | — | — |
| 30-50% | 0 | — | — |
| 50-70% | 0 | — | — |
| 70-90% | 3 | 79.2% | -0.8pp |
| 90-100% | 15 | 72.9% | -22.6pp |