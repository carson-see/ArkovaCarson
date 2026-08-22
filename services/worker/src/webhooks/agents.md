# Outbound webhooks — agents.md

Owner of the **outbound** webhook system. Inbound receivers (DocuSign, Adobe Sign, Microsoft Graph, Drive, Checkr, ATS) live elsewhere — see `services/worker/src/api/v1/webhooks/` for those.

## Files

| File | Role |
|---|---|
| `payload-schemas.ts` | Zod allowlist for outbound payload `data` blocks. The only authority on what fields may leave Arkova on a given event type. Strict mode rejects unknown keys at runtime. CLAUDE.md §6 (no internal UUIDs) + §1.6 (no fingerprints) enforced here. |
| `payload-schemas.test.ts` | Locks the contract for every emitted event type. Banned fields (`anchor_id`, `fingerprint`, `user_id`, `org_id`) are explicitly rejected per schema. New event types MUST land with their own banned-field rejection cases. |
| `delivery.ts` | Delivery engine. HMAC-SHA256 signing (`X-Arkova-Signature`, `X-Arkova-Timestamp`, `X-Arkova-Event` headers), exponential backoff (5 max attempts, 1s base), idempotency keys, circuit breaker (DH-04, 5 consecutive failures → open, 60s half-open), DLQ (DH-12), SSRF protection with DNS rebinding mitigation (ARK-SEC-002, INJ-02), replay (SCRUM-1172), replica-safe per-resource ordering (SCRUM-2250 — uses the `next_webhook_sequence()` RPC / `webhook_event_sequence` Postgres sequence from migration 0337). Gated by `ENABLE_OUTBOUND_WEBHOOKS` flag. |
| `compliance.ts` | Compliance metadata + tagging hooks for outbound events used in audit reporting. |
| `*.test.ts` | Unit + integration coverage for each module. `webhook-delivery-roundtrip.test.ts` (in `tests/`) verifies the full dispatch pipeline end-to-end: anchor lifecycle events, schema enforcement, HMAC signing, SSRF protection, multi-endpoint fan-out, circuit breaker. |

## Supported event types

| Event | Schema | Producer | Status |
|---|---|---|---|
| `anchor.submitted` | `AnchorSubmittedPayloadSchema` | `services/worker/src/jobs/anchor.ts` | Live |
| `anchor.secured` | `AnchorSecuredPayloadSchema` | `services/worker/src/jobs/check-confirmations.ts` | Live |
| `anchor.revoked` | `AnchorRevokedPayloadSchema` | `services/worker/src/api/anchor-revoke.ts` (RPC `revoke_anchor`) | Live |
| `anchor.expired` | `AnchorExpiredPayloadSchema` (SCRUM-1735) | `services/worker/src/jobs/anchorExpirySweep.ts` (SCRUM-1736 daily cron at 03:00 UTC; also `POST /jobs/anchor-expiry-sweep` for Cloud Scheduler) | Live |
| `anchor.batch_secured` | `AnchorBatchSecuredPayloadSchema` | merkle-batch path (per-anchor `anchor.secured` events also fan out — SCRUM-1264) | Live |

`anchor.expired` schema and producer are both live. The `anchorExpirySweep` cron transitions SECURED anchors past `expires_at` (filtering `deleted_at IS NULL`) to EXPIRED in deterministic `expires_at asc, id asc` order, writes a corresponding `audit_events` row, and dispatches `anchor.expired` with deterministic `event_id = "expired-${anchor.public_id}"` (uses public_id, not internal id, per CLAUDE.md §6) so retries dedupe via `webhook_delivery_logs.idempotency_key`. Dispatch failures write a sentinel `anchor.expired_dispatch_failed` audit event for manual recovery via the SCRUM-1738 retry path.

## Adding a new event type

1. Add a `…PayloadSchema` in `payload-schemas.ts`, `.strict()`-mode, with a base extending `ANCHOR_BASE_FIELDS` where applicable.
2. Add it to `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` so `validateWebhookPayload` routes through it (NOT `bypassed: true`).
3. Add tests in `payload-schemas.test.ts` covering: valid payload accepted, banned fields (`anchor_id`, `fingerprint`, `user_id`, `org_id`) rejected, status literal mismatch rejected, non-ISO timestamps rejected.
4. Wire the dispatch site (call `dispatchWebhookEvent(orgId, eventType, eventId, data)`) at the lifecycle transition.
5. If the event is partner-public, update the HakiChain integration brief (Confluence A/42532874 §10) and any partner onboarding pack.

