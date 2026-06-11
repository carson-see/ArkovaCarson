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
- **`rules-engine.ts` / `rule-action-dispatcher.ts` (SCRUM-1649)** — DocuSign `ESIGN_COMPLETED` rule executions carry allowlisted connector metadata into `input_payload`; raw provider payload fields stay out of execution storage, and raw DocuSign account IDs are hashed before persistence. `AUTO_ANCHOR` and credit-denied `FAST_TRACK_ANCHOR` materialize org-scoped `anchors.status=PENDING` rows with `credential_type=CONTRACT_POSTSIGNING`. Paid fast-track also materializes the anchor before enqueueing `anchor.fast_track`; dispatcher outputs and fast-track job payloads include `anchor_public_id` so downstream consumers can reference the created anchor. FAST_TRACK retries are keyed by the execution id for org-credit idempotency and reuse an existing `anchor.fast_track` job instead of enqueueing duplicates after a crash/finalization retry.
- `publicRecordEmbedder.ts` (PH1-INT-01) — `embedPublicRecords()` generates vector embeddings for unembedded public records. Uses Gemini embedding model via AI provider abstraction. Batched with bounded concurrency (25) and exponential backoff on rate limits. Gated by `ENABLE_PUBLIC_RECORD_EMBEDDINGS` flag.
- `professional-education-extraction.ts` — PR #841 CPE/CLE metadata extraction job. Must remain default-disabled through `ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY=false` until prod has the #841 schema columns/tables and ledger reconciliation.
- `docusign-envelope-completed.ts` — DocuSign completed-envelope document fetch cron. Uses the DocuSign outbound rate-limit wrapper so token refresh and combined-document fetch calls spend the same per-account 3,000/hour budget and honor `Retry-After` on 429.
- `attestationAnchor.ts` — `processAttestationAnchoring()` Merkle-batches PENDING attestation fingerprints to Bitcoin via OP_RETURN. Gated by `ENABLE_ATTESTATION_ANCHORING` flag. Dispatches `attestation.active` webhooks and audit events.
- `docusign-notarization-completed.ts` (SCRUM-1872) — `processDocusignNotarizationCompletedJob()` handles queued `docusign.notarization_completed` jobs. Looks up `legally_binding_attestations` by `docusign_envelope_id`, validates org match (cross-tenant guard) and status (`pending_notarization`), updates row to `notarized` with notary metadata, writes NOTARIZATION_COMPLETED audit event. `runDocusignNotarizationCompletedJobs()` is the queue runner. Handler throws on processor failure so `processNextJob` correctly marks the job as failed (not completed).
- **`anchorExpirySweep.ts` (SCRUM-1736)** — daily 03:00 UTC sweep that flips `anchors.status` from SECURED to EXPIRED past `expires_at` and dispatches `anchor.expired` outbound webhook. Compare-and-set on UPDATE guards against concurrent revocation. Sentinel `anchor.expired_dispatch_failed` audit row written if dispatch throws so manual recovery is possible (per CodeRabbit PR #734 review). Adapter validates every write via Zod (`AnchorIdSchema`, `AuditEventRowSchema`).
- **`treasury-cache.ts`** — `refreshTreasuryCache()`. Fetches treasury balance, BTC price, fee rates, UTXO count, network info, and anchor stats (via `../utils/anchor-stats.ts`), then upserts into `treasury_cache` singleton. SCRUM-1786: sentinel guard prevents -1 from overwriting last-good cached values.
- **`stuck-anchor-monitor.ts` (SCRUM-2234 / 2026-06-01 incident)** — pipeline-stall watchdog. `decideStuckAnchorAlert()` is a pure, clock-injectable decision fn; `runStuckAnchorCheck(db)` is the cron glue. Measures the AGE of the oldest non-deleted PENDING anchor (`select created_at from anchors where status='PENDING' and deleted_at is null order by created_at asc limit 1` — index-backed LIMIT 1, NOT count(*)) and, when it exceeds `STUCK_ANCHOR_ALERT_HOURS` (default 24h), logs at error level + calls `captureStuckAnchorAlert()` so hourly re-fires share the stable `stuck-anchor-monitor` Sentry fingerprint. Alert context stays aggregate-only (age, pending count, threshold; read from `pipeline_dashboard_cache`, never counted). Distinct from `pipeline-health.ts`: that keys off `updated_at`/30-min + emails; the daily-flush 401 blackout left a *fresh* `updated_at` but *stale* `created_at`, so this is the missed signal. The oldest-PENDING query throws on DB error (cron route → 500, Scheduler retries); a detected stall returns 200 (a correct detection, no retry). Pure fn + cron-glue shape mirrors `connector-health-alert.ts` / `treasury-alert.ts`.

## Conventions
- Every job exports a single `process<Domain>()` function returning `{processed, failed, errors}`.
- Errors are logged + pushed to `errors[]` but never abort the loop — one bad row never starves the rest.
- Audit failure is non-fatal; transition is the source of truth.
- Service-role DB access only (no anon/authenticated path).

## Architecture Decisions

- **Treasury cache sentinel guard** (SCRUM-1786): Before upserting, if any of `total_secured`, `total_pending`, `last_24h_count` is -1, read existing cache row and preserve last-good values. Defense-in-depth against upstream failures.
- **Anchor stats from pipeline_dashboard_cache** (SCRUM-1786): `fetchAnchorStats()` reads from `pipeline_dashboard_cache` instead of the `get_anchor_status_counts_fast` RPC. The RPC's 1s per-status timeouts produced -1 sentinels on the 2.9M-row anchors table.
- **N+1 fan-out elimination** (SCRUM-1296): Sequential per-row DB round-trips replaced with bounded concurrency or bulk operations in hot-path jobs. Pattern details below.
- **DocuSign anchor materialization** (SCRUM-1649): Rule execution outputs are no longer the only queue marker. Dispatcher writes a real pending anchor using the DocuSign document SHA-256 supplied through the webhook/rules-engine path. Metadata stores hashed sender/account identifiers only; raw sender email, raw DocuSign account ID, rule ID, and execution ID are not copied to anchor metadata.
- **Queue-run credit gate parity** (SCRUM-1649): The legacy batch-anchor fallback path must enforce the same org credit gate as the claim-RPC path before broadcasting anchors. Queue credit metadata writes are Zod-validated before updating `anchors.metadata`; if validation or credit marking fails, the anchor is released to `PENDING` and is not broadcast. Refund failures throw before claimed anchors are reverted, keeping charged rows out of automatic retry until an operator can reconcile.

### N+1 Cleanup Patterns (SCRUM-1296)

Affected jobs and their concurrency model:

| Job | Strategy | Rationale |
|---|---|---|
| `revocation.ts` | **Sequential** (unchanged) | UTXO selection from a shared treasury wallet is not safe under concurrency — double-spend risk |
| `broadcast-recovery.ts` | `Promise.allSettled` in chunks of 100 | DB fan-out only; no chain interaction during recovery reset. Per-anchor metadata preserved. |
| `cloud-logging-drain` | Bulk RPC (`bump_cloud_logging_retry_counts`) | Read-modify-write loops replaced with single atomic DB call |
| `attestationExpiry` | Bulk insert (chunked 100) + ordering fix | Webhooks collected then bulk-inserted BEFORE status update to prevent permanent loss |

Key implementation patterns:

- **Chunked `Promise.allSettled`**: `broadcast-recovery` fires up to 100 concurrent DB updates per chunk. Per-anchor metadata is preserved in each update payload.
- **Chunked `.in()` queries**: Supabase `.in()` filter calls are chunked at **100 IDs per batch** to stay within PostgREST query-string limits and avoid request-size failures on large result sets.
- **`bump_cloud_logging_retry_counts` RPC** (migration `0316`, `SECURITY DEFINER`): Atomically increments retry counts for a batch of IDs in a single DB round-trip, replacing the prior read-modify-write loop. Accepts an array of IDs; returns updated count.
- **Bulk updates with per-anchor metadata**: `broadcast-recovery` preserves per-anchor `recovery_metadata` in bulk update payloads — each anchor retains its own failure context even within a batched write.

## Open work
- SCRUM-1736 (PR #734) — anchorExpirySweep producer; awaiting Carson merge + Mon 2026-05-11 deploy.
- SCRUM-1737 [Verify] — HakiChain receiver round-trip + Tier 3 48h soak post-merge.
- SCRUM-1738 [Close-out] — Confluence Webhooks topic page update post-merge.
- SCRUM-2040 — `nonce-sweep.ts` sweeps all 4 webhook nonce tables (14-day retention). Migration 0316 adds `sweep_webhook_nonces` RPC (service_role only, REVOKE PUBLIC). Cron route `/nonce-sweep` in `cron.ts`. Scheduler: daily 04:00 UTC.
- SCRUM-2041 — `connector-health-alert.ts` pure decision function + `runConnectorHealthCheck(db)`. Fires Sentry alerts on connector state transitions (connected/degraded/disconnected), 1h cooldown, recovery notifications. Migration 0317 adds `connector_alert_state` table (RLS deny-all for anon+authenticated). Scheduler: every 15 min. **Fail-close (PR #924 review fix):** alert state read failure throws (prevents spurious alerts from empty state map); upsert failure returns `ok:false` / 500 (prevents lost cooldown state). **V1 limitation:** classifies health from `revoked_at` only — does not use `classify()` from `connector-health.ts` for degraded states (subscription_expiry, processing_failure). Future work to integrate full health inputs.
- SCRUM-2042 — `docusign-reconciliation.ts` pure reconciliation function + `docusign-reconciliation-deps.ts` factory. Polls DocuSign Envelopes API for completed envelopes (24h lookback), diffs against `docusign_webhook_nonces`, inserts gap rows into `docusign_reconciliation_gaps` (migration 0318), fires Sentry alert per new gap. Also refreshes OAuth tokens to prevent 30-day expiry on idle connections. SCRUM-2044: `listActiveIntegrations()` now queries both `org_integrations` and `member_integrations`. Cron route `/docusign-reconciliation` in `cron.ts`. Scheduler: daily 06:00 UTC.
- SCRUM-2098 — `docusign-listener-drift.ts` pure Connect-listener config drift check + `docusign-listener-drift-deps.ts` factory. Reuses the SCRUM-2042 active-integration/token-refresh dependency path, reads DocuSign GET `/connect`, compares against the same `buildArkovaConnectConfig()` payload used by provisioning, and reports Sentry warnings for missing/disabled/HMAC/event/payload-format drift. Detection only; no DocuSign writes and no scheduler mutation in the cleanup lane. Local cron route: `/jobs/docusign-listener-drift`.
