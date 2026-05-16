# services/worker/scripts/intelligence-dataset/nph

NPH-14 (SCRUM-711) Nessie v8 retrain evaluation gates. Pure gate logic that decides whether a v8 training run is deploy-ready.

## Files

- `v8-eval-gates.ts` — 7 eval gates mirroring `docs/plans/nessie-training-parameters-v8.md`. Takes measured metrics (macroF1, weightedF1, confidenceCorrelation, fraudSignalsF1, ECE) and returns pass/fail breakdown. No LLM calls, no network I/O.
- `v8-eval-gates.test.ts` — Tests for all gate pass/fail branches.

## Constraints

- Gates are written before the tuning job is submitted so acceptance criteria are executable the moment weights land.
- NVI gate closure required before any training run.
