# agents.md — components/webhooks
_Last updated: 2026-07-21_

## What This Folder Contains
Webhook configuration UI for ORG_ADMIN users: endpoint CRUD, event catalog, signed test ping, delivery history + failed deliveries (DLQ).

## Key Files
- `WebhookSettings.tsx` — Webhook endpoint CRUD: create with server-generated secret (shown once, then write-only), list active endpoints, delete with confirmation. WH-02 (SCRUM-2397): optional `onTestPing` prop renders a per-endpoint "Send test event" button (ACTIVE endpoints only) with an in-flight double-click guard and an inline consumer-side verification result (`TEST_PING_SUCCESS`/`TEST_PING_FAILURE` with the receiver's HTTP status). The button is omitted entirely when `onTestPing` is not passed.
- `WebhookEventCatalog.tsx` — WH-01 (SCRUM-2396) read-only event catalog. `WEBHOOK_EVENT_CATALOG` derives its order from `AVAILABLE_EVENTS` (test-enforced lockstep) and carries per-event `live` + `fields`. **Honesty contract (§1.13 R-7):** `live: true` only for events with a real worker emit point (all five `anchor.*` — verified against `services/worker/src/webhooks/agents.md` producer table); `credential.*` render a "Not yet active" badge + note. `fields` mirror the strict Zod schemas in `services/worker/src/webhooks/payload-schemas.ts` — update BOTH when a schema changes. Redaction-rules note (`CATALOG_REDACTION_NOTE`) is part of the WH-01 AC; don't drop it.
- `WebhookDeliveryLog.tsx` — WH-03 (SCRUM-2398) delivery history table + failed-deliveries (DLQ) section. Renders delivery METADATA only (status label, response code, attempt count, endpoint URL, time; DLQ rows add bounded worker-generated `error_message`) — the event payload never reaches this component (the hook never selects it). Resend appears only on `status === 'failed'` rows and disables while in flight (the UI half of replay idempotency — the worker half is `replayDelivery`'s always-new-row model). Delivery statuses map through `DELIVERY_STATUS_LABELS` (a separate enum domain from `statusDisplay.ts` — do not merge them).
- `index.ts` — Barrel exports

## Do / Don't Rules
- DO: Show webhook secret exactly once at creation, then never again (write-only pattern, mirrors ApiKeySettings)
- DO: Secrets are generated server-side — never generate or store secrets in the browser
- DO: Confirm destructive deletes. The Trash button sets `pendingDeleteId` and opens a shadcn `AlertDialog`; `onDelete` fires ONLY from the dialog's confirm action (`handleConfirmDelete`). Never wire a destructive action straight to `onClick`.
- DON'T: Render webhook payload contents, `response_body`, document fingerprints, or internal UUIDs anywhere in this folder — delivery/DLQ surfaces are metadata-only (§1.6, WH-03 AC).
- DON'T: Mark a catalog event `live: true` without a real emit point in `services/worker/` (launch-claims discipline, §1.13 R-7).

## Recent Changes
- 2026-07-06 WH-01/02/03 (SCRUM-2396/2397/2398, Lane 2 S3): added `WebhookEventCatalog.tsx` + `WebhookDeliveryLog.tsx`; `WebhookSettings.tsx` gained the optional `onTestPing` prop (see Key Files). All new user-visible strings live in `WEBHOOK_LABELS` / `WEBHOOK_EVENT_DESCRIPTIONS` (`src/lib/copy.ts`, §1.3-clean). Data flows: delivery history via `useWebhookDeliveries` (direct RLS-scoped Supabase read); DLQ + test ping + replay via the worker JWT-authed self-service endpoints (`/api/v1/webhooks/self-service/*`, `services/worker/src/api/v1/webhooks-self-service.ts`).
- 2026-06-24 BUG-D (webhook-delete-no-confirm): `WebhookSettings.tsx` — the Trash `onClick` was wired directly to `onDelete(endpoint.id)`, so a single misclick silently deleted an endpoint and stopped its event feed with no undo. Added an `AlertDialog` confirm (mirrors `organization/RevokeDialog` + `api/ApiKeySettings`): `pendingDeleteId` state, dialog names the endpoint URL and warns notifications stop, confirm → `onDelete` once, cancel/dismiss → clears state (no `onDelete`). Copy lives in `WEBHOOK_LABELS` (`src/lib/copy.ts`, `DELETE_CONFIRM_*`, §1.3-clean; `{url}` interpolated by the component). The Trash button carries an `aria-label` for accessibility/testability. Component test (`WebhookSettings.test.tsx`) and the page-level RPC test (`WebhookSettingsPage.test.tsx` `delete_webhook_endpoint`) both drive the dialog now — a bare Trash click no longer deletes.

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

WebhookSettings event display names: "Record Verified/Record Status Changed (coming soon)"; "Credential Issued" kept — it names the restricted-issuance event (SCRUM-1672). Event keys `credential.*` unchanged (API contract). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).

## 2026-08-15 — `compliance.document_expiring` added (BUG-002)

Added to `AVAILABLE_EVENTS`, `CATALOG_DATA` (`live: true` — the emit point is
real: `POST /cron/check-credential-expiry`, behind `ENABLE_EXPIRY_ALERTS`), and
`WEBHOOK_EVENT_DESCRIPTIONS` in `src/lib/copy.ts`. The pinned drift-guard list in
`WebhookSettings.test.tsx` was extended in the same commit — that list is the
only thing tying this workspace to the worker's `VALID_WEBHOOK_EVENTS`, since the
UI cannot direct-import the worker constant.

The event was already being dispatched by the worker; it just was not registrable,
so no endpoint could subscribe. Worker-side detail (including why registering it
is what stops an internal UUID reaching the wire) is in
`services/worker/src/webhooks/agents.md`.

Pre-existing drift left alone: `anchor.superseded` is in the worker's
`PAYLOAD_SCHEMAS_BY_EVENT_TYPE` but not in `AVAILABLE_EVENTS`.
