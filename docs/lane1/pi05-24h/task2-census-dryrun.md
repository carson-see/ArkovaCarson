# Task 2 — Census dry-run (SCRUM-2916) — Lane 1, 24h window 2026-07-20

**Two-part task:** (a) PROVE the classifier dry-run is write-free on local; (b) run the census read-only against prod → row counts by class + anomaly list.

## Part A — write-free proof (W6 precondition) — ✅ PASS, with one escalation

**Local test evidence:** `services/worker/src/jobs/proof-backcatalog-classifier.test.ts` → **64/64 passed** (`npx vitest run`, worktree `lane1/24h-window-20260720`, deps freshly `npm ci`'d).
Relevant assertions proven:
- **Dry-run emits the per-class plan and performs ZERO non-checkpoint writes** (test "emits the per-class row-count plan and performs ZERO non-checkpoint writes"). The fake DB separates `nonCheckpointWrites` (the "never" set = `anchors`/`anchor_proofs`) from the legitimate `job_queue` checkpoint.
- **Read-only columns are structurally unreachable** — `buildClassWriteSet` can never emit any of `CLASSIFIER_READ_ONLY_COLUMNS` (merkle_root, proof_path, merkle_index, block_hash, block_header, op_return_payload, batch_id, receipt_id, …) for any class; write mode also needs BOTH `execute===true` AND `PROOF_CLASSIFIER_CONFIRM=EXECUTE` (`resolveExecuteGuard`).

**⚠ ESCALATION (W4 conflict — RTE/CTO):** "write-free" is scoped to the **proof catalogue** only. The dry-run **still persists a durable `job_queue` checkpoint row in BOTH dry-run and write mode** (`createCheckpoint`/`saveCheckpoint`, called from the dry-run path; documented at the file header "durable checkpoint rows in job_queue (dry-run included)"). Therefore **invoking the real `/jobs/classify-proof-backcatalog` endpoint against prod would create a prod `job_queue` write** — a violation of window rule **W4 "zero prod writes."** The safe-work-order's W6 ("read-only after no-write proof") is satisfied for the proof catalogue but NOT for `job_queue`. **Consequence:** the prod census below was computed by **replicating `classifyAnchor`'s predicates via read-only count queries** (PostgREST, `Prefer: count`), which is genuinely write-free — NOT by invoking the checkpoint-writing endpoint. Recommend: run the endpoint's dry-run only against an isolated rig (where the checkpoint write is in-scope), or add a true `plan_only=no_checkpoint` mode before any prod-pointed dry-run.

## Part B — read-only prod census (ref `vzwyaatejekddvltxyye`, service-role SELECT/count only, zero writes)

| Class (per `classifyAnchor`) | Count | Method | Confidence |
|---|---|---|---|
| **Total SECURED** (deleted_at null) | **≈ 3.0M** | `count=estimated` (pg_class reltuples) | ESTIMATE ONLY — drifts ±~20k between reads (2.97M/2.99M/3.00M seen); do NOT cite a precise number, and do NOT build a run loop on this bare estimate (perf review F1: 13s→22s→timeout) |
| **already_complete** (root + path present) | **6,110** | `count=exact` on `anchor_proofs` | EXACT |
| — of which also carry `batch_id` | 6,110 (all) | `count=exact` | EXACT |
| **batch_provable** (root + batch_id, path null) | **0** | derived: every proof row already has path → already_complete | EXACT |
| **direct_anchored** (no proof row, tx-cardinality 1) | **≈2.98M — UPPER BOUND** | total − already_complete − ambiguous (ambiguous UNcomputed) | inferred bulk; NOT a classifyAnchor-faithful count. Absorbs any secured_without_tx + shared-tx members. The materializer's insert authority is per-anchor classifyAnchor-WITH-cardinality, insert only on `direct_anchored` (see Task 3 HIGH-1) |
| **ambiguous — secured_without_tx** | **not computed** | seq-scan on `chain_tx_id IS NULL` (no index) → statement timeout | UNRESOLVED |
| **ambiguous — shared-tx / cardinality** | **not computed** | needs per-tx cardinality probe | UNRESOLVED |

### Key findings
1. **All 6,110 materialized proof rows are `already_complete`** — every `anchor_proofs` row has `merkle_root` + `proof_path` + `batch_id` all non-null. These are the batch-anchored STORED proofs. `batch_provable` (root without path) = **0**.
2. **`proof_completeness_class` is unpopulated on 100% of rows (0 / 6,110 labeled).** The classifier has **never run in WRITE/apply mode against prod** — consistent with the T3/Carson-gated status. The 0354 label column exists but carries no data.
3. **The ~2.98M no-proof-row SECURED anchors are `direct_anchored`** (fingerprint committed directly in OP_RETURN, tx-cardinality 1) — corroborated by Task 1's 15-anchor-sample (all 4 HakiChain anchors: no `anchor_proofs` row, OP_RETURN = `ARKV`+fingerprint, one anchor per tx). This is the census's own stated model ("~2.97M are DIRECT-anchored").

### Anomaly list
- **A1 (data-integrity, UNVERIFIED read-only):** exact count of `secured_without_tx` (a SECURED anchor with no `chain_tx_id` = contradiction) could **not** be computed read-only — no partial index supports `chain_tx_id IS NULL` (the index is `... chain_tx_id IS NOT NULL`), so the count seq-scans 2.99M rows and hits the DB statement timeout. Known prod state is "0 false-SECUREDs"; **recommend confirming = 0 via a `psql` aggregate or the census job on an isolated mirror**, not asserting from memory.
- **A2 (materialization gap):** already_complete = 6,110 vs ~2.99M SECURED → **~99.8% of the catalogue has no downloadable two-layer proof bundle** (they are OP_RETURN-verifiable but produce `proof_bundle: null`). Feeds the PROOF-BACKCATALOG materializer scope (SCRUM-2916/2917) — the census confirms the input size for the Aug-4 materializer execute (~2.98M direct_anchored rows to label).
- **A3 (label census never applied):** 0 rows labeled → the Aug-4 write/apply pass will be labeling from scratch across the whole scope; budget the resumable apply accordingly.

### Reproducibility / method
Read-only predicates mirroring `classifyAnchor`, via `curl … -H "Prefer: count=exact|estimated" -H "Range: 0-0"`:
- already_complete: `anchor_proofs?merkle_root=not.is.null&proof_path=not.is.null` → 6110
- batch_id control: `?batch_id=is.null` → 0, `?batch_id=not.is.null` → 6110 (confirms filter application)
- label control: `?proof_completeness_class=not.is.null` → 0
- SECURED total: `anchors?status=eq.SECURED&deleted_at=is.null` count=estimated → 2,992,652

_Lane 1 (Trust & Chain), 2026-07-20 evening. Zero prod writes (SELECT/count only). Endpoint dry-run deliberately NOT invoked against prod (W4)._
