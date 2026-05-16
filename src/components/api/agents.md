# agents.md — components/api
_Last updated: 2026-05-16_

## What This Folder Contains
Developer-facing API management components: key CRUD, usage dashboard, scope display, and interactive sandbox.

## Key Files
- `ApiKeySettings.tsx` — Full CRUD for API keys: list, create (two-phase secret display), revoke/delete
- `ApiKeyScopeDisplay.tsx` — Renders scope badges for an API key
- `ApiUsageDashboard.tsx` — Verification API usage widget: total usage, per-key breakdown, quota progress
- `ApiSandbox.tsx` — Interactive API testing playground supporting API Key and x402 payment auth
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useApiKeys` — API key data and usage stats
- `@/lib/copy` (API_KEY_LABELS) — UI strings

## Do / Don't Rules
- DO: Show raw API key secret exactly once at creation, then never again (write-only pattern)
- DO NOT: Persist raw API keys — only HMAC-SHA256 hashes are stored server-side
