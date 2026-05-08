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
- **`anchorExpirySweep.ts` (SCRUM-1736)** — daily 03:00 UTC sweep that flips `anchors.status` from SECURED to EXPIRED past `expires_at` and dispatches `anchor.expired` outbound webhook. Compare-and-set on UPDATE guards against concurrent revocation. Sentinel `anchor.expired_dispatch_failed` audit row written if dispatch throws so manual recovery is possible (per CodeRabbit PR #734 review). Adapter validates every write via Zod (`AnchorIdSchema`, `AuditEventRowSchema`).

## Conventions
- Every job exports a single `process<Domain>()` function returning `{processed, failed, errors}`.
- Errors are logged + pushed to `errors[]` but never abort the loop — one bad row never starves the rest.
- Audit failure is non-fatal; transition is the source of truth.
- Service-role DB access only (no anon/authenticated path).

## Open work
- SCRUM-1736 (PR #734) — anchorExpirySweep producer; awaiting Carson merge + Mon 2026-05-11 deploy.
- SCRUM-1737 [Verify] — HakiChain receiver round-trip + Tier 3 48h soak post-merge.
- SCRUM-1738 [Close-out] — Confluence Webhooks topic page update post-merge.
