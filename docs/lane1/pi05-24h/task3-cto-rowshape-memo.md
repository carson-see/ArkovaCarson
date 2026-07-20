# CTO Row-Shape Memo — direct-anchor proof materializer (SCRUM-2916/2917)

**From:** Lane 1 (Trust & Chain, DBA persona) · **To:** CTO (via RTE) · **Ruling due:** Jul 24 EOD
**Status:** DRAFT for ruling. No migration files authored (W3). Grounded in read-only prod census (Task 2) + code/schema read.

## 1. The decision in one sentence
The materializer must INSERT one `anchor_proofs` row for each of the **~2,986,542 direct-anchored** SECURED anchors that currently have **no proof row** (Task 2 census: 6,110 already-complete rows exist; ~99.8% of the 2.99M catalogue has none). This memo asks the CTO to rule on the **exact column payload of a direct-anchor proof row**, its **idempotency key**, **resume semantics**, and **rollback** — and the one hard coupling: the **0340 "SECURED ⇒ proof complete" trigger** predicate.

## 2. Schema facts (fixed constraints the ruling must live within)
- `anchor_proofs` PK `id uuid`; **`anchor_id uuid NOT NULL`**; **`receipt_id text NOT NULL`** (no FK, no default); `merkle_root text NULL`, `proof_path jsonb NULL`, `batch_id text NULL`; 0340 columns `block_height`, `block_timestamp`, `block_hash text`, `block_header bytea`, `op_return_payload bytea`, `merkle_index int`, `proof_schema_version smallint NOT NULL DEFAULT 1`; 0354 column `proof_completeness_class text NULL`.
- **UNIQUE(`anchor_id`)** = `anchor_proofs_anchor_unique` → **the natural idempotency key** (one proof row per anchor).
- **0340 trigger** `enforce_secured_anchor_proof_complete` (GATED by GUC `arkova.proof_enforce_secured_complete`, currently **OFF**): when ON, an anchor entering/being touched at SECURED **requires a proof row with `merkle_root` AND `proof_path` both populated.** Direct anchors have **no merkle tree** — the classifier and §1.6 honesty rules **forbid fabricating one** (no synthetic single-leaf branch conjured retroactively). **This is the crux:** a naive direct-anchor row (merkle fields NULL) does NOT satisfy the 0340 predicate, so enabling the GUC later would reject the entire back catalogue on any status touch.

## 3. Recommended row shape (direct_anchored)
Per materialized direct anchor, INSERT:

| column | value | note |
|---|---|---|
| `anchor_id` | anchor.id | idempotency key |
| `receipt_id` | **anchor.chain_tx_id** | **RULING NEEDED (§5-A):** for a direct anchor the tx *is* the network receipt; no pre-existing receipt_id exists to reuse |
| `op_return_payload` | `ARKV`(4B)+fingerprint(32B)+suffix(8B) | reconstructable from the anchor row **without a chain call** (verified against Task-1 on-chain sample) |
| `block_height` | anchor.chain_block_height | already on the anchor row |
| `block_timestamp` | anchor.chain_timestamp | already on the anchor row |
| `block_hash` | anchor.chain_block_hash **or NULL** | **RULING NEEDED (§5-B):** only ~partially populated on anchors; full population is a **chain call** owned by `backfillProofCompleteness.ts` (SCRUM-2491), not this job |
| `block_header` | NULL (deferred to 2491) | bytea; needs a chain fetch |
| `merkle_root` | **NULL** | honest: direct anchors have no tree — never fabricate |
| `proof_path` | **NULL** | honest empty; do NOT write `[]` (that would read as already_complete under 0340) |
| `batch_id` | NULL | not a batch |
| `proof_completeness_class` | `'direct_anchored'` | 0354 label = the honest completeness signal |
| `proof_schema_version` | 1 | current |

**Rationale:** the row carries the *real* on-chain binding (tx + OP_RETURN commitment of the fingerprint) — which is exactly what a stranger uses to verify (Task-1 method) — while leaving merkle fields honestly NULL. Completeness is asserted via the **class label**, not a fabricated tree.

## 4. Idempotency, resume, rollback
- **Idempotency key:** `INSERT … ON CONFLICT (anchor_id) DO NOTHING` (or `DO UPDATE SET proof_completeness_class=EXCLUDED.…` if re-labeling is desired). Guarantees exactly one row/anchor; safe to re-run. Do **not** key on `id` (server default) — that defeats idempotency.
- **Resume:** mirror the classifier's proven pattern — durable `job_queue` checkpoint row (`type='...:materialize:checkpoint'`, terminal status `completed`), monotonic **cursor = last anchor_id ascending**, bounded pages (batchSize clamp 50–2000, maxBatches clamp per invocation). Worker restart resumes from cursor, never from zero. Re-classify each page fresh at insert time and **HALT before writing any page that turns `ambiguous`** (reuse the classifier's halt-on-ambiguous gate).
- **Rollback:** because the run is INSERT-only of NEW rows for anchors that had none, rollback is a scoped DELETE. **Tag every inserted row with a `run_id`** (recommend a dedicated marker — either a reserved `batch_id='materialize:<run_id>'` sentinel or a run-scoped `created_at ≥ run_start`) so rollback is: `DELETE FROM anchor_proofs WHERE <run marker> AND proof_completeness_class='direct_anchored'`. **Must never touch the 6,110 pre-existing already_complete rows.** A backup + restore drill (SCRUM-2983) is the hard pre-execute gate regardless.

## 5. Open rulings the CTO must make
- **5-A `receipt_id` provenance:** confirm `receipt_id := chain_tx_id` for materialized direct rows (the honest "network receipt" for a direct anchor). Alternative: mint a synthetic `direct:<anchor_id>` — rejected here as less meaningful.
- **5-B chain-data columns now or later:** materialize the MINIMAL row now (no chain call: receipt_id, op_return_payload, height, timestamp, class) and let `backfillProofCompleteness` (SCRUM-2491) fill `block_hash`/`block_header` later — **vs** one insert-with-chain-data pass. Recommend **minimal-now + 2491-later** to keep the 2.98M pass chain-call-free and fast.
- **5-C 0340 trigger predicate (COUPLED MIGRATION):** to ever enable the GUC without rejecting direct anchors, the trigger predicate must change from `merkle_root AND proof_path present` to `(merkle_root AND proof_path present) OR proof_completeness_class IN ('direct_anchored','already_complete')`. This is a **separate migration** in the 0359+ advisor train (Task 7), gated on this ruling. Until then, GUC stays OFF and materialization is label-only-complete.
- **5-D `already_complete` semantics for direct:** confirm direct rows count as "servable complete" for KPI/proof-bundle purposes even though `proof_bundle` (two-layer) stays null (FE proof-gate "state 1b"). The Task-1 finding shows direct anchors are OP_RETURN-verifiable; the downloadable two-layer packet is genuinely N/A, not missing.

## 6. What this memo does NOT assert (§1.5)
Does not assert the exact `secured_without_tx` (ambiguous) count — Task-2 could not compute it read-only (no index on `chain_tx_id IS NULL`); if > 0 those rows must be excluded from materialization and routed to ambiguity resolution. Does not author any migration (W3). Does not decide the GUC flip.

_Lane 1 (Trust & Chain), 2026-07-20 evening. Feeds SCRUM-2916 CTO ruling (Jul 24) + the 0359+ train (Task 7)._
