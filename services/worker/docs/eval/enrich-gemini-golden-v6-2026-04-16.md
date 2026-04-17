# Gemini Golden v6 — Dataset Enrichment Report

**Date:** 2026-04-16T18:52:31.442Z
**SCRUM:** [SCRUM-772](https://arkova.atlassian.net/browse/SCRUM-772)
**Total entries:** 2656
**Train:** 2391
**Validation:** 265

## What's new in v6

- **subType** field — fine-grained taxonomy under credentialType (e.g., `bachelor`, `nursing_rn`, `pmp`).
- **description** field — 1–2 sentence plain-English summary for customer reports.
- Removed reasoning/concerns/confidenceReasoning fields to cut inference latency.
- Target format: Vertex SFT JSONL for `gemini-2.5-flash` supervised tuning.

## subType source breakdown

| Source | Count | % |
|---|---:|---:|
| backfill | 213 | 8.0% |
| ground_truth | 76 | 2.9% |
| deduced | 1945 | 73.2% |
| other | 422 | 15.9% |

## Credential type distribution

| Type | Count |
|---|---:|
| CERTIFICATE | 239 |
| LICENSE | 209 |
| DEGREE | 207 |
| BADGE | 157 |
| ATTESTATION | 146 |
| FINANCIAL | 145 |
| RESUME | 142 |
| LEGAL | 141 |
| MEDICAL | 116 |
| CLE | 115 |
| PUBLICATION | 114 |
| TRANSCRIPT | 100 |
| IDENTITY | 97 |
| PATENT | 97 |
| PROFESSIONAL | 95 |
| SEC_FILING | 92 |
| OTHER | 90 |
| INSURANCE | 88 |
| MILITARY | 87 |
| REGULATION | 65 |
| CHARITY | 62 |
| BUSINESS_ENTITY | 32 |
| ACCREDITATION | 20 |

## Top 30 subType combinations

| credentialType:subType | Count |
|---|---:|
| `BADGE:educational_microcredential` | 138 |
| `CERTIFICATE:professional_certification` | 130 |
| `RESUME:resume` | 119 |
| `FINANCIAL:financial_statement` | 118 |
| `PUBLICATION:other` | 114 |
| `MEDICAL:medical_record` | 104 |
| `ATTESTATION:other` | 92 |
| `OTHER:other` | 90 |
| `DEGREE:bachelor` | 81 |
| `IDENTITY:government_id` | 79 |
| `PATENT:utility` | 77 |
| `MILITARY:service_record` | 74 |
| `CERTIFICATE:it_certification` | 73 |
| `DEGREE:master` | 72 |
| `TRANSCRIPT:official_undergraduate` | 70 |
| `PROFESSIONAL:membership` | 66 |
| `CLE:general_cle` | 62 |
| `LICENSE:general` | 60 |
| `INSURANCE:liability` | 57 |
| `LEGAL:contract` | 48 |
| `CHARITY:other` | 48 |
| `REGULATION:agency` | 40 |
| `LEGAL:court_opinion` | 39 |
| `DEGREE:doctorate` | 33 |
| `CLE:ethics_cle` | 31 |
| `LEGAL:other` | 30 |
| `LICENSE:medical_md` | 28 |
| `TRANSCRIPT:official_graduate` | 28 |
| `SEC_FILING:other` | 26 |
| `RESUME:cv` | 23 |

## Definition of Done (v6)

| Metric | Target | How verified |
|---|---|---|
| Macro F1 | ≥75% | 50-sample extraction eval (run-eval.ts) |
| Weighted F1 | ≥80% | 50-sample extraction eval |
| p50 latency | <2s | eval-latency-benchmark.ts on warm endpoint |
| p95 latency | <3s | eval-latency-benchmark.ts |
| subType emission rate (non-"other") | >80% | eval output analysis |
| description emission rate | 100% | eval output analysis |
| JSON parse success | 100% | eval output |

## Next steps

1. `gsutil cp training-output/gemini-golden-v6-vertex.jsonl gs://arkova-training-data/` (or use `--upload` flag)
2. Submit Vertex tuning job: `baseModel=gemini-2.5-flash`, `epochs=6`, `adapterSize=ADAPTER_SIZE_FOUR`
3. Eval with `run-eval.ts --provider gemini --sample 50` against the v6 endpoint
4. If DoD met: update Cloud Run `GEMINI_TUNED_MODEL` env var
5. Update Jira SCRUM-772 + Confluence page 11894785
