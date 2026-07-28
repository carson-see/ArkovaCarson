# SCRUM-2917 — Insert-capable proof materializer: design record (CTO-ruled)

> **INTERNAL ENGINEERING NOTE** — the system of record is the Confluence page for
> SCRUM-2917 (+ the CTO Decision Queue page 110198785 where the ruling lives).
> This file is the in-repo draft/mirror for the PR and the Confluence write-up.
>
> Slice: PI-0.5 next-24h, Lane 1 (Trust & Chain), 2026-07-21.
> Status (at authoring, 2026-07-21): DESIGN + ISOLATED TDD BUILD ONLY. No prod
> write, no populate run, no soak. Execute steps are T3 and Carson/CTO-gated
> behind the isolated rig + backup-restore drill (RTE-provisioned).
>
> **UPDATE 2026-07-27 — status is now split, be precise:** the DDL/trigger
> change (migrations 0359 `materialize_run_id` column + partial index, and
> 0360's compensating `CREATE OR REPLACE` of the 0340 SECURED-completeness
> trigger predicate) WAS applied to prod ~13:26-13:32Z via Supabase MCP after
> a 48h isolated-rig T3 soak (PR #1615 "Staging Soak Evidence"; ledger numeric
> head reconciled to 0364 at apply time, confirmed 0366 as of 2026-07-28). The
> materializer's own row-INSERT backfill (`proof-materializer.ts` actually
> populating `anchor_proofs` skeleton rows for the back-catalogue) has **NOT**
> run against prod — no populate run, no execute-mode invocation outside the
> isolated rig. "No prod write, no populate run, no soak" above was true only
> for that INSERT/backfill path at authoring time; it never described the
> schema/trigger DDL, which is now live.

## 1. Problem

Prod's ~2.97M SECURED anchors are DIRECT-anchored (one tx per anchor; the
OP_RETURN commits the fingerprint itself — there is no Merkle tree). Only
~6.1k anchor_proofs rows exist. Every existing proof job is UPDATE-only by
design:

| Job | Mandate | Writes |
|---|---|---|
| `proof-backcatalog-classifier.ts` | honest census + 0354 class label | UPDATE one column, existing rows only |
| `backfillProofCompleteness.ts` (SCRUM-2491) | reconstruct 0340 chain columns (block_hash/header/op_return) | UPDATE existing rows |
| `proof-branch-backfill.ts` (FIX-1) | rebuild branches w/ root-equality self-validation | UPDATE existing rows |
| `confirmation-proof-populate.ts` (PROOF-03) | layer-2 header fill post-SECURED | UPDATE existing rows; missing row skipped+counted |

The classifier honestly counts anchors that NEED a label but have no row to
carry it (`classUnpersistedNoProofRow`) — for the direct back catalogue that is
essentially all of it. SCRUM-2917 is the missing INSERT-capable counterpart.

## 2. CTO ruling (2026-07-21, Confluence 110198785 — binding)

1. **receipt_id provenance:** `receipt_id := anchors.chain_tx_id`. This matches
   the founding semantics — the normal path writes `receiptId: prepared.txId`
   (batch-anchor.ts), i.e. `anchor_proofs.receipt_id` (text NOT NULL, no FK)
   *is* the chain tx id.
2. **Idempotency:** `INSERT … ON CONFLICT (anchor_id) DO NOTHING` (constraint
   `anchor_proofs_anchor_unique` already exists). Never update-on-conflict — an
   existing row, whatever wrote it, wins.
3. **Rollback marker:** new nullable `anchor_proofs.materialize_run_id uuid`
   (migration **0359**), stamped on every materializer-inserted row. Per-run
   rollback = `DELETE … WHERE materialize_run_id = $run AND merkle_root IS NULL
   AND proof_path IS NULL AND op_return_payload IS NULL` — the NULL guards mean
   only untouched skeletons are ever deleted; a row later enriched by the
   SCRUM-2491 backfill survives.
4. **Minimal row now; header-fill deferred (not a launch item):** the skeleton
   is exactly `{anchor_id, receipt_id, proof_completeness_class:
   'direct_anchored', materialize_run_id}`. Everything else stays NULL.
5. **0340 trigger predicate (migration 0360; §1.4 forge guard):**

   ```
   (merkle_root IS NOT NULL AND proof_path IS NOT NULL)
   OR (proof_completeness_class = 'direct_anchored'
       AND op_return_payload IS NOT NULL)
   ```

   A bare `proof_completeness_class` label is **forbidden** as proof — a
   text label with no on-chain payload must never satisfy the SECURED gate
   (otherwise a single mislabeled UPDATE could mint a "proven" anchor with
   zero cryptographic evidence). A trigger unit test rejecting the
   bare-label/NULL-merkle row ships with the migration (mandated).
6. **Honest empties:** direct anchors leave `merkle_root`/`proof_path` EMPTY.
   We never synthesize a degenerate single-leaf branch, retroactively or
   otherwise.
