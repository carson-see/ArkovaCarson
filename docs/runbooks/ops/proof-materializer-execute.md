# SCRUM-2917 — Proof materializer prod EXECUTE runbook

> **INTERNAL ENGINEERING NOTE** — system of record is Confluence (Doc Update
> Matrix: On-Chain Policy page) once this is copied over per CLAUDE.md §1.2/§4.
> This file is the in-repo operational runbook Carson/CTO/RTE follow when
> actually running the backfill. **Nothing in this document performs the
> EXECUTE run.** Writing this runbook does not start a soak, does not flip a
> flag, and does not insert a single row. The prod EXECUTE itself remains a
> founder/CTO-scheduled action, deliberately gated behind the preconditions
> below (ratified sprint plan, "Deliberately excluded" list: "materializer
> prod EXECUTE scheduling" is a founder-reserved gate).

Scope: `POST /jobs/materialize-proof-backcatalog` (`services/worker/src/routes/cron.ts`)
→ `runProofMaterializer()` (`services/worker/src/jobs/proof-materializer.ts`,
PR #1615, SCRUM-2917, CTO ruling Confluence 110198785). Populates an honest
4-column skeleton `anchor_proofs` row for every classifier-`direct_anchored`
prod anchor that currently has none — DoR baseline (2026-07-21, read-only):
~2,962,154 anchors (planner estimate, `pg_class.reltuples` — no exact-count
scan per R0-8/SCRUM-1254) vs 6,110 existing `anchor_proofs` rows. Re-verify
this gap with `scripts/ops/materializer-preflight.ts` (§2) before scheduling,
since both numbers move as other proof jobs and organic anchoring continue.

## 0. Current state (verify before trusting anything below)

- **Code:** `proof-materializer.ts` + the `/jobs/materialize-proof-backcatalog`
  route ship in PR #1615 (branch `claude/ecstatic-allen-0bf8a8`), **OPEN, not
  merged** as of this writing. The EXECUTE path in this runbook does not exist
  in prod until #1615 merges and deploys. Confirm with
  `gh pr view 1615 --json state,mergedAt` and prod `/health` build info before
  assuming the route is live.
- **Migrations 0359 (`anchor_proofs.materialize_run_id` rollback marker +
  partial index) and 0360 (hardened `enforce_secured_anchor_proof_complete()`
  predicate) are ALREADY PROD-APPLIED** — 2026-07-27 ~13:26–13:32Z via
  Supabase MCP, ledger head 0364 at the time (now past that; re-verify with
  `list_migrations`). **§0 rule 10 ledger reconciliation is DONE for 0359/0360
  — no further ledger write is needed for this runbook.** The EXECUTE step
  below is a **data operation** (rows inserted by the running worker under
  `service_role`), not a migration; it never touches
  `supabase_migrations.schema_migrations`.
- **GUC `arkova.proof_enforce_secured_complete` is OFF** (0340/0360 default).
  It must **stay OFF** for the entire materializer run — a freshly inserted
  skeleton has `op_return_payload IS NULL`, so it does not satisfy the 0360
  predicate until the separate SCRUM-2491 chain-sourced backfill runs later.
  Flipping the GUC ON before that backfill would make the materializer refuse
  outright (write mode fail-closes on GUC state `'on'`/`'unknown'` by design)
  — this is not a bug to work around, it is the sequencing guard.

## 1. Preconditions (ALL must pass, in order)

| # | Precondition | Verification |
|---|---|---|
| a | **PR #1615 merged and deployed to prod** (proof-materializer.ts + `/jobs/materialize-proof-backcatalog` route). | `gh pr view 1615 --json state` → MERGED; prod `/health` build info / `gcloud run revisions describe` shows a revision built from a commit that is an ancestor-or-equal of the merge; a dry-run POST (§3) returns a real `MaterializerSummary` body, not a 404. |
| b | **Backup + restore drill evidence captured (SCRUM-2983).** A ~2.96M-row bulk INSERT campaign against `anchor_proofs` is exactly the class of change a restore drill exists to de-risk — this is the reason SCRUM-2983 gates SCRUM-2917's EXECUTE, not a generic checklist item. | Drill artifact naming the Supabase project ref, backup/PITR point restored, restore duration, and a post-restore row-count/spot-check confirming integrity. No drill artifact → do not proceed. |
| c | **Autovacuum/bloat readiness verified (SCRUM-2984).** Run `scripts/ops/materializer-preflight.ts` (§2) against **prod** and get a `PASS` verdict (or an explicit, named residual-risk acceptance for each `WARN` finding). | `npx tsx scripts/ops/materializer-preflight.ts --project-ref vzwyaatejekddvltxyye --format json` → `"verdict": "PASS"`. Re-run within the same maintenance window as the EXECUTE start — bloat/lock state is a point-in-time read, not a durable fact. |
| d | **SCRUM-3031 (`batch_insert_anchors` wedge) fix merged and verified quiet.** See §1a below — this is the sharpest interaction risk in this runbook. | Fix PR merged to `main` and deployed to prod; `scripts/ops/materializer-preflight.ts`'s lock-contention check shows no `batch_insert_anchors`-signature session; spot-check `pg_stat_activity` for the same signature immediately before starting. |
| e | **Migration ledger confirmed at/above 0364** (0359/0360 present, numeric versions, no drift). | Supabase MCP `list_migrations` on prod; `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version IN ('0359','0360');` → 2 rows. (This is a re-verify, not new reconciliation work — §0 rule 10 is already satisfied for this PR's migrations.) |
| f | **Explicit founder/CTO go-ahead**, per the ratified sprint plan's founder-reserved-gates list ("materializer prod EXECUTE scheduling"). | Written go (HANDOFF.md line or message) linked from the HANDOFF entry that records the EXECUTE start. No go, no EXECUTE — this precondition is not delegable by an agent session. |
| g | **Scheduling window confirmed off-peak and non-overlapping with the batch-anchor drain cron.** The materializer's `classifyAnchor` reuse means every row needs LIMIT-2 tx-cardinality probes exactly like the classifier census (design record's own estimate: ~1–3h for the full backlog at that probe volume) — the design record explicitly requires serializing this against the ~255k feeder drain, off-peak, never concurrent with a batch-drain window. | Check the batch-anchor cron schedule (Cloud Scheduler `describe`) and pick a start time outside it; note the window in the HANDOFF entry. |

### 1a. SCRUM-3031 interaction (read this before scheduling anything)

`batch_insert_anchors` was found live on 2026-07-27 burning ~106s/call while
inserting **zero** rows on repeat, holding `RowExclusive` on `public.anchors`
near-continuously — it blocked a routine `apply_migration` for ~15 minutes
that same day and is the suspected root cause of the 259k pending-anchoring
backlog never draining (HANDOFF.md, 2026-07-27 CTO session). Two things follow
for this runbook:

1. **The materializer never writes to `anchors`** — it only `SELECT`s pages
   from it (via `sharedFetchScanPage`) and `INSERT`s into `anchor_proofs`. A
   plain `SELECT` takes `AccessShareLock`, which is compatible with
   `RowExclusiveLock` — the wedge does not block the materializer's own reads
   at the lock-table level. The real risk is **connection/IO contention**: a
   RPC that burns 106s per call in a tight resubmission loop competes for the
   same connection pool and DB CPU/IO the materializer's ~2.96M paged reads
   and chunked inserts also need, and a wedge that holds `RowExclusive`
   continuously is exactly the kind of thing that turns "safe reads" into
   `57014 statement timeout` errors under load (the 60s PostgREST session
   `statement_timeout` documented in `services/worker/src/routes/cron.ts`).
2. **Do not start EXECUTE while the wedge is active**, fixed-but-unverified,
   or reappearing. Precondition (d) is a hard gate. If the wedge resurfaces
   mid-run, treat it as an abort trigger (§6) — do not let a ~2.96M-row insert
   campaign run concurrently with a table-locking loop that has already once
   blocked a routine migration apply.

## 2. `scripts/ops/materializer-preflight.ts` — what it reports

Read-only preflight (`services/worker/src/*` runtime is never imported or
touched; it talks to Postgres only through the Supabase Management API's
`/database/query/read-only` endpoint — same mechanism as
`scripts/ci/staging-honesty-preflight.ts`, chosen over adding a raw `pg`
client dependency: the endpoint itself refuses non-SELECT statements, keeping
the stack on the locked Supabase-only DB access path per CLAUDE.md §1.1
without introducing a new runtime dependency for an ops-only tool). Connection
is via env — `SUPABASE_ACCESS_TOKEN` (or `SUPABASE_MANAGEMENT_API_TOKEN`) plus
`--project-ref` (or `PROD_PROJECT_REF`) — never a hardcoded credential.

Reports, per invocation:

1. **Gap estimate** — `anchors` row count via `pg_class.reltuples` (planner
   estimate, no scan — R0-8/SCRUM-1254 convention: never an exact `count(*)`
   on the hot `anchors` table) vs an exact `count(*)` on `anchor_proofs`
   (small table, ~6k rows at DoR baseline — exact count is cheap and safe
   there). `gap = anchors_estimate - proof_rows_exact`. This is an **upper
   bound** on the backfill population, not the exact classifier-eligible
   count — the real eligibility (`direct_anchored` vs `batch_provable` vs
   `already_complete` vs `ambiguous`) is only knowable by
   `classifyAnchor`'s own fresh per-page classification at run time (by
   design — see `proof-materializer.ts` header). The preflight sizes the
   operation; it does not replace the job's own halt-on-ambiguous logic.
2. **Table bloat** — `pgstattuple_approx('public.anchors')` and
   `pgstattuple_approx('public.anchor_proofs')` when the `pgstattuple`
   extension is installed (checked first via `pg_extension`); **deliberately
   the `_approx` sampling variant, not full `pgstattuple()`** — the full scan
   variant reads every heap page and is disproportionate work for a
   pre-flight check on a 2.96M-row table. Falls back to
   `pg_stat_user_tables.n_live_tup`/`n_dead_tup` (the same source
   `db-health-monitor.ts`'s `get_table_bloat_stats` RPC already uses in prod)
   when the extension is absent.
3. **Autovacuum settings/last-run** — `pg_stat_user_tables.last_autovacuum` /
   `last_autoanalyze` / `autovacuum_count` plus per-table `pg_class.reloptions`
   overrides, for both `anchors` and `anchor_proofs`.
4. **Active long-running queries holding locks** — `pg_locks` joined to
   `pg_stat_activity`, filtered to `relation IN ('anchors','anchor_proofs')`,
   reporting pid, lock mode, granted state, and running duration; a query
   text matching `%batch_insert_anchors%` is flagged as the known SCRUM-3031
   wedge signature once it has also run past
   `WEDGE_SIGNATURE_DURATION_FLOOR_SECONDS` (5s) — a bare name match alone is
   not enough, since PR #1730 reuses that RPC name for a fixed, ~11ms-healthy
   implementation and a duration-less match would otherwise WARN on every
   routine call once that lands.

### Verdict criteria (SCRUM-2984 readiness bar, defined here — this doc is the
source of truth for the thresholds until a Confluence page supersedes it)

| Check | WARN condition | Rationale |
|---|---|---|
| `bloat_headroom` | dead-tuple ratio ≥ 20% on `anchors` or `anchor_proofs` | Tighter than the standing prod alert threshold (0.5, `db-health-monitor.ts` `DEAD_RATIO_THRESHOLD`) — this is a **pre-launch readiness bar** for a table about to grow by up to ~2.96M rows, not the ongoing-ops alarm threshold. Starting a large insert campaign from already-elevated bloat compounds pressure instead of giving autovacuum headroom to keep up. |
| `autovacuum_staleness` | `last_autovacuum` (falling back to `last_autoanalyze`) older than 24h **and** `n_dead_tup` > 100,000 | Reuses the exact thresholds already live in prod (`db-health-monitor.ts` `VACUUM_AGE_THRESHOLD_HOURS=24`, `VACUUM_DEAD_TUPLE_THRESHOLD=100_000`) rather than inventing a new bar. |
| `lock_contention` | any session holds a conflicting lock (`RowExclusiveLock` or stronger) on either table for > 60s at preflight time | Mirrors the 60s PostgREST `statement_timeout` the materializer's own queries run under; a session already holding a write-class lock for that long is the SCRUM-3031 wedge shape even before the query-text match fires. |
| `gap_sanity` | `gap ≤ 0` | Informational floor — a zero/negative gap means either the backlog is already drained or the estimate inputs are stale; either way, confirm expectations before scheduling a run that has "nothing to do." |

Overall `verdict` is `PASS` only if every check above passes; any single WARN
sets the overall verdict to `WARN` and the script exits non-zero (fail-closed
— an operator or CI wrapper must not treat a WARN preflight as a green light).
Connectivity/query failures exit non-zero with an `::error::`-prefixed message,
distinct from a WARN verdict.

## 3. Batch size + pacing recommendation

Job tunables (`proof-materializer.ts`): `batchSize` defaults to **500**
(bounds 50–2,000), `maxBatches` (page-batches per HTTP invocation) defaults to
**20** (bounds 1–200). Recommendation for the EXECUTE run:

- **Keep `batchSize` at the default 500 for the entire run — do not push
  toward the 2,000 ceiling**, even though the code allows it. The job's own
  internal chunking (`IN_FILTER_CHUNK=100` for `.in()` proof-row lookups,
  `INSERT_CHUNK=500` for the upsert) is sized around the 500 default; a
  larger page multiplies per-query row counts against the same 60s PostgREST
  `statement_timeout` with no offsetting benefit, and — critically — **`ON
  CONFLICT (anchor_id) DO NOTHING` idempotency means a timed-out or aborted
  page costs nothing but time**: the next invocation safely re-scans from the
  durable `job_queue` checkpoint cursor and re-classifies the same page. There
  is no correctness reason to run hot; there is a real risk reason not to.
- **Phase 1 (canary):** first invocation with `execute=true`, default
  `batchSize=500`, `maxBatches=5` (≤2,500 rows). Watch one full cycle (§4)
  before touching anything else. This mirrors the "bound first, watch, then
  raise" pattern already used for the SCRUM-2916 proof-cron unfreeze runbook.
- **Phase 2 (ramp):** if phase 1 is clean (zero ambiguous halts, no lock
  contention, `db-health-monitor` quiet, `inserted` ≈ dry-run `planned`),
  raise to the default `maxBatches=20` (~10,000 rows/invocation) and re-invoke
  repeatedly — each invocation should complete in low single-digit minutes at
  this shape, per the design record's own ~1–3h/2.96M-row full-backlog
  estimate (tx-cardinality probing, not the insert itself, is the dominant
  cost). Watch after every invocation.
- **Phase 3 (steady state):** once several consecutive invocations are clean,
  script a bounded loop (repeated authenticated `POST`, short pause between
  calls, checking the returned `runComplete` field) within a single off-peak
  maintenance window that does not overlap the batch-anchor drain cron
  (precondition g). Do not leave an unattended loop running across a window
  boundary — re-check preconditions (d) and (c) if a window is split across
  sessions.
- **HTTP timeout headroom:** prod Cloud Run `--timeout 3600` (60 min,
  `deploy-worker.yml`) bounds a single manual invocation. The phased sizes
  above complete in minutes, leaving large headroom — the ceiling is not a
  design constraint at these batch sizes, only a backstop.
- **Concurrency caveat (§1.5 honesty):** the job's advisory lock
  (`try_advisory_lock`/`release_advisory_lock` RPCs, keyed on the
  materializer's own job-type string) is a **session-level** PostgREST lock,
  not a distributed one — under connection pooling, `release` can land on a
  different pooled backend than `acquire`, in which case the unlock is a
  no-op until that backend recycles (documented in
  `proof-backcatalog-classifier.ts`'s `createDbLocker`). Do not rely on the
  lock alone to prevent a second concurrent invocation; the operator loop in
  Phase 3 should be single-threaded by construction (one script, one
  in-flight request at a time), not just lock-protected.

## 4. Monitoring during the run

Reuse the standing prod monitor rather than building new bloat/lock detection
for this run specifically:

- **`db-health-monitor.ts`** (SCRUM-1254, runs on its existing schedule) —
  watch for `dead_tuple_ratio` / `dead_tuple_autovacuum_age` Sentry alerts on
  `anchors`. **It does NOT currently monitor `anchor_proofs`** —
  `services/worker/src/jobs/db-health-monitor.ts`'s `HOT_TABLES` is
  `['anchors', 'public_records', 'audit_events', 'job_queue']`, and
  `anchor_proofs` is not in that list. The underlying `get_table_bloat_stats`
  RPC is generic (`table_names text[]` against `pg_stat_user_tables`, no
  hardcoded table names), so adding `anchor_proofs` to `HOT_TABLES` would be
  a cheap query-level change — but it's a `services/worker/src/` runtime
  edit, which would pull this PR out of its declared T1/docs-only,
  zero-worker-change scope and into a worker-behavior change requiring its
  own T2 staging soak (CLAUDE.md §1.12). Out of scope here; tracked as a
  follow-up rather than folded into this PR. Until that follow-up lands,
  **manual `scripts/ops/materializer-preflight.ts` re-runs between
  invocations are the only bloat/autovacuum signal `anchor_proofs` gets —
  they are REQUIRED during the live run, not optional supplementary
  coverage.**
- **Locks** — re-run `scripts/ops/materializer-preflight.ts`'s lock-contention
  check between invocations (or a tighter ad hoc `pg_locks`/`pg_stat_activity`
  query) — specifically watch for the SCRUM-3031 `batch_insert_anchors`
  signature reappearing (§1a).
- **Replication lag** — **N/A for the current prod topology.** Arkova's prod
  Supabase project has no configured read replica as of this writing (verify
  via `list_projects`/the Supabase dashboard before relying on this — if a
  replica is added before this runbook is executed, add a lag check here
  rather than assuming the N/A still holds; §1.5 — do not assert an absence
  you haven't just re-checked).
- **Bloat growth** — the run inserts up to ~2.96M new `anchor_proofs` rows;
  expect `n_live_tup` on `anchor_proofs` to climb accordingly and
  `autovacuum_count` to increase as autovacuum keeps pace. A `WARN`-tier dead
  ratio appearing on `anchor_proofs` mid-run (new rows are all insert-only,
  not updates/deletes, so this should stay near-zero dead tuples for that
  table specifically — a rising dead ratio on `anchor_proofs` during an
  insert-only run is itself a signal worth investigating, not expected noise)
  is an abort-consideration trigger (§6).
- **Job's own summary** — every invocation returns a `MaterializerSummary`
  (`inserted`, `conflictSkipped`, `skippedExisting`, `haltedAmbiguous`,
  `ambiguousReasons`, `cursor`, `runComplete`). `haltedAmbiguous > 0` on any
  page means the run stopped **before writing that page** — review
  `ambiguousReasons` before re-invoking; do not treat a halt as something to
  push past blindly (mirrors the classifier's own fail-closed halt
  semantics).

## 5. Rollback procedure

Per-run surgical rollback via the `materialize_run_id` marker (0359):

```sql
DELETE FROM public.anchor_proofs
WHERE materialize_run_id = $1
  AND merkle_root IS NULL
  AND proof_path IS NULL
  AND op_return_payload IS NULL;
```

- `$1` is the run's `runId` (uuid), returned in every `MaterializerSummary` as
  `runId` and durable in the `job_queue` checkpoint row
  (`type='proof-materializer:checkpoint'`) for the run's `(scope, mode)` —
  recover it from the checkpoint payload if the operator's own record of it is
  lost.
- The three `IS NULL` guards are load-bearing, not decorative: a skeleton row
  later enriched by the separate SCRUM-2491 chain-sourced backfill (which
  fills `op_return_payload`) or any other proof-completion job stops matching
  this predicate and is **never** deleted by this rollback — rollback removes
  only the still-untouched skeletons this run created, never work another job
  has since built on top of.
- **Authoritative row count for a given run** is
  `SELECT count(*) FROM public.anchor_proofs WHERE materialize_run_id = $1;`
  — small, partial-indexed (`idx_anchor_proofs_materialize_run_id`, `WHERE
  materialize_run_id IS NOT NULL`), and safe even mid-run. The checkpoint's
  cumulative `inserted` counter can under-count after a mid-page crash (a
  resume re-counts an already-inserted-but-uncommitted-to-checkpoint row as
  `skippedExisting`) — the row count by `materialize_run_id` is always the
  source of truth, not the checkpoint counter (documented in the job's own
  header).
- Rolling back does **not** require a `§0 rule 10` ledger reconciliation step
  — it is a plain `DELETE` against application data, not a migration; nothing
  touches `supabase_migrations.schema_migrations`.
- After a rollback, re-run `scripts/ops/materializer-preflight.ts` before
  considering a retry — the conditions that motivated the rollback (bloat,
  locks, an unexpected data pattern) should be re-verified clean, not assumed
  fixed.

## 6. Abort criteria

Stop the run (stop invoking; do not force through) if any of the following
hold:

1. **`scripts/ops/materializer-preflight.ts` returns `WARN`** at the start of
   any invocation window, especially a `lock_contention` finding matching the
   `batch_insert_anchors` signature (§1a).
2. **`haltedAmbiguous > 0`** on any page and the `ambiguousReasons` are not
   already-understood, previously-triaged categories — an ambiguous row is a
   genuine data-integrity finding the classifier/materializer correctly
   refused to guess past; escalate before re-invoking with `restart=true` or
   otherwise trying to skip past it.
3. **GUC state comes back `'on'` or `'unknown'`** on any invocation (the job
   self-refuses in write mode on `'unknown'`; a report of GUC `'on'` mid-run
   means something flipped the Phase-3 enforcement flag out of sequence —
   treat as an incident, not a retry-and-continue situation).
4. **`db-health-monitor` fires** a `dead_tuple_ratio`, `dead_tuple_autovacuum_age`,
   or `pg_cron_failure` alert touching `anchors` during the run (`anchor_proofs`
   is not in `HOT_TABLES` — see §4 — so `anchor_proofs` bloat/staleness is
   caught only by the manual `scripts/ops/materializer-preflight.ts` re-runs,
   which must be treated as the equivalent abort trigger for that table).
5. **`conflictSkipped` is unexpectedly large** relative to `inserted` for a
   page — the advisory lock should prevent a second concurrent materializer
   invocation from racing this run, but its session-pooling caveat (§3) means
   this signal is the honest backstop; a large conflict rate is evidence
   worth investigating before continuing, not something to shrug off as
   "idempotency working as intended."
6. **Any unexpected 5xx** from `/jobs/materialize-proof-backcatalog`. Safe to
   retry once (checkpoint is durable, idempotent) but do not retry more than
   once without checking logs/Sentry first.
7. **The scheduling window (precondition g) is about to close** (batch-anchor
   drain cron approaching) — stop cleanly at a page boundary rather than
   letting an in-flight invocation race the drain cron.

Any abort is safe by construction — the checkpoint is durable, inserts are
idempotent, and the rollback procedure (§5) is always available if a
completed page turns out to need reverting after the fact.

## 7. What this runbook does NOT assert (§1.5)

This runbook describes how to run and monitor the backfill safely; it does
**not** assert that the resulting skeleton rows make any anchor's proof
`SECURED`-complete under the 0360 predicate (they don't, by design, until the
separate SCRUM-2491 `op_return_payload` backfill runs), does not assert a
drain-rate SLO for the ~2.96M backlog, and does not cover the Phase-3 GUC-flip
decision (a separate, later, still-gated step per the SCRUM-2916 family of
runbooks). It also does not itself perform, schedule, or authorize the EXECUTE
run — precondition (f) is the only thing that does that.
