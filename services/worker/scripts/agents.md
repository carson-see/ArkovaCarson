# services/worker/scripts

Offline tooling for Nessie model training, evaluation, dataset building, benchmarks, operational helpers, and CI scripts. These scripts run outside the worker runtime — they are never imported by `services/worker/src/`.

## Soak drivers

- `pr3083-agent-suspend-keys-driver.ts` (+ `.test.ts`) — admission driver for PR #3083
  (`fix/agent-suspend-deactivates-keys`, T2). `scripts/staging/provision-isolated-rig.sh` DEFAULTS
  `driver_path` to `pr1408-chain-resilience-driver.ts` — using that default for this PR's soak would
  drive zero of the changed behavior. Set
  `STAGING_DRIVER_PATH=services/worker/scripts/pr3083-agent-suspend-keys-driver.ts` before
  provisioning. Drives 5 named assertions against `api/v1/agents.ts`'s `setAgentKeysActive` (suspend
  deactivates keys BEFORE the agent row flips, resume restores them AFTER) and `api/v1/keys.ts`'s
  reserved `admin:`/`computeid:` revocation-reason prefixes: a suspended agent's key is rejected (401)
  by a real authenticated endpoint (`POST /api/v1/oracle/verify`), a resumed agent's key authenticates
  again, a single zero-retry read immediately after the suspend response already shows the key
  deactivated (the nearest real substitute for the literal two-round-trip race — see the driver's own
  SCOPING NOTE for why the literal race is structurally unobservable from outside), a key already
  revoked FOR CAUSE under a `computeid:` marker is NEVER revived by an unrelated admin resume
  (NEGATIVE CONTROL), and a bare rename never touches keys. `--live` needs `--target-url` plus
  `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` (fixtures — one org, one
  ORG_ADMIN owner — are seeded/reused idempotently, keyed on the `pr3083-soak` prefix; the anon key
  signs the fixture user in for a real Supabase JWT bearer token, since `/api/v1/agents` is
  JWT-authenticated, not API-key-authenticated); default mode is `self-test`, whose rows are
  `evidenceForSoak: false` and must never be cited as soak evidence.

- `pr3084-drive-folder-cap-driver.ts` (+ `.test.ts`) — admission driver for PR #3084
  (`fix/drive-folder-cap-three`, T2). Same `STAGING_DRIVER_PATH` override requirement as above —
  set it to `services/worker/scripts/pr3084-drive-folder-cap-driver.ts`. Drives 4 named assertions
  against `rules/schemas.ts`'s `TriggerConfigWorkspaceFileModified` `superRefine`, all through the REAL
  `POST /admin/rules` HTTP API (never by importing the Zod schema directly — a direct API caller is
  exactly who the cap exists to stop): exactly 3 `drive_folders` (array shape) is accepted, 4 is
  rejected, the legacy `folder_id` + 3 array entries (4 bound total) is rejected (THE ACTUAL DEFECT the
  PR closes — an array-only `.max()` never sees the legacy shape at all), and `folder_id` + 2 array
  entries (3 bound total) is accepted (proving the fix bounds the TOTAL rather than banning the legacy
  shape outright). Fixture rules use a bare `AUTO_ANCHOR` action with no `tag`, so PR #3086's connector
  mirroring/adopt-vs-create race check never fires for them. `--live` needs `--target-url` plus
  `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`; default mode is `self-test`.

