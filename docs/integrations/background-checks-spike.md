# Veremark + Checkr Connector Spike (SCRUM-1151)

> **Status:** Spike + partial implementation (Checkr live; Veremark gated).
> See [SCRUM-1030](https://arkova.atlassian.net/browse/SCRUM-1030) for the
> tracking story.
>
> **Last refreshed:** 2026-04-25.

---

## TL;DR

- **Checkr:** Webhook v1 contract is documented + stable. Live receiver shipped at `POST /webhooks/checkr` (HMAC-SHA256 hex, `X-Checkr-Signature` header). `report.completed` events flow into `CONNECTOR_DOCUMENT_RECEIVED` rule events. Gated by `CHECKR_WEBHOOK_SECRET`.
- **Veremark:** Public webhook documentation is not sufficient to commit to a stable contract without an NDA. Receiver scaffolded at `POST /webhooks/veremark` but defaults to 503 until `ENABLE_VEREMARK_WEBHOOK=true`.

---

## Vendor matrix

| | Checkr | Veremark |
|---|---|---|
| **Webhook?** | Webhook v1 (REST + HMAC-SHA256 hex) | Yes, but spec NDA-gated |
| **Signature header** | `X-Checkr-Signature` | TBD (unconfirmed) |
| **Account routing** | `X-Checkr-Account-Id` (partner accounts) | TBD |
| **Event we care about** | `report.completed` | `check.completed` |
| **Replay protection** | Caller-managed nonce on (`report_id`, `payload_hash`) | TBD |
| **Document fetch** | `GET /v1/reports/:id` (already in Zod schema) | TBD |
| **API docs** | https://docs.checkr.com/v1.0/reference/webhooks | NDA-gated |
| **Implementation status** | **Live receiver shipped** (this PR) | **Gated** until NDA + docs |

---

## Checkr — implementation summary

### What ships in this PR

1. `services/worker/src/integrations/oauth/hmac.ts` — shared
   `verifyHmacSha256Hex` (Checkr) + `verifyHmacSha256Base64` (DocuSign /
   Adobe Sign already use this; Checkr is the third caller).
2. `services/worker/src/api/v1/webhooks/checkr.ts` — full webhook router
   mirroring the Adobe Sign pattern from SCRUM-1148:
   - HMAC verify on raw body before any DB write.
   - `report.completed` events go through the existing `adaptCheckr`
     adapter (already wired at `services/worker/src/integrations/connectors/adapters.ts`).
   - Non-completed events (`report.created`, `report.suspended`, …) get
     200-OK + `ignored: true` so Checkr stops retrying.
   - Replay protection on `(report_id, payload_hash)` via new table
     `checkr_webhook_nonces` (migration 0261).
   - DLQ inserts on processing failure (`webhook_dlq` table, introduced
     in batch 2's migration 0258).
3. Tests: `services/worker/src/api/v1/webhooks/checkr.test.ts` — 8 tests
   covering 503/401/200-ignored/200-orphaned/202-success/200-duplicate/
   500-DLQ/400-malformed.

### Operational checklist (human-only per `feedback_worker_hands_off`)

- [ ] Customer creates a Checkr partner-account webhook subscription
      pointing at `https://arkova-worker-…/webhooks/checkr` and shares the
      account_id back to Arkova.
- [ ] Arkova ops set `CHECKR_WEBHOOK_SECRET` in Cloud Run env vars.
- [ ] Arkova ops insert an `org_integrations` row with
      `provider='checkr'`, `account_id=<customer's checkr account_id>`,
      and the encrypted Checkr API key.
- [ ] Apply migration 0261 (`checkr_webhook_nonces` + extends
      `org_integrations.account_id` to support Checkr accounts if it isn't
      already nullable).

---

## Veremark — gated path

Per the AC: "Keep Veremark implementation gated until official API/webhook
docs are confirmed."

### What ships in this PR

1. `services/worker/src/api/v1/webhooks/veremark.ts` — receiver scaffold
   that returns 503 with `code: 'vendor_gated'` unless
   `ENABLE_VEREMARK_WEBHOOK=true` AND `VEREMARK_WEBHOOK_SECRET` are set.
2. Even when both are set, the route returns 501 `not_implemented` until
   the implementation is filled in (the Checkr handler is the template).
3. Tests confirm the 503 default is non-bypassable without the flag.

### What is needed to lift the gate (follow-up story)

- Vendor-supplied webhook spec covering: signature header name + format,
  event-type list, retry semantics, replay nonce shape, document-fetch
  URI shape.
- Vendor sandbox account for end-to-end fixture testing.
- Counsel review of the data flow (resume / report content traversing
  Arkova's ingestion pipeline).

---

## Why both vendors live in the same PR

The shared HMAC verifier (`hmac.ts`) and the existing `adaptVeremark` /
`adaptCheckr` adapters mean the receivers share most of the surface area.
Shipping the gated Veremark scaffold in the same PR avoids drift between
the two and keeps the rules-engine integration test surface honest (the
Veremark test confirms the gate cannot be bypassed accidentally).

---

## Follow-up implementation stories (recommended)

| Story | Title | Status |
|---|---|---|
| (new) | INT-13/checkr-doc-fetch — retryable Checkr report PDF fetch job | Next sprint |
| (new) | INT-13/veremark-spec-confirm — vendor agreement + lift the gate | Counsel-blocked |
| (new) | INT-13/checkr-rate-limits — honor Checkr's per-minute rate limits | Next sprint |

---

_Document tracked in SCRUM-1151. Confluence page mirrors this on SCRUM-1151._
