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

Every event in `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`, with its real dispatch sites.
The dashboard catalog (`src/components/webhooks/WebhookEventCatalog.tsx`) cites
this table as its liveness source — a stale row here becomes a false badge
there (that is exactly what happened to the `credential.*` rows before
2026-08-29). When you add, gate, or remove a dispatch site, update this table
in the same PR. Re-verify with:
`git grep -n "dispatchWebhookEvent(" services/worker/src`.

| Event | Schema | Producer(s) | Status |
|---|---|---|---|
| `anchor.submitted` | `AnchorSubmittedPayloadSchema` | `services/worker/src/jobs/anchor.ts` | Live |
| `anchor.secured` | `AnchorSecuredPayloadSchema` | `services/worker/src/jobs/check-confirmations.ts` | Live |
| `anchor.revoked` | `AnchorRevokedPayloadSchema` | `services/worker/src/api/anchor-revoke.ts` (RPC `revoke_anchor`) | Live |
| `anchor.expired` | `AnchorExpiredPayloadSchema` (SCRUM-1735) | `services/worker/src/jobs/anchorExpirySweep.ts` (SCRUM-1736 daily cron at 03:00 UTC; also `POST /jobs/anchor-expiry-sweep` for Cloud Scheduler) | Live |
| `anchor.superseded` | `AnchorSupersededPayloadSchema` | `services/worker/src/api/anchor-lineage.ts` | Live (subscribable via the API allowlist; absent from the dashboard picker — registration handled separately, PR #2433) |
| `anchor.superseded` | `AnchorSupersededPayloadSchema` (SCRUM-2937) | `services/worker/src/api/anchor-lineage.ts` (`POST /api/anchor/:id/supersede`, RPC `supersede_anchor`) | Live |
| `anchor.batch_secured` | `AnchorBatchSecuredPayloadSchema` | merkle-batch path (per-anchor `anchor.secured` events also fan out — SCRUM-1264) | Live |
| `credential.issued` | `CredentialIssuedPayloadSchema` | `services/worker/src/api/v1/credential-sources.ts` (`queueCredentialIssuedAudit`, SCRUM-1798 Phase 2a) | Live, unflagged |
| `credential.verified` | `CredentialVerifiedPayloadSchema` | `services/worker/src/api/v1/verify.ts` + `services/worker/src/api/v1/oracle.ts` (SCRUM-1799) | Wired but dark: BOTH sites gated on `ENABLE_CREDENTIAL_VERIFIED_WEBHOOK` (default false; verified unset in prod 2026-08-29) |
| `credential.status_changed` | `CredentialStatusChangedPayloadSchema` | Four sites (SCRUM-1800): `services/worker/src/api/anchor-revoke.ts` (revoke), `services/worker/src/api/anchor-lineage.ts` (supersede), `services/worker/src/jobs/check-confirmations.ts` (bulk confirm), `services/worker/src/jobs/chain-maintenance.ts` (reorg revert) | Live for any anchor with non-null `credential_type`; no feature flag |
| `compliance.document_expiring` | `ComplianceDocumentExpiringPayloadSchema` | `services/worker/src/routes/cron.ts` (`POST /cron/check-credential-expiry`, behind `ENABLE_EXPIRY_ALERTS`) | Live, flag-gated (BUG-002) |

### Dispatched but UNREGISTERED (validation-bypassed) — BUG-002 shape

These event types have real `dispatchWebhookEvent` call sites but are NOT keys
of `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`, so `validateWebhookPayload` returns
`bypassed: true` — no schema check runs. Because the CRUD allowlist
(`VALID_WEBHOOK_EVENTS`) derives from the same map, no endpoint can subscribe,
so every dispatch currently matches zero endpoints and is a silent no-op. That
is the exact pre-fix `compliance.document_expiring` state: one registration
away from delivering an unvalidated payload. The PR #2433 mirror-drift gate
does NOT catch this class (it compares mirrors against the canonical map,
never dispatch sites against it).

| Event | Dispatch site(s) | Payload risk if ever registered as-is |
|---|---|---|
| `job.completed` | `services/worker/src/api/v1/batch.ts` (complete + failed paths) | `job_id` (internal `batch_verification_jobs` UUID, §6); raw `error` message string |
| `anchor.revocation_anchored` | `services/worker/src/jobs/revocation.ts` | Ships `anchor_id` (internal UUID, §6) AND `fingerprint` (§1.6) in the data block |
| `attestation.created` / `attestation.revoked` | `services/worker/src/api/v1/attestations.ts` | Unaudited here — audit before registering |
| `attestation.active` | `services/worker/src/jobs/attestationAnchor.ts` | Unaudited here — audit before registering |

Registering any of these requires the full "Adding a new event type" checklist
below — the schema is what makes the banned fields impossible, not the
subscription.

`anchor.expired` schema and producer are both live. The `anchorExpirySweep` cron transitions SECURED anchors past `expires_at` (filtering `deleted_at IS NULL`) to EXPIRED in deterministic `expires_at asc, id asc` order, writes a corresponding `audit_events` row, and dispatches `anchor.expired` with deterministic `event_id = "expired-${anchor.public_id}"` (uses public_id, not internal id, per CLAUDE.md §6) so retries dedupe via `webhook_delivery_logs.idempotency_key`. Dispatch failures write a sentinel `anchor.expired_dispatch_failed` audit event for manual recovery via the SCRUM-1738 retry path.

## Adding a new event type

1. Add a `…PayloadSchema` in `payload-schemas.ts`, `.strict()`-mode, with a base extending `ANCHOR_BASE_FIELDS` where applicable.
2. Add it to `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` so `validateWebhookPayload` routes through it (NOT `bypassed: true`).
3. Add tests in `payload-schemas.test.ts` covering: valid payload accepted, banned fields (`anchor_id`, `fingerprint`, `user_id`, `org_id`) rejected, status literal mismatch rejected, non-ISO timestamps rejected.
4. Wire the dispatch site (call `dispatchWebhookEvent(orgId, eventType, eventId, data)`) at the lifecycle transition.
5. If the event is partner-public, update the HakiChain integration brief (Confluence A/42532874 §10) and any partner onboarding pack.

## Things that look risky but are intentional

- `validateWebhookPayload` returns `{ ok: true, bypassed: true }` for unknown event types. The `bypassed` flag is logged at debug level so a typo (`anchor.SUBMITTED` in caps) is detectable, not silent. Don't remove the bypass without first making the allowlist exhaustive — but don't call it harmless either: the concrete types riding it today are listed in "Dispatched but UNREGISTERED" above, and one of them (`anchor.revocation_anchored`) ships §6/§1.6-banned fields that only the missing schema would reject.
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
## 2026-08-29 — producer table corrected: `credential.*` emit points were missing

The "Supported event types" table listed only the five `anchor.*` rows while
`credential.issued` (SCRUM-1798 Phase 2a) and `credential.status_changed`
(SCRUM-1800, four sites) had live, unflagged producers — and the dashboard
catalog, which cites this table as its verification source, was still badging
those events "Not yet active" for orgs already receiving them (§1.13 R-7 cuts
both ways). The table now enumerates every registered type plus the
dispatched-but-unregistered set. `credential.verified` is the one legitimately
dark row: both dispatch sites check `config.enableCredentialVerifiedWebhook`
(`ENABLE_CREDENTIAL_VERIFIED_WEBHOOK`, default false), the env var is absent
from the prod Cloud Run service (verified via `gcloud run services describe
arkova-worker` 2026-08-29), no workflow sets it, and no switchboard read exists
on that path — flipping its badge requires re-verifying that flag in prod, not
this file.

- _Superseded 2026-08-23 by DI-775 / SCRUM-3538 — that drift is closed; see the 2026-08-23 section below. The bullet above is left verbatim because this file is append-only (`scripts/ci/check-agents-md-append-only.ts`): rewriting a merge-base line to record its outcome reads as a deletion and reddens the required `Dependency Scanning` check._
## 2026-08-17 — `response_body`/`error_message` truncation is surrogate-safe

`delivery.ts` bounded `webhook_delivery_logs.response_body` (1000) and `error_message` (500) with
bare `.slice(0, N)`. The receiving endpoint controls the response bytes: a body whose cap boundary
split a surrogate pair made the delivery-log `.update()` itself PGRST102 — status bookkeeping
failing on attacker-controlled input (2026-08-17 poison-record class, PR #2266). All four sites now
use `utils/utf16-truncate.ts` `truncateUtf16Safe`. Poison regression tests live in
`src/tests/webhook-delivery-roundtrip.test.ts` (`response_body surrogate-safe truncation`).

## 2026-08-23 — `anchor.superseded` registration surfaces closed (DI-775 / SCRUM-3538)

The drift recorded above is fixed. `anchor.superseded` was the same bug class as
SCRUM-1794 (`anchor.submitted` / `anchor.batch_secured`) and BUG-002
(`compliance.document_expiring`), but with the halves reversed: the worker side
was already complete — schema registered in `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`
(so `VALID_WEBHOOK_EVENTS` accepted a subscription), and
`services/worker/src/api/anchor-lineage.ts` really dispatches it — while every
*registration* surface omitted it. An org whose record was superseded was sent
an event that no picker, catalog, typed SDK union, or Zap dropdown let it
subscribe to.

**No worker code changed.** The wire contract, the CRUD allowlist and the
dispatch site are untouched; this was purely the registration surfaces catching
up, so it adds no new data egress — `AnchorSupersededPayloadSchema` is still
`.strict()` and `payload-schemas.test.ts` still rejects
`anchor_id` / `fingerprint` / `user_id` / `org_id` on it.

Surfaces now in lockstep (all test-guarded): `WebhookSettings.tsx`
`AVAILABLE_EVENTS`, its pinned drift-guard list, `WebhookEventCatalog.tsx`
`CATALOG_DATA` (`live: true` — real emit point), `src/lib/copy.ts`
`WEBHOOK_EVENT_DESCRIPTIONS`, `packages/sdk/src/types.ts`,
`integrations/zapier/src/constants.ts`, `docs/api/webhooks.md`.

Two of those had no drift guard at all before this change and now do:
`integrations/zapier/test/zapier.test.ts` pins the full ordered `VALID_EVENTS`
set, and `packages/sdk/src/client.test.ts` pins `WebhookEventType` via an
exhaustive `Record<WebhookEventType, true>` (a missing union member fails
`tsc --noEmit`; deleting the pin row to silence that fails `vitest run`).

**Know what those pins do and do not catch.** Every one of them is a hardcoded
list in a workspace that cannot import the worker constant, so each fires only
when someone edits THAT surface and forgets its own pin. None of them keys off
`PAYLOAD_SCHEMAS_BY_EVENT_TYPE`, so none fires when the worker map GROWS and the
mirrors stand still — which is the direction all three incidents (SCRUM-1794,
BUG-002, DI-775) actually travelled. Measured, not assumed: adding a tenth-plus
key to the map leaves `WebhookSettings.test.tsx` + `WebhookEventCatalog.test.tsx`
(40 tests), the Zapier suite (23) and the SDK suite (62, plus `tsc --noEmit`
exit 0) all green. Two of the four are not even reachable from a PR:
`.github/workflows/publish-sdk.yml` runs the SDK tests only on an `sdk-v*` tag,
and no workflow runs the Zapier tests at all.

The ratchet that does key off the source of truth is
`scripts/ci/check-webhook-event-registration-drift.ts`. It parses the map's keys
and compares them against all six mirrors (picker, catalog, `copy.ts`, SDK
union, Zapier constant, `docs/api/webhooks.md` tables), fails closed if any
declaration stops resolving, and runs inside the already-required `Tests` job
via the root vitest `scripts/**` glob — no workflow wiring needed. Register a
schema in this file and that check goes red until every mirror follows.
