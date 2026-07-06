# agents.md — services/worker/src/ai/eval/

_Last updated: 2026-07-06_

## 2026-07-06 S3 CPE/CLE golden set + deterministic eval gate (AI-01/AI-02 — SCRUM-2381/2382)

- `golden-dataset-cpe-cle-s3.ts` — 60 synthetic labeled fixtures (30 CPE × 30 CLE), stratified/tagged: `clean` | `degraded-scan` × adversarial classes (`ambiguous-provider`, `near-duplicate-credits`, `fractional-hours`, `multi-credit`). 12-entry `held-out` split; `eval-gates.ts` excludes `held-out` from all merge gates. Counts + held-out fingerprints are version-pinned in `cpe-cle-s3-manifest.json` (regeneration-guarded by tests — regenerate the manifest whenever the dataset changes).
- `heldout-leakage.ts` — leakage control: SHA-256 fingerprints over normalized fixture text; `loadLeakageCorpus` scans `training-data/**` + `src/ai/**` (excluding the dataset/manifest/tests themselves) and the check FAILS on held-out content or id appearing in any committed prompt/few-shot/tuning corpus. NEVER add a held-out fixture (or its id) to a prompt or tuning export.
- `run-pe-gates.ts` gains `--dataset pe|s3`, a `fixture` provider mode (replays `recorded/s3-cpe-cle-recorded.json`, zero live model calls — the CI path), `--seed-recorded` (mock-echo seeding), and runs the leakage check as a fail-closed precondition of every s3 run. Gate `SCRUM-2382` in `eval-gates.ts`: aggregate weighted F1 ≥ 0.80 AND per-field floors (creditHours 0.85, issuedDate 0.80, credentialType 0.80), coverage hard-coded at 48. Reports emit field NAMES + scores only (value-omission is test-locked).
- `recorded/s3-cpe-cle-recorded.json` is a **mock-echo seed** (see `meta.note`) — it proves gate wiring determinism, NOT model quality. Replace via a nightly live-Gemini recording (run with `--provider gemini --dataset s3`, then record) before quoting the F1 as a model score. Held-out ids must never enter this committed file.
- npm scripts: `eval:s3-gate` (deterministic CI gate), `eval:s3-gate:seed` (re-seed after dataset changes).

## 2026-05-22 Professional Education Phase 5 Dataset

- `golden-dataset-professional-education.ts` owns SCRUM-1953 fixtures for CPE, CLE, and course-ID extraction coverage. Keep entries synthetic/PII-stripped and keep CPE/CLE/course-ID-only counts aligned with the 20-entry fail-closed gate minimums in `eval-gates.ts`.

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
| `golden-dataset-professional-education.ts` | Phase 5 professional education fixtures for SCRUM-1953/1962/1963 CPE, CLE, and course-ID coverage |
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