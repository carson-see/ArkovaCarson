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

## `TOOL_DEFINITIONS` descriptions are CI-guarded (BUG-026, 2026-08-15)

`TOOL_DEFINITIONS` in `mcp-tools.ts` is the canonical text for five published surfaces: this file, `public/.well-known/mcp/server-card.json`, `public/AGENTS.md`, `public/llms.txt` + `public/llms-full.txt`, and `docs/api/mcp-tools.md`. Nothing compared the description TEXT between them, which is how BUG-026 — `search_credentials` advertising semantic/vector matching over an ILIKE substring scan — survived on six surfaces at once.

`scripts/ci/check-mcp-claim-parity.ts` now enforces it (ci.yml `policy-lints`). What this means when you edit a description here:

- The manifest description must still START WITH your new canonical text. Editing one side alone fails the build. The manifest may APPEND discovery-only guidance (8 of the 16 tools do); it may not restate the mechanism.
- A new tool must be documented in `docs/api/mcp-tools.md` in the same PR (`reference-coverage`, strict, no baseline).
- `CLAIM_RULES` in the gate declares assertions a description may not make about a given tool, with a qualifier that makes the claim honest — `search_credentials` may not claim semantic/vector retrieval unless the same text also discloses `search_mode` or the lexical/substring fallback, and `nessie_query` may not be described in the present tense without a DISABLED marker. Adding a rule is the intended way to close the next instance; deleting one asserts the behaviour changed, and needs the code that changed it.
- Known outstanding, in `scripts/ci/mcp-claim-parity-baseline.json`: this file's `nessie_query` description still makes a present-tense capability claim (owned by PR #2236), and `oracle_batch_verify` / `list_agents` carry one-word hand-copy drift against the manifest that is UNOWNED. The gate could not fix them — every published surface is above T0.
- The gate scopes text by tool NAME. A module-header comment that names no tool is out of scope; `mcp-tools.ts`'s own header was one of BUG-026's six surfaces and would not be caught.
## 2026-08-15 BUG-008/027 — `nessie_query` fails CLOSED; BUG-026 — `search_credentials` describes itself honestly

**`nessie_query`.** Gated on `SupabaseConfig.nessieEnabled`, sourced from the `ENABLE_NESSIE_QUERY`
edge var (`env.ENABLE_NESSIE_QUERY === 'true'`). **Absent means disabled** — Nessie is permanently
disabled by standing founder directive (CTO ruling R-1). Two fail-open paths were closed:

1. The tool ran unconditionally. It now returns `nessieDisabledResult()` before any network call.
2. On **any** non-2xx from the worker it degraded to `nessieTextFallback` — a lexical scan of
   `public_records` — and answered `{total, results}`. So even once the worker started refusing, the
   MCP tool would have reported a disabled capability as a completed search. `nessieWorkerQuery` now
   inspects a 503 for `code: 'nessie_disabled'` / `enabled: false` and returns a ToolResult (not
   `null`), which stops the caller's fallback dead. **Any other non-2xx still returns `null` and still
   falls back** — a transient worker fault is not a disabled capability, and the labelled lexical path
   is the honest answer there. Do not collapse those two cases.

The disabled result carries `isError: true`, `enabled: false`, `code: 'nessie_disabled'`, and **none**
of `total`/`results`/`answer`/`confidence`/`citations`. The absence is the contract: an agent reading
only `total` would otherwise conclude "0 results".

**`search_credentials` (BUG-026).** The description used to LEAD with "Uses semantic (vector)
similarity matching". In practice the vector path needs a configured worker AND an open
`ENABLE_SEMANTIC_SEARCH` gate; with the gate closed the worker answers 503 and every call is served
lexically. Reproduced on the rig: the non-word fragment `aten` matched
`Patent_Application_AI_Method.pdf` while an English paraphrase of the same document returned nothing.
The description now leads with the served behaviour and marks the semantic path conditional.
**No behaviour changed — this was a false description, not a broken search.** `search_mode` labelling
is unchanged and still correct.

Tests pin the literals `search_mode` / `lexical_substring` / `semantic_vector` in the description
(`mcp-tools.test.ts` (h)) — keep all three in any future rewrite. The server card
(`public/.well-known/mcp/server-card.json`) carries a copy of this description and has **no**
automated text-parity check with `TOOL_DEFINITIONS`; `tests/infra/mcp-manifest-parity.test.ts` checks
names/schemas only. Update both by hand, together.

## Open work
- SCRUM-1793 (PR #741 NEW) — `validate_api_key` RPC migration committed to repo; already applied to prod + staging via Supabase MCP.
- HakiChain sandbox key (`api_key_id=c75d84b9-…`) has wildcard CIDR allowlist entry written 2026-05-08.
- BUG-026 residue: `oracle_batch_verify` and `list_agents` descriptions here disagree with `server-card.json` by one word each (`an envelope` vs `a response envelope`; `caller organization` vs `caller's organization`). Baselined, unowned, needs a T2 PR.
- No CI check enforces text parity across the five published MCP claim surfaces (`mcp-tools.ts`,
  `server-card.json`, `public/AGENTS.md`, `public/llms*.txt`, `docs/api/mcp-tools.md`). They can drift
  freely today; a parity script is the durable fix for the BUG-026 class.
