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
