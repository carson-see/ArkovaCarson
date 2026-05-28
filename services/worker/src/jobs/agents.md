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
- `professional-education-extraction.ts` — PR #841 CPE/CLE metadata extraction job. Must remain default-disabled through `ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY=false` until prod has the #841 schema columns/tables and ledger reconciliation.
- `attestationAnchor.ts` — `processAttestationAnchoring()` Merkle-batches PENDING attestation fingerprints to Bitcoin via OP_RETURN. Gated by `ENABLE_ATTESTATION_ANCHORING` flag. Dispatches `attestation.active` webhooks and audit events.
- `docusign-notarization-completed.ts` (SCRUM-1872) — `processDocusignNotarizationCompletedJob()` handles queued `docusign.notarization_completed` jobs. Looks up `legally_binding_attestations` by `docusign_envelope_id`, validates org match (cross-tenant guard) and status (`pending_notarization`), updates row to `notarized` with notary metadata, writes NOTARIZATION_COMPLETED audit event. `runDocusignNotarizationCompletedJobs()` is the queue runner. Handler throws on processor failure so `processNextJob` correctly marks the job as failed (not completed).
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


## Open work
- SCRUM-1736 (PR #734) — anchorExpirySweep producer; awaiting Carson merge + Mon 2026-05-11 deploy.
- SCRUM-1737 [Verify] — HakiChain receiver round-trip + Tier 3 48h soak post-merge.
- SCRUM-1738 [Close-out] — Confluence Webhooks topic page update post-merge.
- SCRUM-2040 — `nonce-sweep.ts` sweeps all 4 webhook nonce tables (14-day retention). Migration 0316 adds `sweep_webhook_nonces` RPC (service_role only, REVOKE PUBLIC). Cron route `/nonce-sweep` in `cron.ts`. Scheduler: daily 04:00 UTC.
- SCRUM-2041 — `connector-health-alert.ts` pure decision function + `runConnectorHealthCheck(db)`. Fires Sentry alerts on connector state transitions (connected/degraded/disconnected), 1h cooldown, recovery notifications. Migration 0317 adds `connector_alert_state` table (RLS deny-all for anon+authenticated). Scheduler: every 15 min. **Fail-close (PR #924 review fix):** alert state read failure throws (prevents spurious alerts from empty state map); upsert failure returns `ok:false` / 500 (prevents lost cooldown state). **V1 limitation:** classifies health from `revoked_at` only — does not use `classify()` from `connector-health.ts` for degraded states (subscription_expiry, processing_failure). Future work to integrate full health inputs.
- SCRUM-2042 — `docusign-reconciliation.ts` pure reconciliation function + `docusign-reconciliation-deps.ts` factory. Polls DocuSign Envelopes API for completed envelopes (24h lookback), diffs against `docusign_webhook_nonces`, inserts gap rows into `docusign_reconciliation_gaps` (migration 0318), fires Sentry alert per new gap. Also refreshes OAuth tokens to prevent 30-day expiry on idle connections. SCRUM-2044: `listActiveIntegrations()` now queries both `org_integrations` and `member_integrations`. Cron route `/docusign-reconciliation` in `cron.ts`. Scheduler: daily 06:00 UTC.
