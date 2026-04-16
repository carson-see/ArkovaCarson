# AI Extraction Eval Report

- **Date:** 2026-04-16T00:26:54.102Z
- **Provider:** nessie
- **Prompt Version:** 55995ed0e9cc
- **Entries Evaluated:** 10

## Overall Metrics

| Metric | Value |
|--------|-------|
| Macro F1 | 0.0% |
| Weighted F1 | 0.0% |
| Mean Reported Confidence | 0.0% |
| Mean Actual Accuracy | 20.3% |
| Confidence Correlation (r) — raw | 0.000 |
| Confidence Correlation (r) — calibrated | 0.000 |
| Mean Calibrated Confidence | 76.0% |
| Mean Latency | 272310ms |

## Per-Field Metrics

| Field | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| credentialType | 0.0% | 0.0% | 0.0% | 0 | 0 | 10 |
| issuerName | 0.0% | 0.0% | 0.0% | 0 | 0 | 7 |
| issuedDate | 0.0% | 0.0% | 0.0% | 0 | 0 | 8 |
| fieldOfStudy | 0.0% | 0.0% | 0.0% | 0 | 0 | 7 |
| degreeLevel | 0.0% | 0.0% | 0.0% | 0 | 0 | 2 |
| jurisdiction | 0.0% | 0.0% | 0.0% | 0 | 0 | 6 |
| fraudSignals | 0.0% | 0.0% | 0.0% | 0 | 0 | 0 |
| accreditingBody | 0.0% | 0.0% | 0.0% | 0 | 0 | 3 |
| creditHours | 0.0% | 0.0% | 0.0% | 0 | 0 | 2 |
| creditType | 0.0% | 0.0% | 0.0% | 0 | 0 | 2 |
| licenseNumber | 0.0% | 0.0% | 0.0% | 0 | 0 | 1 |
| activityNumber | 0.0% | 0.0% | 0.0% | 0 | 0 | 1 |
| providerName | 0.0% | 0.0% | 0.0% | 0 | 0 | 1 |
| approvedBy | 0.0% | 0.0% | 0.0% | 0 | 0 | 1 |

## Per-Credential-Type Metrics

| Type | Entries | Macro F1 | Weighted F1 | Confidence Corr |
|------|---------|----------|-------------|-----------------|
| DEGREE | 2 | 0.0% | 0.0% | 0.000 |
| PROFESSIONAL | 1 | 0.0% | 0.0% | 0.000 |
| CLE | 2 | 0.0% | 0.0% | 0.000 |
| CERTIFICATE | 1 | 0.0% | 0.0% | 0.000 |
| MILITARY | 1 | 0.0% | 0.0% | 0.000 |
| LEGAL | 1 | 0.0% | 0.0% | 0.000 |
| IDENTITY | 1 | 0.0% | 0.0% | 0.000 |
| PUBLICATION | 1 | 0.0% | 0.0% | 0.000 |

## Worst-Performing Entries (Bottom 10)

| Entry | Type | Accuracy | Confidence | Errors |
|-------|------|----------|------------|--------|
| GD-1509 | CLE | 9% | 0% | credentialType: false_negative, issuerName: false_negative, issuedDate: false_negative, fieldOfStudy: false_negative, jurisdiction: false_negative, creditHours: false_negative, creditType: false_negative, activityNumber: false_negative, providerName: false_negative, approvedBy: false_negative |
| GD-497 | CLE | 13% | 0% | credentialType: false_negative, issuedDate: false_negative, fieldOfStudy: false_negative, accreditingBody: false_negative, jurisdiction: false_negative, creditHours: false_negative, creditType: false_negative |
| GD-001 | DEGREE | 14% | 0% | credentialType: false_negative, issuerName: false_negative, issuedDate: false_negative, fieldOfStudy: false_negative, degreeLevel: false_negative, jurisdiction: false_negative |
| GD-1241 | LEGAL | 14% | 0% | credentialType: false_negative, issuerName: false_negative, issuedDate: false_negative, fieldOfStudy: false_negative, licenseNumber: false_negative, jurisdiction: false_negative |
| GD-249 | PROFESSIONAL | 17% | 0% | credentialType: false_negative, issuerName: false_negative, issuedDate: false_negative, fieldOfStudy: false_negative, accreditingBody: false_negative |
| GD-745 | CERTIFICATE | 17% | 0% | credentialType: false_negative, issuerName: false_negative, issuedDate: false_negative, fieldOfStudy: false_negative, accreditingBody: false_negative |
| GD-1757 | DEGREE | 17% | 0% | credentialType: false_negative, issuerName: false_negative, issuedDate: false_negative, fieldOfStudy: false_negative, degreeLevel: false_negative |
| GD-993 | MILITARY | 20% | 0% | credentialType: false_negative, issuerName: false_negative, issuedDate: false_negative, jurisdiction: false_negative |
| GD-2284 | IDENTITY | 33% | 0% | credentialType: false_negative, jurisdiction: false_negative |
| GD-2536 | PUBLICATION | 50% | 0% | credentialType: false_negative |

## Confidence Calibration

| Confidence Bucket | Count | Mean Accuracy | Calibration Gap |
|-------------------|-------|---------------|-----------------|
| 0-30% | 10 | 20.3% | +5.3pp |
| 30-50% | 0 | — | — |
| 50-70% | 0 | — | — |
| 70-90% | 0 | — | — |
| 90-100% | 0 | — | — |