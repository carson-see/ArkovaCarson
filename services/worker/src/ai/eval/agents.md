# agents.md — services/worker/src/ai/eval/

_Last updated: 2026-05-16_

## 2026-05-20 Explicit Eval Gates

- `eval-gates.ts` owns SCRUM-1962 and SCRUM-1963 gate configuration. Gates fail closed when matching Phase 5 entries are missing, when aggregate weighted F1 is below threshold, or when required field-level F1 is below threshold.
- CPE entries are selected by the `cpe` tag. CLE entries are selected by `cle` tag and exclude `cpe` so continuing professional education does not satisfy the legal ethics-hours gate.

## What This Folder Contains

AI extraction evaluation framework — golden datasets, scoring engine, calibration, drift detection, and fraud eval. Measures precision/recall/F1 per field and per credential type across providers.

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export for the eval framework |
| `types.ts` | `GoldenDatasetEntry`, `FieldResult`, `EntryEvalResult`, `AggregateMetrics` types |
| `runner.ts` | Eval runner — executes extraction against golden dataset, computes metrics |
| `scoring.ts` | Scoring engine — field comparison, precision/recall/F1, aggregate metrics |
| `calibration.ts` | Confidence calibration analysis — bucketed, Pearson, ECE, isotonic regression |
| `golden-dataset.ts` | Base golden dataset with manually labeled ground truth entries |
| `golden-dataset-phase*.ts` | Phase-specific golden dataset expansions (phases 2-24) |
| `golden-dataset-subtype-backfill.ts` | Backfill sub-type labels across existing golden entries |
| `intelligence-eval.ts` | Nessie compliance intelligence eval — citation accuracy, faithfulness, relevance |
| `intelligence-eval-dataset.ts` | Test dataset for intelligence eval queries |
| `semantic-similarity.ts` | Embedding-based cosine similarity scoring (replaces keyword overlap) |
| `baseline-metrics.ts` | Stored metric baselines for regression detection |
| `drift-alert.ts` | Eval drift severity alerting (ok / warning / critical) |
| `eval-gates.ts` | Fail-closed merge gate evaluator for SCRUM-1962 CPE and SCRUM-1963 CLE ethics-hours thresholds |
| `calibration-regression.test.ts` | Regression tests for calibration stability |
| `fraud-eval-dataset.ts` | 100 adversarial examples (50 clean + 50 tampered) for fraud detection eval |
| `fraud-audit.ts` | CLI tool for false positive audit of FLAGGED integrity scores |
| `fraud-training-seed.ts` | 100+ hand-curated fraud patterns from enforcement actions for tuning |
| `fraud-holdout-set.ts` | 20 held-out entries (disjoint from training seed) for generalization F1 |
| `contract-recommendation-registry.ts` | Vetted recommendation URLs for reasoning golden set |
| `run-eval.ts` | CLI entry point for running eval suite |

## Do / Don't Rules

- **DO** run the eval suite before upgrading any model pin in `gemini-config.ts`
- **DO** keep the fraud holdout set strictly disjoint from training seed
- **DO NOT** add entries to both `fraud-training-seed.ts` and `fraud-holdout-set.ts`
