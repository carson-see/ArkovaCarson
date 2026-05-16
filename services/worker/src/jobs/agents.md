# services/worker/src/jobs/agents.md

Background workers for anchor lifecycle, billing reconciliation, drive ingestion, and chain maintenance.

## Files
- `anchor.ts` — `processPendingAnchors()` mints fingerprint Bitcoin txs.
- `batch-anchor.ts` — `processBatchAnchors()` aggregates submitted-but-not-yet-broadcast anchors.
- `check-confirmations.ts` — promotes SUBMITTED anchors to SECURED once block confirmations land.
- `revocation.ts` — `processRevokedAnchors()` mints revocation receipts.
- `chain-maintenance.ts` — reorg detection, stuck-tx monitor, fee-rate monitoring, UTXO consolidation, dropped-tx rebroadcast.
- `broadcast-recovery.ts` — RACE-1 recovery: stuck BROADCASTING anchors → reset to PENDING.
- `credit-expiry.ts` — `processMonthlyCredits()`.
- `publicRecordEmbedder.ts` (PH1-INT-01) — `embedPublicRecords()` generates vector embeddings for unembedded public records. Uses Gemini embedding model via AI provider abstraction. Batched with bounded concurrency (25) and exponential backoff on rate limits. Gated by `ENABLE_PUBLIC_RECORD_EMBEDDINGS` flag.
- `attestationAnchor.ts` — `processAttestationAnchoring()` Merkle-batches PENDING attestation fingerprints to Bitcoin via OP_RETURN. Gated by `ENABLE_ATTESTATION_ANCHORING` flag. Dispatches `attestation.active` webhooks and audit events.
- **`anchorExpirySweep.ts` (SCRUM-1736)** — daily 03:00 UTC sweep that flips `anchors.status` from SECURED to EXPIRED past `expires_at` and dispatches `anchor.expired` outbound webhook. Compare-and-set on UPDATE guards against concurrent revocation. Sentinel `anchor.expired_dispatch_failed` audit row written if dispatch throws so manual recovery is possible (per CodeRabbit PR #734 review). Adapter validates every write via Zod (`AnchorIdSchema`, `AuditEventRowSchema`).
- **`rule-action-dispatcher.ts`** — Routes rule action types from the rules engine: `QUEUE_FOR_REVIEW` (routed marker), `FLAG_COLLISION` (routed marker), `FORWARD_TO_URL` (signed outbound POST + retry), `AUTO_ANCHOR` (DS-07 queue mode — routes to org anchor queue), `FAST_TRACK_ANCHOR` (DS-06 instant secure — credit gate via `deductOrgCredit` then anchor job dispatch; falls to queue with `credit_denied` on insufficient credits). Idempotency via `(rule_id, trigger_event_id)` unique index.
- **`treasury-cache.ts`** — `refreshTreasuryCache()`. Fetches treasury balance, BTC price, fee rates, UTXO count, network info, and anchor stats (via `../utils/anchor-stats.ts`), then upserts into `treasury_cache` singleton. SCRUM-1786: sentinel guard prevents -1 from overwriting last-good cached values.

## Conventions
- Every job exports a single `process<Domain>()` function returning `{processed, failed, errors}`.
- Errors are logged + pushed to `errors[]` but never abort the loop — one bad row never starves the rest.
- Audit failure is non-fatal; transition is the source of truth.
- Service-role DB access only (no anon/authenticated path).

## Architecture Decisions

- **Treasury cache sentinel guard** (SCRUM-1786): Before upserting, if any of `total_secured`, `total_pending`, `last_24h_count` is -1, read existing cache row and preserve last-good values. Defense-in-depth against upstream failures.
- **Anchor stats from pipeline_dashboard_cache** (SCRUM-1786): `fetchAnchorStats()` reads from `pipeline_dashboard_cache` instead of the `get_anchor_status_counts_fast` RPC. The RPC's 1s per-status timeouts produced -1 sentinels on the 2.9M-row anchors table.


## Open work
- SCRUM-1737 [Verify] — HakiChain receiver round-trip + Tier 3 48h soak. PR #815 adds round-trip integration test (15 tests). Awaiting staging soak.
- SCRUM-1738 [Close-out] — Confluence Webhooks topic page update post-merge.
- SCRUM-1658 [Verify] — DS-AUTO-02 E2E verification for instant-secure + queue paths.
