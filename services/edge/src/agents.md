# services/edge/src/agents.md

Cloudflare Worker (`arkova-edge`) — Zero-Trust edge layer for x402 facilitator + MCP server. Deployed via wrangler. NOT the production REST API (that's `services/worker/`).

## Files
- `index.ts` — main fetch handler. Routes `/mcp` → `mcp-server.ts`. Internal cron routes (`/report`, `/ai-fallback`, `/crawl`) require `X-Cron-Secret`.
- **`mcp-server.ts`** — MCP JSON-RPC server speaking MCP protocol 2024-11-05 over HTTPS. Wraps `@modelcontextprotocol/sdk` + `WebStandardStreamableHTTPServerTransport`. Authenticates via `validateApiKey()` (Supabase RPC `validate_api_key` — see migration 0299, SCRUM-1793) OR `validateBearer()` (Supabase JWT, fail-closed if `SUPABASE_JWT_SECRET` is unset).
- **`mcp-origin-allowlist.ts`** — per-API-key allowlist read from `MCP_ORIGIN_ALLOWLIST_KV` at key `allow:<api_key_id>`. Default = challenge mode when no entry exists. Wildcard CIDRs (`0.0.0.0/0` + `::/0`) allow any IP. Operators write entries via `wrangler kv key put` directly OR (when `MCP_ALLOWLIST_HMAC_SECRET` is set) via `tools/edge/sign-allowlist-entry.ts` for HMAC-signed envelopes (SCRUM-1283 sub-issue A).
- `mcp-rate-limit.ts` — per-user rate limiter via `MCP_RATE_LIMIT_KV`.
- `mcp-anomaly-detection.ts` — heuristics for unusual MCP tool-call patterns.
- `mcp-tools.ts`, `mcp-tool-schemas.ts` — tool catalog and schemas.
- `mcp-audit-log.ts` — fire-and-forget audit log writer via `ctx.waitUntil(...)`. Caller IPs are **keyed** HMAC-SHA256 (`MCP_IP_HASH_PEPPER`), not bare sha256 — see below.
- `mcp-kill-switch.ts` — checks switchboard flag `ENABLE_MCP_SERVER`.

## Nessie worker proxy timeout (2026-06-07)

`mcp-tools.ts` keeps Supabase REST/RPC fetches on the 10s timeout, but
worker-proxied `nessie_query` calls use a separate 30s timeout. Context-mode
Gemini generation through the worker can exceed 10s; aborting it early forces
the edge into `text_fallback`, invalidating MCP context/citation soak evidence.

## Auth chain (verified live 2026-05-08)
1. `X-API-Key` header → `validateApiKey()` calls `validate_api_key` RPC (migration 0299 applied to prod + staging this session).
2. RPC HMACs the raw key with `private.api_key_settings.hmac_secret` and looks up `api_keys.key_hash`.
3. Returns `{user_id, tier, api_key_id, scopes}` or NULL (fail-closed).
4. Origin allowlist check via `enforceOriginAllowlist()` against `MCP_ORIGIN_ALLOWLIST_KV` at `allow:<api_key_id>`.
5. MCP `initialize` handshake → tool dispatch.

## MCP audit-log IP hashing is KEYED (2026-08-10, DPA)

`mcp-audit-log.ts` hashed caller IPs from day one, but with an **unsalted** `sha256(ip)`. That does not back the DPA's "hashed IP addresses" warranty: the IPv4 space is ~4.3e9 addresses, so the digest is a rainbow-table lookup away from the plaintext — an encoding, not a pseudonymisation control.

`pseudonymizeIp()` now uses `hmacSha256Hex(ip, env.MCP_IP_HASH_PEPPER)` (new helper in `mcp-crypto-utils.ts`, WebCrypto `HMAC`/`SHA-256`).

- **Fail closed, do not downgrade.** With no pepper the row records `ip_hash: null` plus a one-time `console.warn` — it never reverts to the enumerable bare digest. An honest null beats a digest that only looks protective.
- Unlike the worker's `IP_HASH_PEPPER`, this does **not** block startup: the edge has no config-validation stage, and failing the MCP server closed over an audit field is the worse trade.
- Provision with `wrangler secret put MCP_IP_HASH_PEPPER --name arkova-edge`. Until then MCP audit rows carry no caller identifier.
- `args_hash` is deliberately still a bare `sha256` — args are attacker-chosen high-entropy JSON, not a bounded enumerable space. If a tool ever hashes a low-cardinality argument on its own, that one needs the keyed helper too.
- Tests: `src/tests/edge/mcp-security.test.ts` pins keyed-vs-bare and the null-on-missing-pepper path.

## The edge suite is CI-gated (2026-08-15) — it was not, for ~10 weeks

`services/edge/vitest.config.ts` has existed since Story D PR-1 (2026-06-05), but **nothing in CI ever invoked it** until 2026-08-15. The only edge step was `tsc -p services/edge/tsconfig.json --noEmit` in the `typecheck-lint` job — a typecheck, not a test run. The root suite could not pick these up either: root `vitest.config.ts` globs `tests/**`, `src/**`, `scripts/**` relative to the **repo root**, so `services/edge/src/*.test.ts` matched no pattern in any runner.

Net effect: `src/mcp-tools.test.ts` (36 assertions over the MCP tool surface, incl. the BUG-2 `shapeAnchorRow` regressions) **gated nothing** and could have sat red indefinitely without failing a PR. It was found while fixing BUG-2026-08-13-016 (PR #2232), whose P0 tests were parked in the ROOT suite (`src/tests/edge/`, `tests/infra/`) purely to be sure CI would run them.

**Now:** the `Tests` job runs `Install edge dependencies` (`npm ci --ignore-scripts` in `services/edge`) then `Run edge worker tests` (`npm test`), both wired into that job's `Aggregate test suite results` gate. Baseline when wired: **36/36 green** — the gate was not merged red.

- Run it locally exactly as CI does: `cd services/edge && npm ci --ignore-scripts && npm test`.
- `services/edge` has its **own** `package-lock.json` and is **not** part of the root npm workspace — deps must be installed separately or the suite cannot run at all.
- It lives in the `Tests` job on purpose. `Tests` is an enumerated `check-success` merge condition in `.mergify.yml` (5 occurrences) and a required status check; a NEW top-level job would gate nothing until branch protection and `.mergify.yml` were updated too — i.e. it would recreate this exact bug.
- **Adding a test under `services/edge/`? It runs here, not in the root suite.** Modules using ambient CF globals (`Ai` in `mcp-tools.ts:1049`, `KVNamespace`, …) can only be tested here, since the root tsconfig deliberately omits `@cloudflare/workers-types` from global `types`. See `src/tests/edge/agents.md` for the split.

## KV namespaces
- `MCP_RATE_LIMIT_KV` (`a8a7843630e84c5aa22cf20ea8a8c5e8`)
- `MCP_ORIGIN_ALLOWLIST_KV` (`5ace0a24154a4731b263285890ae3a10`)

## Open work
- SCRUM-1793 (PR #741 NEW) — `validate_api_key` RPC migration committed to repo; already applied to prod + staging via Supabase MCP.
- HakiChain sandbox key (`api_key_id=c75d84b9-…`) has wildcard CIDR allowlist entry written 2026-05-08.
