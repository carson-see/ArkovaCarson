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
| `anchor.superseded` | `AnchorSupersededPayloadSchema` (SCRUM-2937) | `services/worker/src/api/anchor-lineage.ts` (`POST /api/anchor/:id/supersede`, RPC `supersede_anchor`) | Live |
| `anchor.superseded` | `AnchorSupersededPayloadSchema` | `services/worker/src/api/anchor-lineage.ts` | Live (subscribable via the API allowlist; absent from the dashboard picker — registration handled separately, PR #2433) |
| `anchor.batch_secured` | `AnchorBatchSecuredPayloadSchema` | merkle-batch path (per-anchor `anchor.secured` events also fan out — SCRUM-1264) | Live |
| `credential.issued` | `CredentialIssuedPayloadSchema` | `services/worker/src/api/v1/credential-sources.ts` (`queueCredentialIssuedAudit`, SCRUM-1798 Phase 2a) | Live, unflagged |
| `credential.verified` | `CredentialVerifiedPayloadSchema` | `services/worker/src/api/v1/verify.ts` + `services/worker/src/api/v1/oracle.ts` (SCRUM-1799) | Wired but dark: BOTH sites gated on `ENABLE_CREDENTIAL_VERIFIED_WEBHOOK` (default false; verified unset in prod 2026-08-29) |
| `credential.status_changed` | `CredentialStatusChangedPayloadSchema` | Four sites (SCRUM-1800): `services/worker/src/api/anchor-revoke.ts` (revoke), `services/worker/src/api/anchor-lineage.ts` (supersede), `services/worker/src/jobs/check-confirmations.ts` (bulk confirm), `services/worker/src/jobs/chain-maintenance.ts` (reorg revert) | Live for any anchor with non-null `credential_type`; no feature flag |
| `compliance.document_expiring` | `ComplianceDocumentExpiringPayloadSchema` | `services/worker/src/routes/cron.ts` (`POST /cron/check-credential-expiry`, behind `ENABLE_EXPIRY_ALERTS`) | Live, flag-gated (BUG-002) |
| `suborg.created` | `SubOrgCreatedPayloadSchema` (SCRUM-3972) | `services/worker/src/api/v1/orgSubOrgs.ts` `POST /org/sub-orgs/create`, via `webhooks/subOrgEvents.ts` `emitSubOrgEvent` | Live, unflagged. Parent org id only. |
| `suborg.approved` | `SubOrgApprovedPayloadSchema` (SCRUM-3972) | `services/worker/src/api/v1/orgSubOrgs.ts` `POST /org/sub-orgs/approve` (shared status-action handler), via `emitSubOrgEvent` | Live, unflagged. Parent org id only. |
| `suborg.revoked` | `SubOrgRevokedPayloadSchema` (SCRUM-3972) | `services/worker/src/api/v1/orgSubOrgs.ts` `POST /org/sub-orgs/revoke` (shared status-action handler), via `emitSubOrgEvent` | Live, unflagged. Parent org id only. |
| `suborg.credits_allocated` | `SubOrgCreditsAllocatedPayloadSchema` (SCRUM-3972) | `services/worker/src/api/v1/orgSubOrgs.ts` `POST /org/sub-orgs/credits` (positive `amount`), via `emitSubOrgEvent` | Live, unflagged. Parent AND affiliate org id (`CHILD_NOTIFIED_SUBORG_EVENTS`). |
| `suborg.credits_reclaimed` | `SubOrgCreditsReclaimedPayloadSchema` (SCRUM-3972) | `services/worker/src/api/v1/orgSubOrgs.ts` `POST /org/sub-orgs/credits` (negative `amount`) AND the reclaim step of `POST /org/sub-orgs/offboard`, via `emitSubOrgEvent` | Live, unflagged. Parent AND affiliate org id. The two producers are separate requests, each emitting exactly once for its own call — neither delegates to the other's handler, so there is no double-emit. |
| `suborg.suspended` | `SubOrgSuspendedPayloadSchema` (SCRUM-3972) | `services/worker/src/api/v1/orgSubOrgs.ts` `POST /org/sub-orgs/offboard` (only when the affiliate was not already suspended), via `emitSubOrgEvent` | Live, unflagged. Parent AND affiliate org id. |
| `suborg.offboarded` | `SubOrgOffboardedPayloadSchema` (SCRUM-3972) | `services/worker/src/api/v1/orgSubOrgs.ts` `POST /org/sub-orgs/offboard`, via `emitSubOrgEvent` | Live, unflagged. Parent AND affiliate org id. |

**Cross-organization fan-out (SCRUM-3972, separate from the table above).** `webhooks/suborg-fanout.ts` widens the endpoint selection in `dispatchWebhookEvent` so an `anchor.*` / `credential.*` event owned by an APPROVED affiliate can ALSO reach a **parent** endpoint whose `scope` column (migration 0454) is `self_and_descendants`. This is gated by `ENABLE_SUBORG_WEBHOOK_FANOUT` (`config.ts`, `boolFlag(false)`) — dark until the founder flips it, because it reverses decision D2 (`orgSubOrgs.ts` — a parent sees what its affiliates SPEND, never what they secured). The seven `suborg.*` events in the table above are NOT behind this flag: they are the parent's own affiliation actions on the parent's own (and, for four of them, the affiliate's own) org id, so no boundary is crossed. One hop only, never upward (an affiliate's endpoint never receives its parent's events), and a cross-organization payload always carries `org_public_id` — see the file header of `suborg-fanout.ts` for the full authority and caching rules.

**Fan-out predicate, as amended by CTO review 2026-09-12.** A child's event reaches a parent endpoint only when `parent_org_id` matches, `parent_approval_status = 'APPROVED'`, **and `organizations.suspended` is false**. The suspension check is load-bearing and not redundant: `suspend_suborg` (migration 0290) flips `suspended` and never moves `parent_approval_status`, so an offboarded affiliate reads `APPROVED` permanently — approval alone would keep streaming a former affiliate's secured-record public ids to its ex-parent forever. Separately, the `suborg.*` family is excluded from fan-out by event-type prefix: those events are already addressed to the parent directly, and their `.strict()` schemas cannot carry `org_public_id`, so fanning them would produce either a duplicate or an error-level Sentry alarm on an entirely correct request. Both are pinned in `delivery.suborgScope.test.ts`.

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
- _Superseded 2026-08-23 by DI-775 / SCRUM-3538 — that drift is closed; see the 2026-08-23 section below. The bullet above is left verbatim because this file is append-only (`scripts/ci/check-agents-md-append-only.ts`): rewriting a merge-base line to record its outcome reads as a deletion and reddens the required `Dependency Scanning` check._
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

## 2026-09-12 — banned fields refused on EVERY outbound payload + attestation events registered (SCRUM-3982)

Two changes in `payload-schemas.ts`, one ratchet and one registration.

**1. `BANNED_PAYLOAD_KEYS` is now enforced, not just documented.** This file's
header has listed `anchor_id` / `fingerprint` / `org_id` / `user_id` / `_`-led
keys as banned since SCRUM-1268, but the only thing that enforced them was
`.strict()` on the per-event schemas — which never ran for an event type that
was not a key of `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`. That unregistered path is the
one every incident in this class actually travelled (SCRUM-1794, BUG-002, and
the two live producers below). `validateWebhookPayload` now scans top-level
payload keys against that list **before** the registry lookup, so the ban binds
registered and unregistered types alike and returns `ok: false`; `delivery.ts`
already error-logs and throws on that, unchanged.

The error names the offending KEY and never its value — the value is exactly
the fingerprint or UUID being refused, and the message reaches logs, Sentry and
`job_queue.last_error`.

**2. `attestation.created` + `attestation.revoked` registered**, appended after
`compliance.document_expiring`, with public-id-only `.strict()` schemas and all
six ordered mirrors updated in the same commit
(`scripts/ci/check-webhook-event-registration-drift.ts` names them).
`services/worker/src/api/v1/attestations.ts` stopped putting `fingerprint`
(CLAUDE.md §1.6) in the `attestation.created` payload.

| Event | Schema | Producer | Status |
|---|---|---|---|
| `attestation.created` | `AttestationCreatedPayloadSchema` (SCRUM-3982) | `services/worker/src/api/v1/attestations.ts` (`POST /api/v1/attestations`) | Live. The `profiles` lookup selects `org_id`, so the dispatch guard can be true |
| `attestation.revoked` | `AttestationRevokedPayloadSchema` (SCRUM-3982) | `services/worker/src/api/v1/attestations.ts` (`PATCH /api/v1/attestations/:publicId/revoke`) | Registered + subscribable, **never dispatched**: the guard reads `attestation.attester_org_id` while the ownership query selects only `id, status, attester_user_id`, so it is always false |

### What this PR deliberately did NOT close — stated gaps

- **Seven event types remain dispatched-but-unregistered**: `attestation.active`,
  `anchor.revocation_anchored`, `job.completed`, `compliance.anchor_delayed`,
  `compliance.certificate_expiring`, `compliance.signature_revoked`,
  `compliance.timestamp_coverage_low`. A clean payload on any of them still
  passes with `bypassed: true`, by design — the ban is on the FIELDS, not on
  being unregistered, and refusing unknown types wholesale would break seven
  live call sites at once with no subscriber benefit (nothing can subscribe to
  an unregistered type).
- **Two of those producers ship banned fields and are refused at this boundary
  rather than fixed at source**: `services/worker/src/jobs/revocation.ts`
  (`anchor_id` + `fingerprint`) and `services/worker/src/jobs/attestationAnchor.ts`
  (`fingerprint`). Both are T3 anchor-lifecycle files, and both wrap the
  dispatch in a non-fatal try/catch, so the refusal costs a warn log and the
  job continues. Their payloads must be rewritten public-id-only in a T3
  change, not here.
- **`job_id`, `certificate_id` and `signature_id` are NOT in
  `BANNED_PAYLOAD_KEYS`.** They are internal UUIDs on unregistered events, and
  they still pass. The ban list is derived from what this file's header
  declares, and widening it is a separate decision; registering those events
  with public-id-only schemas is the real fix.
- **The scan is top-level only**, matching what `.strict()` does for registered
  types. A banned key nested inside a sub-object is not caught. No current
  producer nests one.
- **`webhook_endpoints.events` still has no allow-list CHECK**, so a row can
  name an event type the registry does not know. Deferred deliberately: it
  couples with SCRUM-3972's seven new `suborg.*` entries.

### Correction to the SCRUM-3982 ticket text

The ticket claimed `anchor.batch_secured` "is never emitted". Measured against
this tree: `services/worker/src/jobs/check-confirmations.ts:153` and `:169` do
carry `event_type: 'anchor.batch_secured'`, but those build `audit_events`
rows, not webhook dispatches. `git grep -n "dispatchWebhookEvent(" services/worker/src`
returns no `anchor.batch_secured` call site anywhere, so the event is
registered, subscribable, and documented while nothing dispatches it. The
ticket's claim is correct for webhooks; what exists is an audit row that shares
the name.

## CTO review of SCRUM-3982 (2026-09-12) — what changed and why

The first cut of the ratchet was correct about the leak class and wrong about
three of its own premises. All three were found by reading the subscription
path and the producers rather than the diff.

### The stated gaps above are superseded

- **"Nothing can subscribe to an unregistered type" is FALSE.** It holds for
  `POST /api/v1/webhooks`, whose Zod schema restricts `events` to
  `VALID_WEBHOOK_EVENTS` — but that route is one of three writers.
  `create_webhook_endpoint(p_url, p_events)` is `SECURITY DEFINER`, `GRANT`ed to
  `authenticated`, and inserts `p_events` with no allowlist check; and
  `webhook_endpoints_insert_org` / `webhook_endpoints_update_org` let any
  ORG_ADMIN write the `events` column directly through PostgREST. There is no
  CHECK constraint. So an unregistered type **is** subscribable and was being
  delivered with nothing having inspected it. Unregistered types now FAIL
  CLOSED; the seven with live dispatch sites are grandfathered on
  `LEGACY_UNREGISTERED_EVENT_TYPES`, which is a shrinking ratchet, not a
  permanent carve-out.
- **The scan is no longer top-level only.** `jobs/attestationAnchor.ts` builds a
  nested `metadata` object, so "top level mirrors `.strict()`" was not a mirror
  of anything on the unregistered path — `.strict()` is the authority for
  registered types, and the scan is the authority where there is no schema.
  `findBannedPayloadKeys` now recurses into objects and arrays and reports
  dotted paths.
- **The ban list is derived, not hand-written.** `BANNED_PAYLOAD_KEYS` is
  `BANNED_RESPONSE_KEYS` (api/v1/response-schemas.ts) ∪ `fingerprint`. A webhook
  payload is a more exposed surface than a response body, so the response ban
  binds here a fortiori, and the two lists can no longer drift. Matching is
  normalised (camelCase → snake_case, lowercased), covers qualified spellings
  (`attester_org_id`, `source_anchor_id`) and anything containing `fingerprint`
  (`document_fingerprint`, `fingerprint_sha256`). `job_id` / `certificate_id` /
  `signature_id` remain deliberately un-banned — see the note above; that is
  unchanged and still tracked on SCRUM-5063.

### The ratchet binds every path out of the process, not just the first dispatch

`dispatchWebhookEvent` only ever sees an event's FIRST dispatch. Two other
paths re-sign a payload read back from `webhook_delivery_logs.payload`:

- `replayDelivery` (`POST /api/v1/webhooks/deliveries/:id/replay` and the
  self-service route) — now returns `payload_refused` → HTTP 422.
- `processWebhookRetries` — a refused head row is terminated (`status='failed'`
  with the reason in `error_message`) rather than left in `retrying`, because a
  permanent refusal that stays `retrying` is re-read every sweep AND
  head-of-line-blocks every newer event for that resource forever.

Refused rows are **not** moved to the dead-letter queue: migration 0338's
`failure_kind` CHECK admits only `http_delivery` | `log_write`, and neither is
true. Recording a refusal as an HTTP failure would be a false audit fact.
Extending `failure_kind` needs a migration (T3) and is tracked on SCRUM-5063.

**What a stored payload is refused for.** `unrecognized_keys` (a field we never
declared — the leak class) and `custom` (an event type with no schema). NOT a
missing required field, a malformed timestamp, or a failed refine: schemas have
tightened over time (PR #567 made `anchor.secured`'s chain fields non-nullable),
and refusing on that would make every pre-change delivery log un-replayable —
an availability regression wearing a security control's clothes.

**Refusal logging is rate-limited** to one error per (event type, path, key
paths) per minute, with the suppressed count folded into the next log. A
refusal is usually permanent, so an un-limited log would emit the same error per
row per sweep forever and train everyone to ignore it.

### Prod census — whose measurement this is

The "4 active endpoints, subscribed only to `anchor.secured` / `anchor.revoked` /
`anchor.expired`, no CHECK constraint on `webhook_endpoints.events`" census is
the **CTO session's** read-only SQL of 2026-09-12 ~17:20Z, not this branch's.
Cite it as that. It is what supports "no live subscriber loses a delivery from
this change" — and note it is a point-in-time fact: an ORG_ADMIN can add an
unregistered event type to that column at any moment through either of the two
writers above, which is exactly why fail-closed replaced bypass.

### `fingerprint` in `attestations.ts` is NOT dead — do not strip the selects

`attestations.ts:428` and `:816` select `fingerprint` and the review ledger
listed them as having no consumer. They do: the 201 response bodies at `:489`
(single create) and `:851` (batch create) both publish `fingerprint`, and that
field is part of the frozen v1 contract (CLAUDE.md §1.8 — removal needs a `v2`
prefix and a 12-month deprecation). It is the attestation-content hash computed
at `:395`, and it is banned from *webhook payloads* only. Left in place.
## 2026-09-12 SCRUM-4983 — every outbound webhook socket is IP-pinned (`egress.ts`)

`isPrivateUrlResolved()` was a pre-check, not a connection guard: it resolved and validated the
endpoint host, and then the dispatch site called plain `fetch()`, which resolved AGAIN. A
tenant-controlled host answering a public A record during the check and `169.254.169.254` (TTL 0)
at dispatch reached the GCE metadata server; `redirect: 'manual'` never covered that.

**All five dispatch sites now go through `webhookFetch()` in `./egress.ts`** — `deliverToEndpoint`
and `replayDelivery` here, `sendVerificationPing` and `POST /api/v1/webhooks/test` in
`api/v1/webhooks.ts`, and `POST /:id/test` in `api/v1/webhooks-self-service.ts`. `webhookFetch` is
`createSafeFetchImpl()` from `lib/safe-fetch.ts` — resolve → validate → connect to the PINNED IP
with the original Host/SNI — the same primitive the credential-source import and CTDL registry
fetch use in prod. The pre-check stays (cheap, logs "blocked" before any delivery_log row exists,
fails independently). `scripts/ci/ban-raw-fetch-worker.ts` no longer allow-lists
`webhooks/delivery.ts` or `api/v1/webhooks.ts`: a new bare `fetch(` in either is a lint finding.
The review that found the three un-migrated sites is on PR #2836; the first cut of this note
claimed full coverage while only `delivery.ts` was migrated — grep for `fetch(` before repeating
a coverage claim.

**A refusal from the pinned layer is permanent.** `isPermanentSafeFetchError()` (exported from
`lib/safe-fetch.ts`, the single classification for every consumer) covers `private_target`,
`unresolvable`, `scheme_not_allowed`, `invalid_url`, `redirect_invalid`. `formatEgressFailure()`
in `egress.ts` turns it into `{ permanent, code, message }`; delivery marks the log row `failed`
with `error_message = egress_refused: <code>`, `next_retry_at = null`, and moves the event to the
DLQ. **The DLQ row keeps `failure_kind = 'http_delivery'`.** `failure_kind` is NOT free text:
migration 0338 ships `CHECK (failure_kind IN ('http_delivery', 'log_write'))` and that constraint
is live on prod (verified 2026-09-12) — a third value is rejected with 23514, and because the DLQ
write is a PostgREST upsert the rejection returns in `{ error }` rather than throwing, so the row
would be lost silently. The "your hostname resolves to a private address" vs "your server is down"
distinction lives in `error_message` (`egress_refused: <code>`) and the structured warn log
instead; a real `egress_refused` kind needs a migration widening the CHECK, which makes the change
T3. `replayDelivery` returns `ssrf_blocked`; both test pings and the
verification ping answer `400 invalid_url`. `request_failed`, `deadline_exceeded`,
`too_many_redirects`, `response_too_large` stay on the normal retry ladder — webhooks are
at-least-once with `event_id` for receiver-side dedupe, so a retry after an oversized ack (5 MiB
cap, previously an unbounded `text()` read) is the same class as a retry after a timeout.

**Tests:** the pinned dispatch uses undici's own `fetch`, so `vi.stubGlobal('fetch', …)` does not
intercept it. `delivery.test.ts`, `replay.test.ts`, `circuit-breaker.test.ts`,
`tests/webhook-delivery-roundtrip.test.ts`, `api/v1/webhooks-test-ping.test.ts` and
`api/v1/webhooks-self-service.test.ts` call `__setWebhookFetchForTests((url, init) =>
globalThis.fetch(url, init))` at module load so their existing `mockFetch` assertions hold. The
rebinding cases inject `createSafeFetchImpl({ resolve, dispatch })` with a resolver that answers
the metadata IP and assert `dispatch` is never called. A new suite that drives a real dispatch
site against a stubbed global must inject the seam too, or its deliveries will attempt real egress.

**Known, deliberately deferred (SCRUM-5036):** `defaultSafeFetchDeps().dispatch` builds and closes
a fresh undici `Agent` per call (no keep-alive reuse), and each delivery resolves DNS twice (the
pre-check and the pin). Webhook fan-out is the first hot path on this primitive; a pooled Agent
keyed by pinned IP and a shared resolve are the follow-up. IPv6-literal hosts (`https://[…]/`) pass
the bracketed hostname as TLS `servername` (SCRUM-5038).

## 2026-09-19 — SCRUM-5063 finality event disposition

`anchor.revocation_anchored` and `attestation.active` now have strict,
public-id-only schemas and are removed from the legacy bypass ratchet. Their
producers no longer send internal anchor UUIDs or document fingerprints.

## 2026-09-19 — deferred webhook-family disposition

The historical SCRUM-3982 gap list above is preserved as the state recorded
when that work landed. SCRUM-5063 later registered
`anchor.revocation_anchored` and `attestation.active` with strict public-only
schemas and removed internal anchor identifiers and fingerprints at their
producers. The deferred-gap batch then registered `job.completed`,
`compliance.anchor_delayed`, `compliance.certificate_expiring`,
`compliance.signature_revoked`, and `compliance.timestamp_coverage_low`.
Job and certificate producers now derive deterministic, domain-separated
opaque references; raw job errors and certificate subject names are omitted.
`compliance.signature_revoked` remains correctly marked non-live because no
lifecycle callsite invokes its emitter.
The historical registry and gap list above are preserved verbatim as the state
recorded when SCRUM-3982 landed. SCRUM-5063 now registers
`anchor.revocation_anchored` and `attestation.active` with strict public-only
schemas. Their reachable job producers no longer send internal anchor UUIDs,
attestation UUIDs, or document fingerprints. The worker registry, generated
API guide, dashboard catalog, SDK type union, and Zapier allowlist are kept in
sync by the registration-drift gate.

## 2026-09-14 — SCRUM-3972 review correction

The fan-out reader uses config.enableSubOrgWebhookFanout. Delivery suites explicitly mock the disabled flag; the dedicated sub-organization suite enables the same config dependency. This supersedes the older rationale for an ad-hoc process.env read.