## Things that look risky but are intentional

- `validateWebhookPayload` returns `{ ok: true, bypassed: true }` for unknown event types — non-anchor events (`payment.*`, `org.*`) ride a separate dispatch path until they get their own schemas. The `bypassed` flag is logged at debug level so a typo (`anchor.SUBMITTED` in caps) is detectable, not silent. Don't remove the bypass without first making the allowlist exhaustive.
- `secret_hash` column on `webhook_endpoints` IS the raw HMAC key — naming is historical (migration 0046). Consumers receive this exact value at endpoint creation. Don't second-guess and try to hash it again.
- Delivery idempotency key is `${endpoint.id}-${payload.event_id}` (no attempt number) — RACE-6 fix prevents duplicate deliveries across retry attempts after worker restart.
- Replay deliveries (`replayDelivery`) intentionally always create a new `webhook_delivery_logs` row keyed by `replay-${deliveryId}-${ms}-${randomHex}` so the original is preserved for audit and the existing-row idempotency check can't short-circuit the resend.
- **Per-resource ordering (SCRUM-2250, BUG-2026-05-16-001 SEV1):** every dispatched payload carries two additive-nullable top-level *wire* fields — `resource_key` (derived from `data.public_id`, namespaced by event family, e.g. `anchor:pub-001`; null for aggregate events like `anchor.batch_secured`) and `sequence` (a strictly-monotonic int). They are stamped in `dispatchWebhookEvent` and frozen into `webhook_delivery_logs.payload`, so a retry preserves the original dispatch-time sequence. Consumers detect/reject out-of-order delivery for the SAME resource by comparing `sequence` within a `resource_key`. The wire fields stay additive (§1.8, no v2 bump). **Replica-safe sequence source (review-fix):** `sequence` is allocated from a single global **Postgres sequence** `webhook_event_sequence`, read via the `next_webhook_sequence()` SECURITY DEFINER RPC (the worker reaches PG only through PostgREST/service_role). This is the SEV1 root-cause fix: the worker runs 2–10 Cloud Run replicas, and same-resource lifecycle events are emitted from DIFFERENT replicas — an in-process `Date.now()` counter could stamp a later event from a clock-skewed replica with a LOWER sequence, inverting order. `nextval()` is atomic + globally monotonic with no clock dependency. The new DB object (migration **0337**) re-tiers this PR to **T3**. If the RPC is unreachable at dispatch, `sequence` is stamped `null` (no ordering asserted, treated as legacy) + a Sentry `sequence_alloc` capture — never a fabricated value, so a false ordering is impossible. The retry sweep (`processWebhookRetries`) selects its 50-row window ordered by `payload->sequence ASC NULLS FIRST` (jsonb `->`, numeric compare — **not** `->>` which would sort lexicographically), so under a backlog the window is the globally-oldest events and a resource's true head is never starved by a newer in-window sibling. It then partitions `retrying` rows by `(endpoint_id, resource_key)` and delivers only the lowest-`sequence` head-of-line row per resource each sweep. Distinct resources (and legacy rows with no `resource_key`) form independent groups delivered concurrently via `Promise.allSettled`, so cross-document throughput is preserved (NOT a global serializer). Don't "optimize" the sweep back to a flat `for` loop over all rows, drop the `payload->sequence` ORDER BY, or replace the RPC with an in-memory counter — each reintroduces the out-of-order corruption.
- **Drop-to-DLQ ordering contract (SCRUM-2250):** per-resource ordering holds only while the head-of-line event is *live*. When a head exhausts its retries (`attempt >= MAX_RETRIES`), it transitions to `failed`, moves to the dead-letter queue (`moveToDeadLetterQueue`), and thereby leaves the `status='retrying'` set. On the next sweep the next-lowest-`sequence` event for that resource becomes the head and proceeds. So a poison head does **not** block its resource forever — it is dead-lettered and the newer events advance, in order. Consumers must treat a *gap* in the per-resource `sequence` (a missing intermediate event) as "an earlier event was dead-lettered, reconcile via the DLQ", NOT as a reason to reject the newer event. This is the intended liveness/ordering trade-off: strict in-order while the head is live, fail-forward once the head is dead-lettered.

