# agents.md — components/api
_Last updated: 2026-07-21_

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
- DO: Surface revoke/delete mutation failures in `ApiKeySettings` — `useApiKeys.revokeKey`/`deleteKey` THROW on RLS/network/non-OK. On failure show the scrubbed `API_KEY_LABELS.{REVOKE,DELETE}_FAILED` Alert and keep the confirm dialog open (the key stays Active); close only on success.
- DO NOT: swallow those rejections in an empty `catch` ("handled by parent" is false — the parent only surfaces fetch errors) — a silent close looks like success on a key that is still active. Never render raw `Error.message` (may carry server internals).

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

ApiSandbox endpoint titles/descriptions scrubbed ("Verify Record", "record registry"); the S1 leftover "Nessie" codename removed from the AI-query endpoint title/description (endpoint path `/api/v1/nessie/query` unchanged — API contract). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
