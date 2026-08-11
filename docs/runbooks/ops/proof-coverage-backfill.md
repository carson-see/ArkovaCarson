# Proof coverage: census, reconstruction, and the permanent forward-path fix

**Story:** SCRUM-3187 · **Tier:** T3 (migration + chain code) · **Status of the numbers:** measured against prod `vzwyaatejekddvltxyye` on 2026-08-11.

> Internal engineering notes. The auditor-facing page is the Confluence
> On-Chain Policy page; update it from here, do not treat this file as the doc
> of record (CLAUDE.md §0 rule 4).

---

## 1. What was actually wrong

Arkova promises that anyone can verify a secured document offline, forever,
without trusting Arkova. That requires a per-document Merkle inclusion proof
for every SECURED anchor. Prod, measured 2026-08-11:

| Measure | Value |
|---|---|
| SECURED, non-deleted anchors | **3,474,760** |
| `anchor_proofs` rows | **505,357** |
| Secured records with **no** per-document proof | **2,969,630** (85.5%) |
| Distinct anchoring transactions | 2,330 |
| Transactions with **any** proof coverage | **171 of 2,330** |
| `proof_completeness_class` populated | **0 rows** (100% NULL) |
| Rows the materializer had ever written | **0** (`materialize_run_id` NULL everywhere) |

HakiChain's live record `ARK-2026-8F862179` returned HTTP 404 `NO_BATCH_PROOF`
because it is one of these — a single-leaf batch with zero proof rows.

The forward path is healthy: **128 of 128** transactions in 2026-08 are fully
covered. The gap is historical, concentrated in 2026-03 and 2026-04.

---

## 2. The reconstructibility census — the load-bearing result

A batch is reconstructible only if we can rebuild the exact Merkle tree that
was committed on-chain. Two things are needed: the **leaf set** and the **leaf
order**. `buildMerkleTree` hashes leaves in the exact array order given, so a
wrong order yields a wrong root.

**The leaf set is intact.** Prod has zero soft-deleted anchors carrying a
`chain_tx_id` and zero SECURED anchors without one, so no batch has a hole.
This was confirmed empirically, not assumed: for backlog tx `606b7eec…`
(6 anchors, 2026-03-27), exactly **1 of the 720 permutations** of the six
fingerprints we hold reproduces the real on-chain root. The set is exact; only
the ordering was unknown.

**The leaf order was never persisted, and is not derivable.** The March/April
producer was `batch-anchor.ts processBatchAnchors()` (commit `7926329b9`),
which passed rows straight from the `claim_pending_anchors` RPC into
`buildMerkleTree` with no sort. That RPC's `ORDER BY created_at ASC` binds only
the inner id-picking subquery; `UPDATE … RETURNING` carries no ordering
guarantee, so the emitted order is a query-plan artifact (hash-aggregate bucket
order over the claimed UUIDs). Empirically ruled out for real backlog batches:
`id asc`, `fingerprint asc`, `created_at asc`, `created_at desc`, physical
`ctid` order, and each of their reverses. No table from that era recorded batch
membership order — `anchor_txid_journal` (0358) holds 9 rows, all 2026-08, and
`merkle_batches` (0113) was never written to by any code.

Resulting classes, over the 2,970,238 records missing a proof:

| Class | Transactions | Missing proofs | Recoverable? |
|---|---|---|---|
| **A** — single leaf (n=1) | 163 | **148** | **Yes.** Committed root *is* the fingerprint; empty branch. Still verified against the chain before writing. Includes HakiChain. |
| **B** — small batch (n=2–8) | 111 | **460** | **Yes**, by exhaustive ordering search (≤8! = 40,320 candidates), every candidate judged by the chain. |
| **C** — large batch (n>8) | 2,054 | **2,969,630** | **No**, not from stored data. Order space is ≥9! and unbounded at n=10,000. |

**608 of 2,970,238 records (0.02%) are recoverable from what we hold.
2,969,630 (99.98%) are not.** That is the honest answer, and it is the one to
publish. Class C anchors remain provably *anchored* — the fingerprint is in a
transaction whose root is on-chain, and batch membership is provable — but they
cannot be given a standalone offline inclusion branch.

### 2.1 The trap that was avoided

