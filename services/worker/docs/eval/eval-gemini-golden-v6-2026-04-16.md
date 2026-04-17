# Gemini Golden v6 — Post-Eval Analysis

**Input:** `/Users/carson/Desktop/arkova-mvpcopy-main/services/worker/docs/eval/eval-gemini-2026-04-16T16-10-26.json`
**Provider:** gemini
**Eval timestamp:** 2026-04-16T16:10:26.742Z
**Entries evaluated:** 50

## Definition of Done

| Metric | Target | Actual | Pass |
|---|---|---|:---:|
| Macro F1 | ≥75% | 77.1% | ✅ |
| Weighted F1 | ≥80% | 83.6% | ✅ |
| p50 latency | <2s | 3.24s | ❌ |
| p95 latency | <3s | 4.93s | ❌ |
| subType emission (non-"other") | >80% | 88.0% | ✅ |
| description emission | 100% | 100.0% | ✅ |
| JSON parse success | 100% | 100.0% | ✅ |

**Overall verdict:** ❌ AT LEAST ONE DoD TARGET MISSED — hold cutover, investigate

## Latency distribution (ms)

| Percentile | Latency |
|---|---|
| p50 | 3.24s |
| p95 | 4.93s |
| p99 | 5.53s |
| mean | 3.38s |
| min | 1.63s |
| max | 5.53s |

## Overall extraction metrics

| Metric | Value |
|---|---|
| Macro F1 | 77.1% |
| Weighted F1 | 83.6% |
| Mean reported confidence | 51.9% |
| Mean actual accuracy | 81.1% |
| Confidence correlation (r) | 0.117 |

## subType emission by credentialType

| credentialType | Entries | Any subType | % | Non-"other" | % |
|---|---:|---:|---:|---:|---:|
| CERTIFICATE | 7 | 7 | 100% | 7 | 100% |
| DEGREE | 4 | 4 | 100% | 4 | 100% |
| PUBLICATION | 4 | 4 | 100% | 0 | 0% |
| BADGE | 3 | 3 | 100% | 3 | 100% |
| MEDICAL | 3 | 3 | 100% | 3 | 100% |
| IDENTITY | 3 | 3 | 100% | 3 | 100% |
| REGULATION | 3 | 3 | 100% | 3 | 100% |
| PROFESSIONAL | 2 | 2 | 100% | 2 | 100% |
| CLE | 2 | 2 | 100% | 2 | 100% |
| INSURANCE | 2 | 2 | 100% | 2 | 100% |
| LEGAL | 2 | 2 | 100% | 2 | 100% |
| ATTESTATION | 2 | 2 | 100% | 2 | 100% |
| PATENT | 2 | 2 | 100% | 2 | 100% |
| FINANCIAL | 2 | 2 | 100% | 2 | 100% |
| RESUME | 2 | 2 | 100% | 2 | 100% |
| TRANSCRIPT | 2 | 2 | 100% | 2 | 100% |
| OTHER | 1 | 1 | 100% | 0 | 0% |
| SEC_FILING | 1 | 1 | 100% | 1 | 100% |
| employment_screening | 1 | 1 | 100% | 1 | 100% |
| MILITARY | 1 | 1 | 100% | 1 | 100% |
| CHARITY | 1 | 1 | 100% | 0 | 0% |

## Per-credential-type F1

| credentialType | N | Macro F1 | Weighted F1 |
|---|---:|---:|---:|
| CERTIFICATE | 7 | 86.9% | 87.3% |
| DEGREE | 4 | 100.0% | 100.0% |
| PUBLICATION | 4 | 80.0% | 76.5% |
| BADGE | 3 | 68.0% | 78.0% |
| MEDICAL | 3 | 69.4% | 76.9% |
| IDENTITY | 3 | 55.6% | 72.2% |
| REGULATION | 3 | 57.8% | 74.3% |
| PROFESSIONAL | 2 | 95.2% | 97.0% |
| CLE | 2 | 95.8% | 97.8% |
| INSURANCE | 2 | 83.3% | 85.7% |
| LEGAL | 2 | 83.3% | 85.7% |
| ATTESTATION | 2 | 100.0% | 100.0% |
| PATENT | 2 | 100.0% | 100.0% |
| FINANCIAL | 2 | 73.3% | 77.8% |
| RESUME | 2 | 60.0% | 66.7% |
| TRANSCRIPT | 2 | 63.9% | 66.7% |
| OTHER | 1 | 100.0% | 100.0% |
| SEC_FILING | 1 | 75.0% | 75.0% |
| employment_screening | 1 | 75.0% | 75.0% |
| MILITARY | 1 | 50.0% | 50.0% |
| CHARITY | 1 | 50.0% | 50.0% |

## Sample subType + description outputs (first 5)

| entryId | credentialType | subType | description |
|---|---|---|---|
| GD-001 | DEGREE | `bachelor` | Bachelor's degree in Computer Science from University of Michigan, conferred 2025-05-03. |
| GD-050 | CERTIFICATE | `professional_certification` | Financial Analysis certification issued by CFA Institute on 2025-06-01. |
| GD-099 | CERTIFICATE | `it_certification` | Machine Learning Engineering certification issued by Google Cloud on 2026-01-01, valid through 2028-01-01. |
| GD-148 | DEGREE | `master` | Master's degree in Computer Science from King Abdullah University of Science and Technology, conferred 2025-12-01. |
| GD-197 | CERTIFICATE | `it_certification` | Professional Cloud Architect certification issued by Google Cloud on 2026-02-01, valid through 2028-02-01. |

## Failure cases (empty or missing fields)

All 50 entries returned non-empty extractedFields.

## Next step

Blocked on: p50, p95. Do NOT cut over. Keep v5-reasoning in production.
