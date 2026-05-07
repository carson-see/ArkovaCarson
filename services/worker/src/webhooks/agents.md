# Outbound webhooks — agents.md

Owner of the **outbound** webhook system. Inbound receivers (DocuSign, Adobe Sign, Microsoft Graph, Drive, Checkr, ATS) live elsewhere — see `services/worker/src/api/v1/webhooks/` for those.

## Files

| File | Role |
|---|---|
| `payload-schemas.ts` | Zod allowlist for outbound payload `data` blocks. The only authority on what fields may leave Arkova on a given event type. Strict mode rejects unknown keys at runtime. CLAUDE.md §6 (no internal UUIDs) + §1.6 (no fingerprints) enforced here. |
| `payload-schemas.test.ts` | Locks the contract for every emitted event type. Banned fields (`anchor_id`, `fingerprint`, `user_id`, `org_id`) are explicitly rejected per schema. New event types MUST land with their own banned-field rejection cases. |
| `delivery.ts` | Delivery engine. HMAC-SHA256 signing (`X-Arkova-Signature`, `X-Arkova-Timestamp`, `X-Arkova-Event` headers), exponential backoff (5 max attempts, 1s base), idempotency keys, circuit breaker (DH-04, 5 consecutive failures → open, 60s half-open), DLQ (DH-12), SSRF protection with DNS rebinding mitigation (ARK-SEC-002, INJ-02), replay (SCRUM-1172). Gated by `ENABLE_OUTBOUND_WEBHOOKS` flag. |
| `compliance.ts` | Compliance metadata + tagging hooks for outbound events used in audit reporting. |
| `*.test.ts` | Unit + integration coverage for each module. |

## Supported event types

| Event | Schema | Producer | Status |
|---|---|---|---|
| `anchor.submitted` | `AnchorSubmittedPayloadSchema` | `services/worker/src/jobs/anchor.ts` | Live |
| `anchor.secured` | `AnchorSecuredPayloadSchema` | `services/worker/src/jobs/check-confirmations.ts` | Live |
| `anchor.revoked` | `AnchorRevokedPayloadSchema` | `services/worker/src/api/anchor-revoke.ts` (RPC `revoke_anchor`) | Live |
| `anchor.expired` | `AnchorExpiredPayloadSchema` (SCRUM-1735) | **Producer pending — SCRUM-1736** | Schema live; dispatch site not yet implemented |
| `anchor.batch_secured` | `AnchorBatchSecuredPayloadSchema` | merkle-batch path (per-anchor `anchor.secured` events also fan out — SCRUM-1264) | Live |

`anchor.expired` schema is in place and validated end-to-end by the helper. The producer is the `anchorExpirySweep` cron specified under SCRUM-1735 — it transitions `anchors.status = 'EXPIRED'` for SECURED anchors whose `expires_at < now()` and dispatches the event. Implementation lands under SCRUM-1736.

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

## SOC 2 DC 200

System description for this module is documented in Confluence under SCRUM-1735. When changing this module, re-verify the description (services, commitments, components, risk assessment, control environment, CUECs) is still accurate.