- `pr3086-drive-folder-mirror-driver.ts` (+ `.test.ts`) — admission driver for PR #3086
  (`feat/mirror-connected-drive-folders`, T2). Same override requirement — set
  `STAGING_DRIVER_PATH=services/worker/scripts/pr3086-drive-folder-mirror-driver.ts`. Drives 4 named
  assertions against the new eager mirror wired into `POST`/`PATCH /admin/rules`: saving a
  connector-managed (`action_config.tag='connector-google_drive'`) Drive rule with 2 `drive_folders`
  eventually mirrors exactly 2 `public.folders` rows (polled — mirroring is fire-and-forget); a re-save
  with the same folders creates no additional rows and no id churn (idempotent, reusing migration
  0462's unique index); the SAME `connector_source_id` connected under a SECOND, independent org
  mirrors into its OWN distinct row (tenant isolation, fails closed on any collision); and the
  review-added per-folder isolation (one folder's thrown exception must not suppress the others).
  - **Assertion 4 is NOT a live-rig probe and does NOT import PR #3086's production module.** This
    driver's own branch (`feat/t2-soak-drivers`) is based on `origin/main`, which does not contain
    `services/worker/src/integrations/connectors/drive-folder-mirror.ts` — that file exists only on
    PR #3086's own still-draft branch. Importing it would fail both typecheck and `tsx` invocation.
    Assertion 4 instead drives a LOCAL REIMPLEMENTATION (`driverMirrorFolders`, transcribed from the
    reviewed source at commit `3156a1e28`) of the exact per-item try/catch loop shape against a
    fault-injecting fake `upsertOne` — the same "reimplement locally, don't import the target PR's
    src" pattern `pr1408-chain-resilience-driver.ts` already uses. Re-diff it against the real
    `mirrorConnectedDriveFolders` loop body if PR #3086's head moves. It is real, independently-failable
    evidence for the ALGORITHM; it is not evidence that the actually-deployed rig has this shape.
  - `--live` needs `--target-url` plus `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` /
    `SUPABASE_ANON_KEY` (two org fixtures, `pr3086-soak-org-a` / `-org-b`, each with a seeded
    `org_integrations` google_drive connection — seeded directly rather than via a real OAuth round
    trip, the same idiom PR #3087's driver used for its own DS-04 bypass). Assertion 4 runs identically
    in both `self-test` and `--live` mode since it is rig-independent either way.

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
## PR #2442 concurrency verification

`check-credit-rollover-race.py` creates and removes its own network-isolated PostgreSQL 17 container. It executes the exact 0420 and 0434 check function bodies with a controlled two-session lock interleaving: the old function erases a committed debit, while 0434 preserves it. This verifies the SQL algorithm; it does not replace full Supabase staging evidence.
## PR #2476 rollout replay regression

`check-docusign-nonce-rollout.py` uses a disposable network-isolated PostgreSQL container. It verifies legacy-row replay denial, both orders of concurrent old/new writers across different session timezones, same-account deduplication, and acceptance for distinct known accounts. `--baseline` reproduces the replay gap in 0424 alone. No application database is touched.
## PR #2564 lock and flag evidence (2026-09-05)

`admin-rpc-0428-lock-probe.ts` uses independent persistent psql sessions for a synthetic holder row, RPC row and third innocent row. It confirms the held RowExclusive lock and observes the RPC's locks before starting the unrelated write; fixed sleeps never establish readiness. The RPC transaction stays open so the lock observation cannot miss a completed statement. A temporary, transaction-scoped PL/pgSQL function measures the UPDATE inside PostgreSQL before its relation-lock acquisition; `pg_locks.waitstart` and `pg_blocking_pids()` record the actual barrier chain. Every asynchronous result is checked and sessions are rolled back/closed. The 3-second database-execution ceiling remains; Management API latency is not used as lock-wait evidence.

The driver now invokes C1–C3 through actual PostgREST, holds C10's transaction until the concurrent rejection is observed, requires the independent C11 fixture row, and stops on any failed cycle or cleanup. `MAX_CYCLES=1` supports a supervisor supplying a fresh worker identity token each cycle; C11 runs on the first cycle. Direct connection settings are supplied through `RIG_DB_HOST`, `RIG_DB_PORT=5432`, `RIG_DB_USER`, `RIG_DB_PASSWORD`, and optional `RIG_DB_SSLROOTCERT` (default `system`); SSL verification is required. The named project must match the direct host or session-pooler user, and production/transaction-pooler/connection redirects are denied. `RIG_SERVICE_ROLE_KEY` is needed for the actual PostgREST calls. No production credentials belong in command arguments or evidence.

Before admission, seed only the dedicated `0428a11d-*` fixture identities, run the exact migration rollback/reapply rehearsal and inspect all asynchronous failure results. A local PostgreSQL reproduction is supporting evidence, not a 48-hour Supabase staging window. No stage, source, driver or dependencies may change after the shared release candidate's clock begins.

## PR #2572 — SCRUM-4878 rollup authorization regression

`test-suborg-rollup-authority.py --pg-bin PATH --output NEW_DIRECTORY` creates
and stops a private PostgreSQL cluster. `--baseline` reproduces the canonical
profile/platform administrator denial in immutable 0432. The default applies
0450 and checks both overloads, service-only ACLs, authority revocation,
unchanged balances and literal rollback/reapplication. Its declared focused
schema does not replace a full Supabase replay or hosted HTTP verification.

The output directory must resolve beneath the current working directory. Run
from the intended evidence parent; traversal or symlink escapes are rejected
before a cluster starts or any evidence file is written.


The CLI output contract is now a single directory name: 1–64 ASCII letters,
digits, underscores or hyphens, starting with a letter or digit. Run from the
evidence parent and pass `--output rollup-proof`; absolute paths, separators,
dot segments and existing paths/symlinks are rejected before cluster creation.
This keeps arbitrary path fragments out of filesystem writes and needs no
security-rule suppression.

## PR #2572 — qualification artifact links (2026-09-10)

The reviewed offline driver at source713a1f8d passed its10 CLI path controls
and27 PostgreSQL cases. Hosted CI separately passed
[TLA+ Verification](https://github.com/carson-see/ArkovaCarson/actions/runs/34533538903/job/103061153204)
and [Worker Build](https://github.com/carson-see/ArkovaCarson/actions/runs/34533538903/job/103061153030).
The [release record](https://arkova.atlassian.net/wiki/spaces/A/pages/137396545)
retains the local full-schema, authorization, concurrency and HTTP receipts.
Those scoped results do not claim that the still-running overall CI matrix
has passed. This documentation addition changes no runtime, SQL or Docker
input; the earlier713a qualification remains identified by its actual source.

Keep verification links in the release commit message as well as the PR body:
Mergify's initial speculative body may omit the source PR's artifact links,
while the HANDOFF claim gate also inspects the inherited commit messages.
