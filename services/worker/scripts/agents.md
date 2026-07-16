# services/worker/scripts

Offline tooling for Nessie model training, evaluation, dataset building, benchmarks, operational helpers, and CI scripts. These scripts run outside the worker runtime — they are never imported by `services/worker/src/`.

## S3.3 v7.1 deterministic surgery (2026-07-15)

- `s33-v71-surgery.ts` binds the historical April v7 source at 2,656 unique
  rows and fails closed on source count/order/content drift. It removes exactly
  `GD-3030..GD-3044`, splits all 201 fraud-signal rows into a non-submittable
  artifact, accepts only valid explicit subtypes or one unambiguous frozen-
  taxonomy deduction, and keeps all other rows unresolved.
- The only manual adjudication is immutable source row `GD-1920`, mapped to
  `BUSINESS_ENTITY/corporation` from its literal `entityType=Corporation` and
  recorded as `adjudicated`; do not mutate the raw row, expand the taxonomy, or
  generalize that exception. Exact retained composition is 37 ground-truth +
  186 backfill + 737 deduced + 1 adjudicated = 961.
- Split is source-order input followed by LCG Fisher-Yates seed `4216`: first
  floor(961 x 0.10) = 96 validation, remaining 865 training. Source,
  disposition, targets, split JSONL, fraud, unresolved, and manifest digests
  are frozen in code and tests. The separate 621-row accepted corpus is
  heldout-only and is never a training-count target.
- `goodStandingStatus` must already be a non-empty source string; boolean
  coercion is forbidden. G02 remains non-vacuous through adjudicated GD-1920.
- `writeS33V71OfflineArtifacts()` writes a new local directory once using
  atomic file replacement. It has no GCS upload, Vertex submit, endpoint,
  deployment, or spend path. `buildS33V71TuningRequestTemplate()` is an inert
  HOLD artifact with Gemini 2.5 Flash, six epochs, adapter size four, learning
  rate 1, `exportLastCheckpointOnly=true`, and a $40 ceiling; it never submits.

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
- `audit-secured-chain-integrity.ts` (SCRUM-2486 AC-2) — **STRICTLY READ-ONLY** operator CLI that audits the SECURED anchor back-catalogue (~2.97M rows) for the chain-integrity invariant (every `status='SECURED'` row must have a non-blank `chain_tx_id`, a 64-hex `fingerprint`, and — where populated — a positive `chain_block_height`). Resolves explicit staging/admission credentials first (`STAGING_SUPABASE_URL` + `STAGING_SUPABASE_SERVICE_ROLE_KEY`, then `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) and falls back to the prod service-role client from Secret Manager (same pattern as `check-anchor-status.ts`). Prints the structured JSON summary. **NO write path** — reports violations + bounded sample ids, never mutates/backfills/fabricates. All logic lives in the injectable `src/jobs/auditSecuredChainIntegrity.ts` library (unit-tested with a fake client that THROWS on any write). NOTE: apply/soak + any prod run is DEFERRED to Sprint-4 — authored + unit-tested here, not run against prod by the authoring session.

## Constraints

- Never import these scripts from the worker runtime (`services/worker/src/`).
- Tests must mock LLM and Stripe calls — no real API calls in test runs.
- Budget guardrails (`--limit N`, `--dry-run`) are mandatory on scripts that spend provider budget.
