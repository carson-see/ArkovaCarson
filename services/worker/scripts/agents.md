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
- `pr<NNNN>-*-driver.ts` — **per-PR soak admission drivers.** One per PR whose changed behaviour needs its own evidence; `provision-isolated-rig.sh` names the chosen one in the admission JSON as `driver_path` + `driver_sha256`, and "driver_path or driver_sha256 mismatch" is a stop condition. They share one shape: `--self-test` (local, `evidenceForSoak=false`, never merge evidence) vs `--live` (admitted rig, appends one JSONL row per invocation), fail-closed on missing admission inputs, exit 1 when the row is not `pass`. **A driver measures ONE PR's changed behaviour** — reusing another PR's driver produces evidence about code this PR did not touch, which CLAUDE.md §1.12 does not accept.
  - `pr1408-chain-resilience-driver.ts` — PR #1408: bounded retry/backoff, 429 vs RPC-application-error classification, duplicate-tx semantics, transient→pending vs definitive→stale. Re-implements the classifier locally (the behaviour lives behind config).
  - `pr2524-proof-txinclusion-driver.ts` — PR #2524 (T3): the H1 sweep-cursor advance/wrap, the B0 `parseTxOutProof` fold guard against REAL `gettxoutproof`, the M3 batched `.in()` write across the 200-value `chunkForInFilter` cap, H3/H4 writer↔reader inclusion-pair coherence, and `/proof` emitting `tx_inclusion_branch` + `tx_block_index`. Unlike #1408's it IMPORTS the real `parseTxOutProof` / `foldTxInclusionBranch` / `chunkForInFilter` rather than copying them, so the assertions exercise shipped code; `chain/confirmation-proof.js` is imported DYNAMICALLY because its transitive `config.js` throws at module load without worker env. Needs the fixture from `scripts/staging/seed-proof-txinclusion-fixture.sql` (3,000 rows) — the standing rig's 10 anchors cannot exercise a cursor sweep or a chunked write at all. Its ONE non-GET database call is the per-cycle fixture re-arm, id-scoped and deny-checked; prod + shared staging are hard-denied by ref AND by Cloud Run service name, so it refuses to RUN, not merely to write. `runSelfTest()` proves the assertions DISCRIMINATE by running them against broken-build vectors and requiring failure.

- `audit-secured-chain-integrity.ts` (SCRUM-2486 AC-2) — **STRICTLY READ-ONLY** operator CLI that audits the SECURED anchor back-catalogue (~2.97M rows) for the chain-integrity invariant (every `status='SECURED'` row must have a non-blank `chain_tx_id`, a 64-hex `fingerprint`, and — where populated — a positive `chain_block_height`). Resolves explicit staging/admission credentials first (`STAGING_SUPABASE_URL` + `STAGING_SUPABASE_SERVICE_ROLE_KEY`, then `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) and falls back to the prod service-role client from Secret Manager (same pattern as `check-anchor-status.ts`). Prints the structured JSON summary. **NO write path** — reports violations + bounded sample ids, never mutates/backfills/fabricates. All logic lives in the injectable `src/jobs/auditSecuredChainIntegrity.ts` library (unit-tested with a fake client that THROWS on any write). NOTE: apply/soak + any prod run is DEFERRED to Sprint-4 — authored + unit-tested here, not run against prod by the authoring session.

## Constraints

- Never import these scripts from the worker runtime (`services/worker/src/`).
- Tests must mock LLM and Stripe calls — no real API calls in test runs.
- Budget guardrails (`--limit N`, `--dry-run`) are mandatory on scripts that spend provider budget.
