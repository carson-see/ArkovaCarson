# webhooks/ — Outbound Webhook Delivery

## Purpose
Sign, validate, deliver, and replay outbound webhook events to customer endpoints. CLAUDE.md §6 (no internal UUIDs) + §1.6 (no fingerprint) + §1.8 (frozen API) are enforced here, not at the call sites.

## Architecture
```
webhooks/
  payload-schemas.ts        — Zod schemas per event_type. Single authority for what data may ship.
  payload-schemas.test.ts   — banned-field + ISO-timestamp + status-literal coverage
  delivery.ts               — dispatchWebhookEvent: validate → sign (HMAC) → POST → record
  delivery.test.ts
  circuit-breaker.test.ts   — per-endpoint failure isolation
  ssrf-protection.test.ts   — block private/metadata/loopback IPs
  replay.test.ts            — admin replay path
  compliance.ts             — webhook-side audit trail
  compliance.test.ts
```

## Key Rules
- **`PAYLOAD_SCHEMAS_BY_EVENT_TYPE` is the only authority for outbound payload shape.** Drift = test failure at PR time.
- **Every event_type customers can subscribe to (`VALID_WEBHOOK_EVENTS` in `../api/v1/webhooks-schemas.ts`) MUST have a matching schema entry here.** Without a schema, `validateWebhookPayload` returns `{ ok: true, bypassed: true }` and ships the payload UNVALIDATED — silently disabling §6 + §1.6 enforcement for that event type. Audit this invariant whenever editing either file.
- **All schemas are `.strict()`.** Unknown keys reject — that's how the §6 "no internal UUIDs" rule is enforced. Any new field is additive + nullable per CLAUDE.md §1.8.
- **Banned fields** (rejected by every schema): `anchor_id`, `fingerprint`, `user_id`, `org_id`, anything starting with `_`.
- **SECURED ⇒ on-chain invariant** — `chain_tx_id` and `chain_block_height` MUST be non-null on `AnchorSecuredPayloadSchema` (PR #567 CodeRabbit P1 fix). Submitted/Revoked allow null because the on-chain ref may not yet exist.
- **HMAC-SHA256 with the per-endpoint secret** (created at registration, shown once, never re-fetchable). Worker never logs the secret.
- **SSRF protection** runs before delivery — private/loopback/metadata IPs are rejected at lookup time.
- **`anchor.status = 'SECURED'`** writes are worker-only via service_role (CLAUDE.md §1.4).
- **Verification API contract** — schemas are frozen per CLAUDE.md §1.8. New fields must be nullable + additive; removing a field requires a v2 prefix.

## Event Types and Schemas (current main)

### Anchor Lifecycle
| Event | Schema | Required fields | Notes |
|---|---|---|---|
| `anchor.submitted` | `AnchorSubmittedPayloadSchema` | `public_id`, `chain_tx_id?`, `chain_block_height?`, `submitted_at`, `status:'SUBMITTED'` | chain refs may be null pre-mining |
| `anchor.secured` | `AnchorSecuredPayloadSchema` | `public_id`, `chain_tx_id`, `chain_block_height`, `chain_timestamp`, `secured_at`, `status:'SECURED'` | strict non-null on-chain refs |
| `anchor.revoked` | `AnchorRevokedPayloadSchema` | `public_id`, `chain_tx_id`, `chain_block_height`, `revoked_at`, `status:'REVOKED'` | optional `revocation_reason` |
| `anchor.batch_secured` | `AnchorBatchSecuredPayloadSchema` | `chain_tx_id`, `chain_block_height`, `chain_timestamp`, `secured_at`, `anchor_count`, `public_ids[]` (max 20K) | aggregate event for merkle batches |

### Credential Lifecycle (SCRUM-1743 — contract on main; emit-points pending Phase-2)
| Event | Schema | Required fields | Notes |
|---|---|---|---|
| `credential.issued` | `CredentialIssuedPayloadSchema` | `public_id`, `credential_type`, `issued_at`, `status:'ISSUED'` | optional `expires_at`, `recipient_public_id`, `org_public_id` |
| `credential.verified` | `CredentialVerifiedPayloadSchema` | `public_id`, `credential_type`, `verified_at`, `status: SECURED \| REVOKED \| EXPIRED` | terminal-only — non-terminal `PENDING/SUBMITTED` does NOT fire this; optional `verifier_country` (ISO 3166-1 alpha-2 only, never IPs) |
| `credential.status_changed` | `CredentialStatusChangedPayloadSchema` | `public_id`, `credential_type`, `previous_status`, `new_status`, `changed_at` | for issuer-side reconciliation |

### Pending in-flight
- `anchor.expired` — schema + emitter in [PR #734](https://github.com/carson-see/ArkovaCarson/pull/734) (SCRUM-1735 schema + SCRUM-1736 emitter). `VALID_WEBHOOK_EVENTS` already lists it (subscribable), but no `PAYLOAD_SCHEMAS_BY_EVENT_TYPE['anchor.expired']` entry exists on main yet — `validateWebhookPayload` returns `bypassed: true` for this event until #734 merges. Bug Tracker row `BUG-2026-05-08-003` tracks the gap. Defense-in-depth: no emit-side wiring exists on main, so no payload ever ships.

## Adding a New Event Type — Checklist
1. Add to `VALID_WEBHOOK_EVENTS` in `../api/v1/webhooks-schemas.ts`.
2. Add Zod schema here (`.strict()`, allowlist fields only). Reuse `ANCHOR_BASE_FIELDS` or `CREDENTIAL_BASE_FIELDS` where shape matches.
3. Wire into `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`.
4. Export `<Name>Payload` type.
5. Cover in `payload-schemas.test.ts`: happy path, all 4 banned-field rejections, ISO-timestamp rejection, status-literal rejection, `validateWebhookPayload` round-trip.
6. Update `docs/api/webhooks.md` event-types table.
7. Update this `agents.md`.

## Stories
- SCRUM-1268 — original anchor.* payload contract (Done).
- SCRUM-1735 — credential.* + anchor.expired schema spec (Done; ships in PR #734 along with SCRUM-1736 emitter).
- SCRUM-1736 — anchor.expired emitter cron (In Progress, PR #734).
- SCRUM-1743 — credential.* lifecycle webhook events parent (In Progress).
- SCRUM-1796 — `anchor.expired` schema-bypass bug (To Do; fix shipping via PR #734).

## References
- CLAUDE.md §6 (no internal UUIDs publicly), §1.6 (fingerprint stays client-side), §1.8 (frozen API).
- `docs/api/webhooks.md` — public-facing webhook docs.
- Bug Tracker — Master Log: <https://arkova.atlassian.net/wiki/spaces/A/pages/28115270>.