~29% of sampled March anchors (5,842 of 20,000) carry a legacy
`anchors.metadata.merkle_proof`. It looks exactly like a ready-made branch.
**It does not verify.** For batch `8f62259b…` the stored root equals the
on-chain root, yet the stored branches fail verification under all four
interpretations tested (as-is, position-flipped, level-reversed, both). A
backfill that trusted this field would have manufactured hundreds of thousands
of false integrity claims that verify against nothing. This is pinned as a
regression test (`proofReconstruction.test.ts`, "rejects a real prod legacy
branch that does not verify").

---

## 3. How a reviewer confirms a generated proof is genuine

The invariant is structural, not procedural: `reconstructBatch()` in
`services/worker/src/utils/proofReconstruction.ts` contains the **only** code
path that can construct a proof row, and it constructs one only after

1. the tree rebuilt from a candidate ordering produces a root **byte-equal to
   the OP_RETURN-committed root**, and
2. **every** emitted branch independently re-verifies via `verifyMerkleProof`
   against that same committed root — the exact check an offline verifier runs.

There is no "best effort" mode and no flag to skip the check. Searching
candidate orderings is not guessing, because the chain is the judge: passing a
false ordering would require a second-preimage on double-SHA256.

To confirm by hand, for any generated row:

```bash
# 1. The committed root, straight from the chain (not from our DB):
curl -s https://mempool.space/api/tx/<chain_tx_id> \
  | python3 -c "import json,sys; [print(v['scriptpubkey'][12:]) for v in json.load(sys.stdin)['vout'] if v['scriptpubkey'].startswith('6a')]"
# The OP_RETURN is 'ARKV' (41524b56) + the 32-byte root.

# 2. That root must equal anchor_proofs.merkle_root for the row.
# 3. verifyMerkleProof(anchors.fingerprint, proof_path, <that root>) must be true.
```

Independent spot-checks already performed this way: `be6c8a2b…` (n=3),
`606b7eec…` (n=6), `d2b0407e…` (n=14), `17e830bc…` (n=5), and `f620b559…`
(n=41, whose stored root matches the chain exactly — existing proof rows are
genuine).

---

## 4. What the operator runs

### 4.1 Forward path (do this — it is the permanent fix)

The forward path is now guarded by a real Cloud Scheduler job, **not**
in-process `node-cron` (which does not fire under Cloud Run CPU throttling).

Order matters. Merging the route is not the same as the route existing in prod:

1. Merge this PR.
2. Confirm the deploy actually landed — `gh variable get DEPLOY_WORKER_PAUSED`
   must not be `true`, and `/health` must report a `git_sha` at or after the
   merge. Creating the Scheduler job against a revision that lacks the route
   produces silent `NOT_FOUND` on every fire, with no worker log and no Sentry
   event.
3. Apply migration `0406` to staging, then prod, then reconcile the ledger to
   the numeric prefix per CLAUDE.md §0 rule 10.
4. Create the Scheduler binding:
   ```bash
   gcloud auth login          # project-admin on arkova1
   bash scripts/gcp-setup/cloud-scheduler.sh
   gcloud scheduler jobs describe proof-coverage-monitor --location=us-central1
   ```
5. Verify it fires and reports healthy:
   ```bash
   curl -s -X POST "$WORKER_URL/jobs/proof-coverage-monitor" \
     -H "X-Cron-Secret: $CRON_SECRET" | jq
   # => { "healthy": true, "decision": { "coverageRatio": 1, "reason": "healthy", ... } }
   ```
   Prod Scheduler fires use **OIDC only** — do not add `X-Cron-Secret` to the
   Scheduler job itself; a present-but-mismatched header hard-401s instead of
   falling through to OIDC.

The monitor alerts to Sentry (`source: proof-coverage-monitor`, stable
fingerprint) when coverage over the trailing 24h drops below 99%, escalating to
`error` below 90%. It measures the **window**, not lifetime coverage — folding
in the known backlog would hold the alarm permanently red, and a permanently
red alarm is one nobody reads.

> Note: `scripts/gcp-setup/alert-policies/` are declared-only; as of 2026-08-01
> the `arkova1` project had zero live alert policies and zero notification
> channels. Sentry is the sink that actually pages. Confirm the Sentry issue-alert
> rule exists for tag `alert_type:proof_coverage_regression` — that step is
> UI-only and is not script-automatable.

### 4.2 Backlog (Class A + B — 608 records)

Not run by this PR. It is deliberately operator-triggered and must not be run
against prod from a feature branch.

Prioritise real customer records over the bulk public-records rows: HakiChain
org `f52cd07a-6d8a-4387-9346-23babec84e5c` first, then other paying orgs, then
the remainder. Class A + B together are ~608 rows across 274 transactions, so
this is minutes of work and a handful of chain reads, not a 3.5M-row migration.

### 4.3 Class C — 2,969,630 records

Do **not** attempt to synthesise proofs for these. There is nothing to
reconstruct from and any value written would be fabricated. Record them
honestly as `unreconstructible_order` and surface that state through the verify
API. If offline branches for these are a commercial requirement, the only sound
remedy is **re-anchoring** the affected fingerprints in new batches whose leaf
order is persisted — a product decision with a real on-chain cost, not a
backfill.

---

## 5. Follow-ups this work exposed

1. **`proof-backcatalog-classifier.ts:4-6` is factually wrong.** It asserts the
   ~2.97M back-catalogue are "DIRECT-anchored — one tx per anchor … there is NO
   Merkle tree". Measured: only 163 transactions are single-leaf; 2,054 carry
   >8 leaves and 885 carry 1k–10k. Any run of `proof-materializer` built on
   that premise would have labelled millions of multi-leaf anchors
   `direct_anchored`, which is a false statement about the data. The
   materializer has never run in write mode in prod (`materialize_run_id` is
   NULL on all 505,357 rows), so no damage has been done yet.
2. **`proof-branch-backfill.ts:143`** ends its ordering with
   `.sort((x, y) => x.id.localeCompare(y.id))`, overriding the `created_at`
   order above it, so it only ever tries pure `id ASC` — a hypothesis now
   falsified for legacy batches. As written it will mark every legacy batch
   unrecoverable.
3. **`merkle.ts:55-59` documents a leaf-ordering contract that prod contradicts.**
   It claims `(fingerprint asc, anchor id asc)`; the 2026-08 batches actually
   reconstruct under `id asc`. `sortAnchorsForBatch` only arrived 2026-07-06
   (`b40966290`), so the docstring describes the present, not the data.
4. **`PROOF_MATERIALIZER_CONFIRM` is missing from `docs/reference/ENV.md`.**
