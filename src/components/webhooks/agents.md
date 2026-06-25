# agents.md — components/webhooks
_Last updated: 2026-05-16_

## What This Folder Contains
Webhook configuration UI for ORG_ADMIN users.

## Key Files
- `WebhookSettings.tsx` — Webhook endpoint CRUD: create with server-generated secret (shown once, then write-only), list active endpoints, delete with confirmation
- `index.ts` — Barrel exports

## Do / Don't Rules
- DO: Show webhook secret exactly once at creation, then never again (write-only pattern, mirrors ApiKeySettings)
- DO: Secrets are generated server-side — never generate or store secrets in the browser
- DO: Confirm destructive deletes. The Trash button sets `pendingDeleteId` and opens a shadcn `AlertDialog`; `onDelete` fires ONLY from the dialog's confirm action (`handleConfirmDelete`). Never wire a destructive action straight to `onClick`.

## Recent Changes
- 2026-06-24 BUG-D (webhook-delete-no-confirm): `WebhookSettings.tsx` — the Trash `onClick` was wired directly to `onDelete(endpoint.id)`, so a single misclick silently deleted an endpoint and stopped its event feed with no undo. Added an `AlertDialog` confirm (mirrors `organization/RevokeDialog` + `api/ApiKeySettings`): `pendingDeleteId` state, dialog names the endpoint URL and warns notifications stop, confirm → `onDelete` once, cancel/dismiss → clears state (no `onDelete`). Copy lives in `WEBHOOK_LABELS` (`src/lib/copy.ts`, `DELETE_CONFIRM_*`, §1.3-clean; `{url}` interpolated by the component). The Trash button carries an `aria-label` for accessibility/testability. Component test (`WebhookSettings.test.tsx`) and the page-level RPC test (`WebhookSettingsPage.test.tsx` `delete_webhook_endpoint`) both drive the dialog now — a bare Trash click no longer deletes.
