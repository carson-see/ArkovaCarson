# services/edge/src/agents.md

Cloudflare Worker (`arkova-edge`) — Zero-Trust edge layer for x402 facilitator + MCP server. Deployed via wrangler. NOT the production REST API (that's `services/worker/`).

## Files
- `index.ts` — main fetch handler. Routes `/mcp` → `mcp-server.ts`. Internal cron routes (`/report`, `/ai-fallback`, `/crawl`) require `X-Cron-Secret`.
- **`mcp-server.ts`** — MCP JSON-RPC server speaking MCP protocol 2024-11-05 over HTTPS. Wraps `@modelcontextprotocol/sdk` + `WebStandardStreamableHTTPServerTransport`. Authenticates via `validateApiKey()` (Supabase RPC `validate_api_key` — see migration 0299, SCRUM-1793) OR `validateBearer()` (Supabase JWT, fail-closed if `SUPABASE_JWT_SECRET` is unset).
- **`mcp-origin-allowlist.ts`** — per-API-key allowlist read from `MCP_ORIGIN_ALLOWLIST_KV` at key `allow:<api_key_id>`. Default = challenge mode when no entry exists. Wildcard CIDRs (`0.0.0.0/0` + `::/0`) allow any IP. Operators write entries via `wrangler kv key put` directly OR (when `MCP_ALLOWLIST_HMAC_SECRET` is set) via `tools/edge/sign-allowlist-entry.ts` for HMAC-signed envelopes (SCRUM-1283 sub-issue A).
- `mcp-rate-limit.ts` — per-user rate limiter via `MCP_RATE_LIMIT_KV`.
- `mcp-anomaly-detection.ts` — heuristics for unusual MCP tool-call patterns.
- `mcp-tools.ts`, `mcp-tool-schemas.ts` — tool catalog and schemas.
- `mcp-audit-log.ts` — fire-and-forget audit log writer via `ctx.waitUntil(...)`.
- `mcp-kill-switch.ts` — checks switchboard flag `ENABLE_MCP_SERVER`.

## Auth chain (verified live 2026-05-08)
1. `X-API-Key` header → `validateApiKey()` calls `validate_api_key` RPC (migration 0299 applied to prod + staging this session).
2. RPC HMACs the raw key with `private.api_key_settings.hmac_secret` and looks up `api_keys.key_hash`.
3. Returns `{user_id, tier, api_key_id, scopes}` or NULL (fail-closed).
4. Origin allowlist check via `enforceOriginAllowlist()` against `MCP_ORIGIN_ALLOWLIST_KV` at `allow:<api_key_id>`.
5. MCP `initialize` handshake → tool dispatch.

## KV namespaces
- `MCP_RATE_LIMIT_KV` (`a8a7843630e84c5aa22cf20ea8a8c5e8`)
- `MCP_ORIGIN_ALLOWLIST_KV` (`5ace0a24154a4731b263285890ae3a10`)

## Open work
- SCRUM-1793 (PR #741 NEW) — `validate_api_key` RPC migration committed to repo; already applied to prod + staging via Supabase MCP.
- HakiChain sandbox key (`api_key_id=c75d84b9-…`) has wildcard CIDR allowlist entry written 2026-05-08.
