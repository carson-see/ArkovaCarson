# services/worker/scripts

Offline tooling for Nessie model training, evaluation, dataset building, benchmarks, operational helpers, and CI scripts. These scripts run outside the worker runtime — they are never imported by `services/worker/src/`.

## Soak drivers

- `pr2525-attestation-park-driver.ts` (+ `.test.ts`) — admission driver for the PR #2525 attestation
  park. Probes `GET /api/v1/verify/attestation/:id` and asserts the one behavior that PR changes:
  404 well-formed / 400 malformed with the `ARK-ATT` routing hint, never an APPLICATION 5xx, and
  `X-RateLimit-*` still present (the header is how the soak observes the middleware POSITION — a park
  mounted above the rate limiters answers correctly while silently off its §1.10 budget). `--live`
  needs `--target-url`; default `--dry-run`-equivalent is `self-test`, whose rows are
  `evidenceForSoak: false` and must never be cited as soak evidence.
  - **Capacity is not behavior.** Cloud Run refuses requests on a scaled-to-zero rig with a 500 and
    "no available instance"; a transport failure yields status 0. `isObserved()` excludes both, so
    neither is scored as an application regression — and a cycle where nothing was observed fails
    loudly rather than recording a hollow pass. That conflation invalidated the first soak window.

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


## 2026-09-05 — PR #2565 owned PostgreSQL regression harness

`test-docusign-backfill-attempts.py --pg-bin PATH --output NEW_DIRECTORY` creates a private PostgreSQL cluster via `lib/local_postgres.py`, uses a private Unix socket, loads the actual0438 SQL and tests role authority plus real concurrent attempt claims. It refuses an existing output directory and always stops its owned cluster. It does not use a running database or spend provider budget. The small fixture schema is explicit focused evidence; it is not a full-schema replay, generated-types proof or staging soak.
## PR #2564 lock and flag evidence (2026-09-05)

`admin-rpc-0428-lock-probe.ts` uses independent persistent psql sessions for a synthetic holder row, RPC row and third innocent row. It confirms the held RowExclusive lock and observes the RPC's locks before starting the unrelated write; fixed sleeps never establish readiness. The RPC transaction stays open so the lock observation cannot miss a completed statement. A temporary, transaction-scoped PL/pgSQL function measures the UPDATE inside PostgreSQL before its relation-lock acquisition; `pg_locks.waitstart` and `pg_blocking_pids()` record the actual barrier chain. Every asynchronous result is checked and sessions are rolled back/closed. The 3-second database-execution ceiling remains; Management API latency is not used as lock-wait evidence.

The driver now invokes C1–C3 through actual PostgREST, holds C10's transaction until the concurrent rejection is observed, requires the independent C11 fixture row, and stops on any failed cycle or cleanup. `MAX_CYCLES=1` supports a supervisor supplying a fresh worker identity token each cycle; C11 runs on the first cycle. Direct connection settings are supplied through `RIG_DB_HOST`, `RIG_DB_PORT=5432`, `RIG_DB_USER`, `RIG_DB_PASSWORD`, and optional `RIG_DB_SSLROOTCERT` (default `system`); SSL verification is required. The named project must match the direct host or session-pooler user, and production/transaction-pooler/connection redirects are denied. `RIG_SERVICE_ROLE_KEY` is needed for the actual PostgREST calls. No production credentials belong in command arguments or evidence.

Before admission, seed only the dedicated `0428a11d-*` fixture identities, run the exact migration rollback/reapply rehearsal and inspect all asynchronous failure results. A local PostgreSQL reproduction is supporting evidence, not a 48-hour Supabase staging window. No stage, source, driver or dependencies may change after the shared release candidate's clock begins.
