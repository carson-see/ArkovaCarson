# docs/staging/agents.md

Staging rig documentation and soak evidence artifacts. Required by CLAUDE.md 1.11/1.12.

## Files

- **`README.md`** — staging rig setup guide: Supabase preview branch, Cloud Run service, cost estimates.
- **`PR_TEMPLATE.md`** — risk-tiered staging evidence PR body template with tier matrix fields.
- **`train-c-soak-readiness-*.md`** — non-authoritative release-prep notes that freeze candidate heads, tier assumptions, merge order, and start gates before a real RC manifest exists. These files do not approve a soak or replace `rc-manifests/rc-*.json`.
- **`train-c-environment-request-*.md`** — approval-request notes for Train C environment isolation. These files do not create services, apply Scheduler jobs, change Supabase, deploy code, or start soak.
- **`train-c-*-lane-packet-*.md`** — lane-specific start packets with exact candidate heads, expected tag URL, deploy/smoke commands, start gates, and live attempt log.
- **`PATH_C_*.md`** — path-C cutover verification records.
- **`429-limiter-map-s33.md`** (L2-S0/L2-A, Sprint 3.3; Wave 3 refreshed) — the five-bucket 429 attribution map: every headline 429 emitter in the worker with in-tree-verified `file:line`, plus the mounted-but-excluded per-org and Nessie verified-payer limiters, safe upstream status/`Retry-After` preservation, pathname-only client evidence, and request-level coalescing by a worker-generated per-`withRetry` UUID. Retry attempts are unique, strictly increasing, and bounded per server request instance; sparse 429 attempt sets are valid because other statuses are absent, and client correlation reuse cannot collapse invocations. Monthly quota evidence requires keyed header `1000`. The map also defines the strict header+log/upstream-event attribution contract and unchanged exit-criterion-3a five-bucket list. Its `Claims ledger` table is machine-read by `scripts/ci/check-429-limiter-map.test.ts`, which fails CI when the tree drifts from the map.
- **`soak-pr*.json`** — machine-readable soak evidence for specific PRs.
- **`preflight-*.json`** — captured `staging-honesty-preflight.ts` JSON output for a named soak (e.g. `preflight-2026-08-launch-72h.json`), cited from the corresponding RC manifest's `environment.preflight_result` / a runbook's evidence-artifact list.
- **`rc-manifests/`** — see its own `README.md`. Batched T2/T3 release-candidate manifests (`rc-*.json`) that centralize long-soak evidence for multiple PRs at once; `rc-2026-08-launch-72h.json` is the draft master manifest for the 2026-08 launch wave (SCRUM-2980, `docs/release/72h-soak-runbook-2026-08.md`) — `approval_status: "pending"` until soak maturity, see its `_append_procedure` for how it's kept current as new sprint PRs open.
- **`staging-only-rpcs.sql`** — staging-specific RPCs (not applied to prod).
- **`staging_lease.sql`** — lease table DDL for the staging environment.
- **`evidence/`** — subdirectory of soak evidence screenshots and logs.
- **`ratelimit-soak-2026-08/`** — PR #2269 (rate-limit cluster, T2) soak attempt. `soak-standup-attempt-2026-08-19.md` + `diagnostic-2026-08-19.json` record a **stopped-before-deploy** attempt on 2026-08-19: the standing shared staging rig's Supabase project (`ujtlwnoqfhtitcmsnrpq`, CLAUDE.md 1.11 / `STAGING_RIG.md`) is absent from `list_projects`, DNS-NXDOMAIN, and the live `arkova-worker-staging` `/health` reports `checks.database: "error"`. **This blocks every shared-staging soak project-wide, not just this PR** — no soak was started, nothing was deployed, nothing was provisioned. Needs an operator decision (rebuild the rig vs. formally retire the shared-rig model) before any further T1/T2/T3 soak can use `ujtlwnoqfhtitcmsnrpq`.
- **`migration-t3-soak-2026-08/`** — the 48h migration-T3 wave soak (PRs #2219/#2235/#2248 on `rc/migration-t3-wave-2026-08`, rig `fizyjojbebyalirtjjht` / `arkova-staging-2026-08`, clock start 2026-08-20T14:00:22Z). `soak-start-2026-08-20.md` is the standup log. `FD-RETENTION-1-timeout-inversion.md` diagnoses the real BUG-019/0411 finding from that standup (retention cron 500s at ~8.2s, SQLSTATE 57014, instead of the designed 200-with-skip at ~5s under lock contention): read-only `pg_roles` comparison of rig vs prod ambient `statement_timeout`/`lock_timeout` shows this is a rig-provisioning-config artifact (rig `authenticator` 8s/8s vs prod 60s/30s), not currently reproducible in prod — verdict is **not prod-affecting**, clock does not restart, fix (add `SET LOCAL statement_timeout` inside 0411's audit-purge block, safely above its 5s `lock_timeout`) flagged as a follow-up compensating migration, not applied.

## Conventions

- T0 docs/tests/CI/tooling-only PRs need CI only; T1/T2/T3 prod-bound PRs must include a `## Staging Soak Evidence` block with the exact fields in `PR_TEMPLATE.md`.
- Soak JSON files are append-only evidence; do not modify after creation.
- These are engineering artifacts, not documentation (Confluence is the doc source of truth).

## 2026-08-22 — FD-SEED-1 FIXED in `seed-baseline-fixture.sql` (PR #2322)

- The 2026-08-21 entry below stands as the record of what was true that day. This one
  supersedes its **action item**: the seed file is fixed, so the manual "re-check after 10
  minutes" advice now applies only to rigs provisioned **before** this PR and not yet
  re-seeded.
- `scripts/staging/seed-baseline-fixture.sql` now writes the fixture anchor with a synthetic
  64-hex `chain_tx_id` (two `md5()` halves — deterministic, so re-runs stay idempotent)
  alongside the `legal_hold = true` it already had. That is what puts the row outside
  `recover_stuck_broadcasts()` (migration `0379`), which deliberately ignores `legal_hold`.
- **Re-running the seed repairs an older rig.** Its `ON CONFLICT (id) DO UPDATE` backfills a
  NULL `chain_tx_id` and reinstates a fixture `0379` already reclaimed to PENDING — but only
  when the row holds no txid of its own, so a row carrying a real txid keeps its own status.
  No teardown, no re-provision.
- **The seed asserts its own post-conditions** in a closing `DO $$ … $$` block: fixture
  present, SUBMITTED, `chain_tx_id` NOT NULL, on legal hold, and `ENABLE_VERIFICATION_API`
  enabled. `provision-isolated-rig.sh` runs it through `run_cmd` under `set -euo pipefail`,
  so a `RAISE` aborts provisioning before the clean_mirror preflight can certify a rig whose
  fixture is already doomed. No shell-side change was needed.
- Verified by execution against a throwaway Postgres carrying a verbatim copy of `0379`'s
  predicate: backdated 60 minutes and ticked three times, the reclaimer took 0 rows; reverted
  to the pre-fix shape it took the row on the first tick.

## 2026-08-21 — TRAIN-6 window RESTARTED; first window is VOID

- **`train6-2026-08/soak-start-2026-08-21T1854Z.md` is SUPERSEDED and must not be cited.**
  Its preflight returned `fixture_seeded` / exit 1 on the one check that matters for an
  anchor-lifecycle PR. The live window is
  `train6-2026-08/soak-start-2026-08-21T2038Z.md` — revision `00006-gik`, clock
  2026-08-21T20:33:58Z → 2026-08-23T20:33:58Z, preflight `clean_mirror` / exit 0.
- **`findings/FD-SEED-1-baseline-fixture-self-reverts-in-7-minutes.md`** — OPEN, systemic.
  `scripts/staging/seed-baseline-fixture.sql` seeds its SUBMITTED anchor with `chain_tx_id`
  NULL, which is exactly what `recover_stuck_broadcasts()` (migration `0379`) reclaims to
  PENDING every 2 minutes. **Every** rig seeded with that file fails preflight Check 5
  roughly 7 minutes after provisioning, so a provisioning-time preflight pass expires before
  most soaks even start. Until the seed file is fixed (`.sql`, needs a PR), re-check
  `count(*) where status='SUBMITTED'` on any rig **after** its first 10 minutes, not only at
  provisioning.
- A durable SUBMITTED fixture needs **both** `chain_tx_id` NOT NULL (excludes
  `recover_stuck_broadcasts`, which deliberately ignores `legal_hold`) **and**
  `legal_hold = true` (excludes `autoConfirmMockAnchors` / `monitorStuckTransactions` /
  `rebroadcastDroppedTransactions`). Either one alone is insufficient.

## 2026-07-28 — Two 72h signet soaks RUNNING (SCRUM-2980)

- **`SOAK-FINDINGS-2026-08.md`** — canonical findings log for the `launch-72h-2026-08` + `legacy-soak-2026-08` soak pair. Severity-ordered (F-1 through F-5, all open except the disclosed F-4 exception); full security detail lives in the Confluence bug tracker, not here.
- Two live soak rigs, do not disturb (frozen soak evidence):

  | Soak | Cloud Run rev | Clock start (UTC) | Clears (EST) |
  |---|---|---|---|
  | launch-72h-2026-08 | `00004-qgj` | 2026-07-28T19:43:55Z | Fri 07-31 3:43 PM |
  | legacy-soak-2026-08 | `00002-4sr` | 2026-07-28T21:32:17Z | Fri 07-31 5:32 PM |

  See HANDOFF.md's 2026-07-28 evening entry for the full soak table (Supabase project refs, frozen head SHAs).

## 2026-07-15 S3.3 Wave 3 Lane 2

- `429-limiter-map-s33.md` now records per-org and Nessie payer limiters as
  mounted-but-excluded from the unchanged five headline soak buckets.
- `s33-w3-l2-security-review.md` is changed-file/offline-test evidence only.
  It records the non-atomic cross-instance capacity residual and must never be
  represented as staging, soak, production, or release proof.
