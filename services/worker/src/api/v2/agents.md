# services/worker/src/api/v2/agents.md

v2 agent-tool API surface. Designed for AI agents + future MCP parity. Per-scope rate limits (see `rateLimit.ts`). Banned-field guard enforces no internal UUIDs leak to response shapes.

## Files
- `router.ts` — mounts v2 endpoints. **All paths are at the root of `/api/v2/`** (e.g. `/api/v2/orgs`, `/api/v2/anchors/<public_id>`), NOT under `/api/v2/agent/`. Returns problem+json 404 with `type=https://arkova.ai/problems/not-found` on path mismatch.
- **`rateLimit.ts` (SCRUM-1731 contract-locked)** — `DEFAULT_V2_SCOPE_RATE_LIMITS`: read:search 1000, read:records 500, read:orgs 500, write:anchors 100, admin:rules 50. `setHeaders()` emits `X-RateLimit-{Limit,Remaining,Reset}` on every response. 429 includes `Retry-After` via `ProblemError.rateLimited`. Stores: `MemoryV2RateLimitStore` + `UpstashV2RateLimitStore` (bounded eviction).
- `agentTools.ts` — `GET /verify/:fingerprint`, `GET /anchors/:publicId`, `GET /orgs`. Each gated by `requireScopeV2(...)`.
- **`mcpParity.ts` (SCRUM-1733)** — shared Zod schemas for REST/MCP parity. `assertNoBannedFields()` recursive scanner with cycle protection prevents banned UUIDs (id, org_id, user_id, agent_id, key_id, endpoint_id, attestation_id, anchor_id, fingerprint) from sneaking into response payloads.
- `apiKeyAuthV2.ts` — middleware that resolves the API key against `api_keys.key_hash` (HMAC-SHA256, secret in `API_KEY_HMAC_SECRET`).
- `problem.ts` — RFC 7807 `application/problem+json` error helpers; v2 error handler.
- `openapi.ts` — `GET /api/v2/openapi.json` returns the canonical OpenAPI 3.1 spec.

## Conventions
- Every endpoint: `requireScopeV2('<scope>')` + `createV2ScopeRateLimit('<scope>')` middleware pair.
- Zod schemas live in `mcpParity.ts` and are imported by both REST handlers and (eventually) MCP tool handlers — single source of truth.
- Response sort: when emitting field-name lists in errors, use `localeCompare` (SonarCloud S2871 — fixed in PR #737).

## Open work
- SCRUM-1731 (PR #735) — contract-lock test pinned the 5 limits to the published partner brief §6.
- SCRUM-1733 (PR #737) — APPROVED, awaiting Carson merge.
- SCRUM-1731 (PR #735) — CodeRabbit re-review blocked on credit pool.
