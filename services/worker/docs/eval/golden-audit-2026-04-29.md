# Golden Distribution Audit

**Sources.** training-data/gemini-golden-train.jsonl, training-data/gemini-golden-validation.jsonl

**Acceptance gate.** ≥5000 rows, every type ≥30, fraud-positive ≥200

**Expected types.** ATTESTATION, BADGE, BUSINESS_ENTITY, CERTIFICATE, CHARITY, CLE, DEGREE, FINANCIAL, FINANCIAL_ADVISOR, IDENTITY, INSURANCE, LEGAL, LICENSE, MEDICAL, MILITARY, OTHER, PATENT, PROFESSIONAL, PUBLICATION, REGULATION, RESUME, SEC_FILING, TRANSCRIPT

**Verdict.** FAILED

## Summary

| Metric | Current | Target | Gap |
|---|---:|---:|---:|
| Total rows | 1460 | 5000 | +3540 |
| Fraud-positive entries | 53 | 200 | +147 |
| Types under 30-sample floor | 8 | 0 | 8 |
| Unparseable rows | 0 | 0 | 0 |

## Per-type distribution

| Type | Count | Status |
|---|---:|---|
| CERTIFICATE | 212 | OK |
| DEGREE | 160 | OK |
| LICENSE | 157 | OK |
| PROFESSIONAL | 95 | OK |
| BADGE | 94 | OK |
| SEC_FILING | 91 | OK |
| ATTESTATION | 88 | OK |
| LEGAL | 82 | OK |
| FINANCIAL | 58 | OK |
| OTHER | 57 | OK |
| PATENT | 57 | OK |
| CLE | 55 | OK |
| REGULATION | 49 | OK |
| INSURANCE | 47 | OK |
| PUBLICATION | 44 | OK |
| IDENTITY | 26 | UNDER (need +4) |
| TRANSCRIPT | 25 | UNDER (need +5) |
| MILITARY | 22 | UNDER (need +8) |
| MEDICAL | 21 | UNDER (need +9) |
| RESUME | 20 | UNDER (need +10) |
| BUSINESS_ENTITY | 0 | UNDER (need +30) |
| CHARITY | 0 | UNDER (need +30) |
| FINANCIAL_ADVISOR | 0 | UNDER (need +30) |

## Types under floor (sorted by deficit)

- **BUSINESS_ENTITY** — 0 / 30 (need +30)
- **CHARITY** — 0 / 30 (need +30)
- **FINANCIAL_ADVISOR** — 0 / 30 (need +30)
- **RESUME** — 20 / 30 (need +10)
- **MEDICAL** — 21 / 30 (need +9)
- **MILITARY** — 22 / 30 (need +8)
- **TRANSCRIPT** — 25 / 30 (need +5)
- **IDENTITY** — 26 / 30 (need +4)
