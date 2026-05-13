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
- **`rules-engine.ts` / `rule-action-dispatcher.ts` (SCRUM-1649)** — DocuSign `ESIGN_COMPLETED` rule executions carry sanitized connector metadata into `input_payload`; `AUTO_ANCHOR` and credit-denied `FAST_TRACK_ANCHOR` materialize org-scoped `anchors.status=PENDING` rows with `credential_type=CONTRACT_POSTSIGNING`. Paid fast-track also materializes the anchor before enqueueing `anchor.fast_track`; dispatcher outputs and fast-track job payloads include `anchor_public_id` so downstream consumers can reference the created anchor.
- `publicRecordEmbedder.ts` (PH1-INT-01) — `embedPublicRecords()` generates vector embeddings for unembedded public records. Uses Gemini embedding model via AI provider abstraction. Batched with bounded concurrency (25) and exponential backoff on rate limits. Gated by `ENABLE_PUBLIC_RECORD_EMBEDDINGS` flag.
- `attestationAnchor.ts` — `processAttestationAnchoring()` Merkle-batches PENDING attestation fingerprints to Bitcoin via OP_RETURN. Gated by `ENABLE_ATTESTATION_ANCHORING` flag. Dispatches `attestation.active` webhooks and audit events.
- **`anchorExpirySweep.ts` (SCRUM-1736)** — daily 03:00 UTC sweep that flips `anchors.status` from SECURED to EXPIRED past `expires_at` and dispatches `anchor.expired` outbound webhook. Compare-and-set on UPDATE guards against concurrent revocation. Sentinel `anchor.expired_dispatch_failed` audit row written if dispatch throws so manual recovery is possible (per CodeRabbit PR #734 review). Adapter validates every write via Zod (`AnchorIdSchema`, `AuditEventRowSchema`).
- **`treasury-cache.ts`** — `refreshTreasuryCache()`. Fetches treasury balance, BTC price, fee rates, UTXO count, network info, and anchor stats (via `../utils/anchor-stats.ts`), then upserts into `treasury_cache` singleton. SCRUM-1786: sentinel guard prevents -1 from overwriting last-good cached values.

## Conventions
- Every job exports a single `process<Domain>()` function returning `{processed, failed, errors}`.
- Errors are logged + pushed to `errors[]` but never abort the loop — one bad row never starves the rest.
- Audit failure is non-fatal; transition is the source of truth.
- Service-role DB access only (no anon/authenticated path).

## Architecture Decisions

- **Treasury cache sentinel guard** (SCRUM-1786): Before upserting, if any of `total_secured`, `total_pending`, `last_24h_count` is -1, read existing cache row and preserve last-good values. Defense-in-depth against upstream failures.
- **Anchor stats from pipeline_dashboard_cache** (SCRUM-1786): `fetchAnchorStats()` reads from `pipeline_dashboard_cache` instead of the `get_anchor_status_counts_fast` RPC. The RPC's 1s per-status timeouts produced -1 sentinels on the 2.9M-row anchors table.
- **DocuSign anchor materialization** (SCRUM-1649): Rule execution outputs are no longer the only queue marker. Dispatcher writes a real pending anchor using the DocuSign document SHA-256 supplied through the webhook/rules-engine path. Metadata stores hashed sender/account identifiers only; raw sender email, raw DocuSign account ID, rule ID, and execution ID are not copied to anchor metadata.


## Open work
- SCRUM-1736 (PR #734) — anchorExpirySweep producer; awaiting Carson merge + Mon 2026-05-11 deploy.
- SCRUM-1737 [Verify] — HakiChain receiver round-trip + Tier 3 48h soak post-merge.
- SCRUM-1738 [Close-out] — Confluence Webhooks topic page update post-merge.