7. **Prefixes (SCRUM-2979):** 0359 + 0360 to Lane 1, landing after 0358
   (unmerged chain rail #1552). Advisor-train band shifts to 0361+. RTE lands
   the reservation rows.

## 3. Consequence to sequence (deliberate, honest)

A freshly materialized skeleton does **not** satisfy the 0360 predicate — its
`op_return_payload` is NULL until the SCRUM-2491 chain-sourced backfill fills
it. That is by design: the enforcement GUC
(`arkova.proof_enforce_secured_complete`, default OFF since 0340) flips on only
after **materialize → op_return backfill → rig-verified predicate**, so the
label alone never becomes load-bearing. Order of operations for the (gated,
NOT-this-slice) execution:

1. 0359 + 0360 applied (T3, isolated rig soak + rollback rehearsal first).
2. Classifier census complete, zero ambiguous (already built; halts otherwise).
3. Materializer dry-run → plan review → Carson-gated EXECUTE (dual guard).
4. SCRUM-2491 backfill populates op_return_payload for direct rows (chain-
   sourced, self-validating; separate confirm token).
5. Only then: Phase-3 GUC flip consideration (own runbook, SCRUM-2916 family).

## 4. Materializer job design (mirrors the classifier's proven skeleton)

- File: `services/worker/src/jobs/proof-materializer.ts`,
  `runProofMaterializer(deps, options)`.
- **Dual execute-guard** (same shape as classifier/backfill): dry-run unless
  `execute=true` AND `PROOF_MATERIALIZER_CONFIRM=EXECUTE` (own token —
  `config.proofMaterializerConfirm`; arming one proof write job never arms
  another).
- **GUC guard** every invocation: refuses when enforcement is ON; write mode
  fail-closes on `unknown` (reuses `createDbGucReader`).
- **Eligibility = classifier truth:** reuses the exported pure `classifyAnchor`
  page-by-page at write time. Only `direct_anchored` anchors with NO existing
  proof row get a skeleton. `batch_provable`/`already_complete` are counted,
  skipped. **Any `ambiguous` row halts the page before any write** (same
  fail-closed semantics as the classifier's apply pass).
- **Concurrency:** pg advisory lock via `createDbLocker`, keyed on the
  materializer's own job-type string (no collision with classifier locks);
  fail-closed on acquire error.
- **Resumable:** durable `job_queue` checkpoint (`proof-materializer:checkpoint`,
  terminal status), cursor + cumulative counts; one `runId` (uuid) minted per
  checkpoint and stamped on every inserted row across resumes — the rollback key.
- **Write:** chunked upsert `{onConflict: 'anchor_id', ignoreDuplicates: true}`
  with `.select()` so real inserts vs conflict-skips are counted honestly.
- **Structurally cannot fabricate:** the insert payload builder cannot emit
  `merkle_root`/`proof_path`/`op_return_payload`/`block_*` — asserted by tests.
- Route: `POST /cron/materialize-proof-backcatalog` (manual trigger only, NOT
  scheduled; same cronAuth + Zod param bounds as the classifier route).

## 4a. DoR baseline — known-good census (prod, READ-ONLY, 2026-07-21)

Captured via Supabase MCP read-only SELECTs on `vzwyaatejekddvltxyye` (no
writes; the checkpoint-persisting dry-run census itself remains gated):

| Metric | Value |
|---|---|
| `anchor_proofs` rows (total) | **6,110** |
| Complete (`merkle_root` + `proof_path`) | **6,110** (100% of existing rows) |
| With `op_return_payload` | **0** — even the batch rows lack it; SCRUM-2491 backfill is a hard prerequisite of any Phase-3 GUC flip, for BOTH populations |
| With `block_header` | 6,110 |
| `proof_completeness_class` labeled | 0 (classifier apply has not run on prod) |
| `anchors` planner estimate (`pg_class.reltuples`, no scan) | ~2,962,154 |
| Migration ledger head | 0357 (0358 pending chain rail #1552; `materialize_run_id` query errors → 0359 confirmed NOT applied) |

Implication for the materializer plan: expected INSERT volume ≈ 2.96M − 6.1k
existing rows (exact split direct/batch/ambiguous comes from the gated dry-run
census). Kickoff pre-mortem stands: ~2.96M tx-cardinality LIMIT-2 probes
(~1–3h) must be serialized against the 255k feeder drain — off-peak, bounded
invocations, and never concurrent with a batch drain window.

## 5. What this slice does NOT do

- No prod or rig writes; migrations are file-only (0359/0360 marked
  do-not-apply pending RTE rig + go-ahead).
- No populate run, no soak, no Scheduler binding, no GUC flip.
- No header-fill (~2.97M unique-tx RPCs — explicitly out, per ruling).
- The T3 execute clock starts only after the RTE's isolated rig +
  backup-restore drill and explicit go (founder directive 2026-07-20).
