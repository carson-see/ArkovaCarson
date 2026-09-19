## 2026-09-12 — SCRUM-5023: the badge reads the SERVER's status; Extend is offered on expired keys

`KeyStatusBadge` renders `apiKey.status` — the worker's own derivation
(`services/worker/src/api/v1/keyExpiryStatus.ts`), surfaced by GET `/api/v1/keys`. **DO NOT re-derive
it here.** A second client-side derivation is exactly how the dashboard and the auth middleware came
to disagree (SCRUM-4515): `is_active` is a stored column that stays `true` on keys auth already
refuses, and 13 of 19 prod rows were in that state.

`resolveKeyStatus()` keeps ONE local branch, for the rollout window in which a deployed frontend can
still be talking to a worker that does not send `status`. Without it every key renders Active for the
length of a deploy — SCRUM-4515 again, for as long as the rollout takes. It is deliberately cruder
(no `expiring_soon`): an old worker sends no `days_until_expiry` to label one with. **DO NOT** grow it
into a full second derivation.

**The Extend dialog confirms anything that does not plainly lengthen the key's life.** Every preset
REPLACES the expiry, so "30 days" on a key with eleven months left cuts ten of them and any preset on
a never-expiring key invents one — both one click from a button labelled "Extend". `shortensKey()`
mirrors the server's 409 (`api_key_expiry_would_shorten`); the server is the authority, this only
decides whether to ask. "Remove expiry" is confirmed for the opposite reason: it is the only option
that makes a credential permanent. The dialog states the CURRENT expiry before offering any preset,
because a user who cannot see it cannot tell which presets extend and which cut.

- `expiring_soon` is **amber** and carries the countdown. A warning the owner can act on is the
  deliverable; a second shade of "fine" is not. Plurality is handled (`today` / `in 1 day` /
  `in N days`) — never "in 0 days".
- **Extend is offered on EXPIRED keys too** — the remedy has to be reachable from the failure. Never
  on a revoked key: revocation is terminal and the worker 409s.
- DO: on an `onExtend` rejection show the scrubbed `API_KEY_LABELS.EXTEND_FAILED` and keep the dialog
  open — the expiry did NOT change, and closing implies otherwise (same discipline as revoke/delete).

# agents.md — components/api
_Last updated: 2026-09-19_

## 2026-09-19 — create-key picker matches reachable enforced grants

`SELECTABLE_API_SCOPES` deliberately differs from the full accepted vocabulary. The create dialog offers the currently reachable machine grants, including `verify`, `verify:batch`, `usage:read`, `webhooks:manage`, `agents:manage`, and `orgs:manage`. It excludes reserved, unenforced, compatibility-only, or JWT-only grants. When adding a scope, verify an API-key-authenticated route actually requires it; vocabulary membership alone is insufficient.

## 2026-08-12 — revoke/delete buttons work now (FD-P7, no component change)

`ApiKeySettings.tsx` always addressed keys by `apiKey.id`, but the server stripped `id` from every
response, so Revoke/Delete silently hit `/api/v1/keys/undefined`. Fixed server-side (worker returns
`id` again); this component was already correct. E2E now exercises the full create → revoke →
delete path in `e2e/api-keys.spec.ts`.

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

## 2026-09-19 — Sandbox capability inventory

`ApiSandbox.tsx` is a curated endpoint sampler, not a complete API console. Do not add `/api/v1/nessie/query`: the route is permanently disabled in production by founder directive. The live OpenAPI document is the authority for the complete supported surface.

Verification search is `GET /api/v1/verify/search?q=...`. Its copy is centralized in `DEVELOPER_PAGE_LABELS` and must name the response's auditable `search_mode`; embeddings can be disabled or degraded, in which case the API returns `lexical_substring`.
