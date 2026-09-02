# services/worker/scripts

Offline tooling for Nessie model training, evaluation, dataset building, benchmarks, operational helpers, and CI scripts. These scripts run outside the worker runtime — they are never imported by `services/worker/src/`.

## Soak drivers

- `rc-batch-0902-driver.ts` (+ `.test.ts`) — **batched T2 admission driver for `rc/soak-batch-2026-09-02`**
  (RC head `78621249`, four PR heads merged onto `origin/main`). One rig, one 12h window, one row per
  invocation covering three PRs; #2528 (frontend-only) is covered by
  `e2e/rc-batch-0902-frontend-evidence.spec.ts`, not here. Assertions, each stating what a pass PROVES:
  - **#2527 (A27_0–A27_7)** — every seeded cohort of `scripts/staging/seed-rc-batch-0902-fixture.sql`
    is served by `/api/v1/verify/:publicId/proof`; on EVERY response `verdict` is one of three values,
    `invalid <=> verified===false`, and `verdict_note` is the canonical note; a-valid/b-valid answer
    `valid` with a complete bundle whose 80-byte header hashes to the real block hash; a-invalid
    answers `invalid` and the driver's OWN re-fold confirms the branch does not reach the root;
    a-legacy (no `merkle_index`) answers `unverifiable`, never `valid`; a-uninspected (empty branch
    under a 2-leaf claim) and a-overlong (branch longer than the tree) answer `unverifiable` — the
    `isStructuralGuardEffective` rule that distinguishes this head from the superseded RC
    `557e485a`, which said `valid`; the driver's independent double-SHA256 re-fold agrees with
    `verified` in both directions on every row; org-A ids never answer with org-B fingerprints.
  - **#2525 (A25_0–A25_5)** — the attestation route is PARKED on this build, so the driver proves
    the park over a POPULATED `legally_binding_attestations` table (ten rows, five statuses, two
    orgs, natural-person + notary PII on each): every well-formed id — seeded, nonexistent, burst —
    answers 404 with a byte-identical body (no existence oracle, no "not found" claim); PR #2525's
    own `classify()` (imported) accepts the pair; `X-RateLimit-*` on every response (the park sits
    BELOW the limiters); never an application 5xx (Cloud Run capacity refusals named, not blamed);
    and **K4**: none of the PII literals or sensitive keys appears on ANY byte of ANY response —
    status line, headers, body. The disclosure handler itself is unreachable and is stated as NOT
    asserted.
  - **#2526 (A26_1–A26_3)** — the worker boots and serves `/api/health` at the RC head;
    `SCHEDULER_MANIFEST` (static import) registers `detect-reorgs` enabled, POST, `*/10`, with a
    **30-minute** budget below the ~50-minute reorg-check coverage band; `POST /jobs/detect-reorgs`
    answers 200 with a well-formed `{checked, reorgsDetected, reverted}`. No dead-man assertion is
    fabricated: the silence signal has no producer and neither consumer has a live trigger.
  - **K1** refuses to run unless `/api/health.git_sha` equals the RC head (`--expected-git-sha`)
    and the admission JSON agrees. **K2** every row carries runId/cycle/window/withinDeclaredWindow;
    no wall-clock in any assertion. **K3** prod, the current AND retired shared-staging refs, the
    R1 rig (`uqobkjhlnqmcpjidngxr`, T3 in flight) and the docusign-bilateral rig are denied by ref;
    shared/prod/soaking Cloud Run services by EXACT name; the target is positively bound to the
    admission JSON's own `cloud_run_service` + `supabase_project_ref` (the R1 rig's service NAME is
    not in the repo — add it with `--deny-service` / `RIG_DENY_SERVICES`). **Read-only**: every
    database call is a PostgREST GET; the only non-GET request is the cron POST the manifest names.
  - `runSelfTest()` proves every evaluator DISCRIMINATES: a pre-#2527 build, the superseded RC head,
    contradictions, a fourth verdict value, a reworded note, a laundered failure, a forged header, an
    unparked route, an oracle body, a park above the limiters, PII in a HEADER, an app 5xx, a manifest
    without the entry or with the peers' 1h budget, a job 500/401/malformed, a wrong SHA — each must
    FAIL. The test also runs every cohort through the REAL `buildProofResponse`.
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
