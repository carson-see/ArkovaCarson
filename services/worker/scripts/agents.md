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
  - **Independent-review fixes (this PR):** (1) the rename probe now requires the rename PATCH to
    have actually returned 200 before asserting keys were preserved — a rejected request trivially
    satisfies "unchanged" and was a false-positive hole. (2) `--live` mode now signs the fixture user
    in FRESH every cycle instead of once before the soak loop; a single token with
    `autoRefreshToken:false` expires mid-soak and every later cycle 401s — the exact cascade that
    killed a prior night's run. (3) a failed probe anywhere in a `--live` run now sets
    `process.exitCode = 1` at the end of the run, the same way `--self-test` already does — previously
    the CLI exited 0 with failed probes buried in the JSONL.

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
  - **Independent-review fixes (this PR):** same two `--live`-mode fixes as pr3083's driver above —
    a fresh fixture sign-in every cycle (not one token before the loop) and `process.exitCode = 1` on
    any failed probe across the whole run.

- `pr3086-drive-folder-mirror-driver.ts` (+ `.test.ts`) — admission driver for PR #3086
  (`feat/mirror-connected-drive-folders`, T2). Same override requirement — set
  `STAGING_DRIVER_PATH=services/worker/scripts/pr3086-drive-folder-mirror-driver.ts`. Drives 4 named
  assertions against the new eager mirror wired into `POST`/`PATCH /admin/rules`: saving a
  connector-managed (`action_config.tag='connector-google_drive'`) Drive rule with 2 `drive_folders`
  eventually mirrors exactly 2 `public.folders` rows (polled — mirroring is fire-and-forget); a re-save
  with the same folders creates no additional rows and no id churn (idempotent, reusing migration
  0462's unique index); the SAME `connector_source_id` connected under a SECOND, independent org
  mirrors into its OWN distinct row (tenant isolation, fails closed on any collision); and the
  review-added per-folder isolation (one folder's thrown exception must not suppress the others). The
  re-save PATCH must itself have returned 200 before the "unchanged folder set" is asserted —
  independent-review fix, see below.
  - **Assertion 4 fault-injects the REAL, vendored `mirrorConnectedDriveFolders` (independent-review
    fix — it previously drove a local reimplementation).** PR #3086 (`feat/mirror-connected-drive-
    folders`) is still open/unmerged, so `services/worker/src/integrations/connectors/
    drive-folder-mirror.ts` does not exist on this branch's own `src/` tree — importing it from there
    fails both typecheck and `tsx` invocation. The fix: the real file is vendored byte-for-byte into
    `services/worker/scripts/vendor/pr3086-drive-folder-mirror.ts` (see that file's own header for
    provenance, the exact source commit, and the re-sync procedure), and assertion 4 imports
    `mirrorConnectedDriveFolders` from THAT copy, fault-injecting it via a fake `DriveFolderMirrorDb`
    (`buildFaultInjectingMirrorDb`) whose `folders` insert throws a genuine JS exception for exactly
    one folder id — the real function's real per-iteration try/catch under test via its own injected
    dependency seam, not a parallel reimplementation that can silently drift. When PR #3086 merges,
    delete the vendor file and import the real, now-merged path directly instead. A self-test check
    (`..._fault_injection_is_real`) proves the fake db itself actually throws, so a vacuous pass is
    caught.
  - `--live` needs `--target-url` plus `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` /
    `SUPABASE_ANON_KEY` (two org fixtures, `pr3086-soak-org-a` / `-org-b`, each with a seeded
    `org_integrations` google_drive connection — seeded directly rather than via a real OAuth round
    trip, the same idiom PR #3087's driver used for its own DS-04 bypass). Assertion 4 runs identically
    in both `self-test` and `--live` mode since it is rig-independent either way.
  - **Independent-review fixes (this PR):** in addition to the assertion-4 real-import fix above,
    `--live` mode now signs BOTH org fixture users in fresh every cycle instead of once before the
    loop (the same expired-token cascade fixed in pr3083/pr3084's drivers), and a failed probe anywhere
    in a `--live` run now sets `process.exitCode = 1` at the end of the run.
- `pr3087-supersede-drain-driver.ts` (+ `.test.ts`) — admission driver for PR #3087
  (`fix/connector-supersede-not-duplicate`, T3). `scripts/staging/provision-isolated-rig.sh` DEFAULTS
  `driver_path` to `pr1408-chain-resilience-driver.ts` — using that default for this PR's soak would
  drive zero of the changed behavior. Set `STAGING_DRIVER_PATH=services/worker/scripts/pr3087-supersede-drain-driver.ts`
  before provisioning. Drives 8 named assertions (`ASSERTION` export) against
  `services/worker/src/jobs/connector-artifact-drain.ts`'s supersede-not-duplicate fix and
  `services/worker/src/api/v1/provenance.ts`'s `credential_superseded`-not-`credential_revoked` fix:
  supersede-not-revoke, parent/version lineage, `/api/v1/verify/:publicId` still answering 200/SUPERSEDED
  (not 404, not REVOKED), the provenance P0 (never `credential_revoked` for a SUPERSEDED anchor),
  idempotent replay of the same `(source, external_ref, external_revision)`, a no-op on an unchanged
  fingerprint, a NEGATIVE CONTROL proving DocuSign still double-anchors (the `google_drive`-only gate is
  real, not just a code comment), and a non-`ORG_ADMIN`-member-owned prior anchor still superseding via
  an independently-resolved org-admin actor. `--live` needs `--target-url` plus `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` (fixtures — one org, one ORG_ADMIN owner, one plain ORG_MEMBER — are
  seeded/reused idempotently by the driver itself, keyed on the `pr3087-soak` prefix); default mode is
  `self-test`, whose rows are `evidenceForSoak: false` and must never be cited as soak evidence.
  - **Assertion 8's scope is narrower than its name suggests — read the driver's own header
    ("SCOPING NOTE") before citing it as DS-04 coverage.** `queue_scope: 'member'` is set only by the
    DocuSign producers, and `member_integrations.provider` is `CHECK (provider = 'docusign')` (migration
    0320) — so a `source='google_drive'` artifact can never pass the v1 DS-04 member-scope check
    (migration 0462). Since supersession is gated to `google_drive` only, the literal combination in the
    task ("a `queue_scope: 'member'` google_drive connection") is structurally unreachable today. The
    driver instead seeds a prior anchor directly with `user_id` = a real non-`ORG_ADMIN` member (the
    supersede branch reads the anchor's own `user_id`/`status`, never how it was created) and drives the
    real update through the real HTTP drain endpoint — proving the actor-independence fix
    (`supersedeConnectorAnchor` resolves its own org-admin caller via `resolveOrgActorUserId`,
    independently of the anchor's owner) without depending on the unrelated, DocuSign-only DS-04 v1 gate.
  - **Never scores a stuck artifact a pass on "no error surfaced."**
    `supersedeConnectorAnchor` maps every `supersede_anchor` RPC error (wrong caller, already
    REVOKED/SUPERSEDED, a genuine transport error) to the same generic `{ outcome: 'lost_lease' }` —
    indistinguishable from outside the worker. `classifyMemberOwnedSupersede` requires POSITIVE polled
    evidence (`connector_artifact.status === 'materialized'` + a concretely-lineaged child anchor) and
    names the ambiguity explicitly in its failure detail rather than defaulting to a pass.
  - Tier detector (`requiredTierFor()` in `scripts/ci/check-staging-evidence.ts`) run on this file +
    its test: **T1** ("default frontend / additive change" — the fallback default; `services/worker/scripts/`
    is not in the detector's T0 allowlist, so a driver file here needs a draft PR under §1.12, not a
    direct push).
  - **Independent-review fixes (this driver merged into `feat/t2-soak-drivers` from its own former PR
    #3099):** (1) the identical-fingerprint no-op probe (assertion 6) previously enqueued, drained,
    slept a fixed 3s, and read the anchor table — pending/failed/still-unprocessed work satisfies that
    same observation just as readily as a genuine no-op. It now captures the enqueued artifact's id and
    polls `connector_artifact.status` for a TERMINAL result (`materialized` or `failed`) before
    asserting anything about the head anchor; a non-terminal result after bounded polling is now its
    own explicit failed probe. (2) the fixture used FIXED 64-hex fingerprint constants
    (`HASH_A`/`HASH_B`/`HASH_C`) across every cycle, but `anchors` carries a partial UNIQUE INDEX on
    `(user_id, fingerprint) WHERE deleted_at IS NULL` — both `seedPriorAnchor` call sites reuse the SAME
    fixture user every cycle, so a fixed fingerprint collided with the still-live row from the previous
    cycle: `duplicate key value violates unique constraint`, reproducibly, on every cycle after the
    first (the 47/47-failure incident). `cycleFingerprint(letter, cycle)` now derives a per-cycle-unique
    64-hex fingerprint. (3) same exit-status fix as the other three drivers above — `process.exitCode`
    is now set on the aggregate result of a `--live` run. (4) added an integration-style test suite
    (`defaultMaterializeAnchor (real production code, injected deps) — integration-style`) that imports
    the REAL, now-merged `defaultMaterializeAnchor` from `services/worker/src/jobs/
    connector-artifact-drain.ts` and drives it with an injected fake `db` (supersession success,
    fail-closed on a REVOKED prior anchor with `supersede_anchor` never called, and the no-prior-anchor
    fallback) — previously every test in this file validated hand-constructed classifier inputs, never
    an execution of the production materializer itself.

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

## PR #3092 — SonarCloud quality-gate remediation on the four soak drivers

The four T2/T3 soak drivers above (pr3083/pr3084/pr3086/pr3087) failed the SonarCloud quality gate on
`feat/t2-soak-drivers`: 16.9% New Code duplication (gate: <=3%), plus Reliability/Security C ratings.
Fixed without changing behavior (every driver's existing test file and `--self-test` still pass):

- **Duplication.** The four drivers hand-rolled identical CLI parsing, evidence-row emission, Supabase
  credential resolution, fixture-user creation/sign-in, and the live-mode cycle loop. Extracted into
  `scripts/lib/soak-driver-harness.ts` (see that directory's own `agents.md` for the full export list) —
  each driver now imports the shared implementation instead of repeating it, and `services/worker/
  scripts/vendor/**` (the pr3086 vendored file, necessarily near-duplicate of its still-unmerged source)
  is excluded from CPD in `.sonarcloud.properties`'s `sonar.cpd.exclusions`.
- **S3776 cognitive complexity (each driver's own `main()`, one per file).** The deadline-tracking/
  per-cycle-try-catch/exit-status loop moved into the harness's `runLiveLoop`; each `main()` now just
  wires its own fixture setup and row-building into that call instead of containing the loop.
- **S8786 (superlinear regex) + tssecurity S8476/S7044 (CSRF / API traversal on an unsanitized-looking
  URL).** All four drivers built request URLs as `` `${targetUrl.replace(/\/+$/, '')}${path}` `` — string
  concatenation after a regex trim. Replaced with the harness's `buildRequestUrl`/`fetchJson`, which parse
  `targetUrl` with `new URL()`, allowlist the scheme, and join a fixed, string-literal `path` via
  `new URL(path, base)` — never a concatenated string.
- **S6959 (`reduce()` without an initial value)**, pr3087's two `headBefore`/`headAfter` version-number
  lookups — now seeded with the array's own first element.
- **S7785 (prefer top-level await)**, all four drivers' `main().catch(...)` entrypoint — replaced with
  `try { await main(); } catch { ... }` (the module target is ES2022/NodeNext, so top-level await is
  available).
- **S4624 (nested template literal)**, pr3086's `classifyPartialFailureIsolation` — the inner
  `others.map(...).join(...)` is now a named local before the outer template.
- **S7778 (multiple sequential `push()`)**, pr3086 and pr3087 — combined into a single `probes.push(a, b)`
  call at each site.
- **S5906 (prefer `toHaveLength`)**, `pr3084-drive-folder-cap-driver.test.ts` — `.length).toBe(n)` ->
  `expect(arr).toHaveLength(n)`.
- **NOT created: `sonar-project.properties`.** This project runs SonarCloud Automatic Analysis, which
  reads `.sonarcloud.properties` only — a root `sonar-project.properties` was deleted 2026-08-01
  specifically because autoscan never read it (see that file's own header). Creating one here would have
  been silently inert, exactly the failure mode that file documents. The CPD exclusion for
  `services/worker/scripts/vendor/**` was added to the existing `.sonarcloud.properties`'s
  `sonar.cpd.exclusions` instead.

## Key subdirectories

- `bench/` — Regional latency benchmarks (Kenya, etc.).
- `benchmark/` — LLM-as-judge benchmark runner (NVI-12).
- `ci/` — CI helper scripts (Confluence DoD checker).
- `common/` — Shared API clients (Anthropic, Together) and concurrency helpers.
- `distillation/` — NVI-07 Opus teacher distillation pipeline.
- `intelligence-dataset/` — Compliance scenario datasets, evals, and source registries (FCRA/FERPA/HIPAA/KAU/NDD/NPH/NTF).
- `lib/` — Shared math utilities (percentile, stats).
- `load-test/` — k6 load-test profiles for SCALE-02.
- `vendor/` — Byte-for-byte copies of still-unmerged production source, vendored ONLY so a soak
  driver can fault-inject the REAL target function via its own injected deps instead of a local
  reimplementation. Each file's own header names its source PR/commit and the re-sync/delete
  procedure for when that PR merges. Never import from here into anything under `src/`.
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
