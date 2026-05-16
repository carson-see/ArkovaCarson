# services/worker/scripts

Offline tooling for Nessie model training, evaluation, dataset building, benchmarks, operational helpers, and CI scripts. These scripts run outside the worker runtime — they are never imported by `services/worker/src/`.

## Key subdirectories

- `bench/` — Regional latency benchmarks (Kenya, etc.).
- `benchmark/` — LLM-as-judge benchmark runner (NVI-12).
- `ci/` — CI helper scripts (Confluence DoD checker).
- `common/` — Shared API clients (Anthropic, Together) and concurrency helpers.
- `distillation/` — NVI-07 Opus teacher distillation pipeline.
- `intelligence-dataset/` — Compliance scenario datasets, evals, and source registries (FCRA/FERPA/HIPAA/KAU/NDD/NPH/NTF).
- `lib/` — Shared math utilities (percentile, stats).
- `load-test/` — k6 load-test profiles for SCALE-02.
- `ops/` — Operator-run production/sandbox verification scripts.

## Top-level scripts (selected)

- `nessie-*.ts` — Nessie model training, export, DPO, distillation, and LoRA pipeline drivers.
- `eval-*.ts` — Model evaluation harnesses (intelligence, fraud, latency, embedding).
- `build-*-dataset.ts` — Dataset builders for domain and FCRA intelligence corpora.
- `smoke-test*.ts` — Smoke tests for model endpoints.
- `derive-*.ts` — Calibration-knot and per-type calibration derivation scripts.

## Constraints

- Never import these scripts from the worker runtime (`services/worker/src/`).
- Tests must mock LLM and Stripe calls — no real API calls in test runs.
- Budget guardrails (`--limit N`, `--dry-run`) are mandatory on scripts that spend provider budget.