- **Idempotency-lookup retry + DLQ (WH-3, SCRUM-2899):** the idempotency `SELECT` at the top of `deliverToEndpoint` was the last unprotected DB read on the delivery path — a transient failure did `Sentry` + `return false` with no retry and no durable record (the ~13/wk SILENT event drops). It now retries ONCE on a connection-level error, then, on any persistent non-`PGRST116` failure, routes the event to `moveToDeadLetterQueue(..., 'log_write')` before returning false — same audit-integrity class + `failure_kind` as the delivery-log write-failure path, so NO new migration (keeps this change **T2**). Deduped via the 0338 partial unique index. Don't drop the DLQ call back to a bare `return false`.
- **Flag-read cache (WH-4, SCRUM-2899):** `dispatchWebhookEvent` reads `ENABLE_OUTBOUND_WEBHOOKS` via `isOutboundWebhooksEnabled()`, a 30s in-process cache, **fail-closed** (an RPC error returns `false` and is NOT cached). Tests must call `__resetWebhookFlagCacheForTest()` in `beforeEach` (frozen fake timers never expire the TTL). A flag flip ON takes effect within one TTL.
- **Bounded dispatch fan-out (WH-5, SCRUM-2899):** the happy-path fan-out uses `mapWithConcurrency(endpoints, DISPATCH_CONCURRENCY=12, …)` instead of an unbounded `Promise.all`, so a many-endpoint burst can't exhaust the socket pool (the same burst that rots keep-alive sockets). `deliverToEndpoint` never throws, so non-aborting semantics are preserved.

## SOC 2 DC 200

System description for this module is documented in Confluence under SCRUM-1735. When changing this module, re-verify the description (services, commitments, components, risk assessment, control environment, CUECs) is still accurate.

## SSRF guard extract (SCRUM-2483)

- The private-IP classifier (`isPrivateIp`, `PRIVATE_IP_PATTERNS`, `BLOCKED_HOSTNAMES`) + DNS-resolution helper were lifted **byte-identically** from `delivery.ts` into `../lib/ssrf-guard.ts` so this webhook guard and the new `safeFetch` egress primitive share ONE source of truth. `delivery.ts` re-exports them, so `isPrivateUrl`/`isPrivateUrlResolved` and every importer (`api/v1/webhooks.ts`, `credential-sources.ts`) are unchanged — no behaviour delta on the webhook delivery path. Edit the blocklist in `ssrf-guard.ts`, not here.

## 2026-08-15 — `compliance.document_expiring` registered (BUG-002)

`POST /cron/check-credential-expiry` has dispatched `compliance.document_expiring` since SCRUM-600, but the type was never in `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`. Two consequences, and the second is the security one:

1. `VALID_WEBHOOK_EVENTS` is **derived** from that map, so the CRUD allowlist rejected the type and **no endpoint could ever subscribe** — every dispatch matched zero endpoints and was silently a no-op.
2. An unregistered type takes the `bypassed: true` branch of `validateWebhookPayload` — no schema, no check. The emit site was shipping `anchor_id` (the internal UUID, CLAUDE.md §6) plus a `title` key that was always `undefined`. It was one subscription away from being deliverable.

Registering it is what makes (2) impossible, not just what turns the feature on: `ComplianceDocumentExpiringPayloadSchema` is `.strict()`, so `anchor_id` now fails validation before anything is signed.

- **Distinct from `anchor.expired` on purpose.** This is the ADVANCE warning — `status` is `SECURED` and only `SECURED`, `days_remaining` is a positive int. `anchor.expired` fires after the fact, once `anchorExpirySweep` has already transitioned the record to `EXPIRED`; a subscriber acting on it is by definition too late to renew.
- No chain fields. This event is about a calendar date, not an on-chain transition; the receipt already rides `anchor.secured`.
- `credential_type` is nullable rather than defaulted. `anchors.credential_type` is nullable and the pre-fix emit site substituted `'OTHER'`, asserting a classification nobody measured (§1.5).
- Catalog entry is `live: true` — the emit point is real, behind `ENABLE_EXPIRY_ALERTS`. Registration points kept in lockstep (all test-guarded): `WebhookSettings.tsx` `AVAILABLE_EVENTS`, its pinned drift-guard list, `WebhookEventCatalog.tsx` `CATALOG_DATA`, `src/lib/copy.ts` `WEBHOOK_EVENT_DESCRIPTIONS`, `packages/sdk/src/types.ts`, `integrations/zapier/src/constants.ts`, `docs/api/webhooks.md`.
- **Known pre-existing drift, NOT introduced here:** `anchor.superseded` is in `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` but absent from `AVAILABLE_EVENTS` and the pinned list. Left alone rather than folded into this fix.
