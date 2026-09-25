# sdks/mcp-server/src/agents.md

Arkova MCP Server source (PH2-AGENT-06 / SCRUM-403; NCE-19; npm publication prep 2026-08-18). Exposes Arkova verification as Model Context Protocol tools.

## Files
- **`index.ts`** — MCP tool definitions (`TOOL_DEFINITIONS`) and `handleToolCall()` dispatcher. **9 tools**, all `arkova_`-prefixed: `arkova_submit_anchor`, `arkova_get_submission_status`, `arkova_verify_anchor`, `arkova_anchor_status`, `arkova_search_anchors`, `arkova_create_attestation`, `arkova_batch_verify`, `arkova_verify_signature`, `arkova_manage_folders`. If you add or remove a tool, update the count **here** and in `index.test.ts`'s exact-name ratchet in the same change — this file drifting out of sync with the real tool list is what caused a silent 2-test regression in 2026-08 (see History below).
  - **CLAUDE.md §1.3 (2026-08-18, clean-room verification):** tool names/descriptions/input-property descriptions are the §1.3 UI-copy terminology surface — `index.test.ts` asserts no banned term (and no "credential"/"credentials") appears anywhere in `TOOL_DEFINITIONS`.
  - `vitest.config.ts` (package-local) scopes test discovery to `src/**/*.test.ts` so `npm ci --ignore-scripts && npm test` passes in a checkout with no root `node_modules` — do not rely on `sdks/vitest.config.ts` picking this package up; module resolution for that parent config starts one directory up from where this package's own `vitest` dependency resolves.
  - `arkovaFetch` sets `redirect: 'error'`. Node preserves the custom `X-API-Key` header across an origin-changing redirect, so following one could disclose the key even when the configured base URL itself is trusted — regression-tested in `index.test.ts`'s "HTTP transport" suite.
- **`index.test.ts`** — colocated tests with mocked fetch. Pins the exact 9-tool name list (exact-name ratchet — adding/removing a tool must update it deliberately), the §1.3 + credential-scrub terminology guards, the redirect-refusal transport test, and per-tool behavior (attestation required-fields, disabled-capability disclosure, batch cap, folder CRUD/reparent/connector/bulk-move). Gated by root CI (`Tests` job, `sdk-tests` step: `node_modules/.bin/vitest run --root sdks`) and independently runnable standalone via `npm ci --ignore-scripts && npm test` in this package directory.
- **`cli.ts`** — the npm `bin` entrypoint; wires `TOOL_DEFINITIONS`/`handleToolCall` onto a real `@modelcontextprotocol/sdk` stdio `Server`. See `sdks/mcp-server/agents.md` for why this is a separate file from `index.ts`, and for the P0 symlink-entrypoint fix (2026-08-18) — the guard is `isRunAsScript()` now, not a plain `import.meta.url` string compare.
- **`cli.test.ts`** — drives `cli.ts`'s `createServer()` over the SDK's `InMemoryTransport` + `Client`, i.e. through the real MCP protocol (list/call), not by reaching into private handler maps. Cannot, by construction, catch an argv-vs-symlink entrypoint bug — see `cli.bin.test.ts`.
- **`cli.bin.test.ts`** (2026-08-18) — builds `dist/cli.js`, symlinks it into a temp dir the way `node_modules/.bin/` does, and spawns a real `node` process against the symlink, driving an actual stdio JSON-RPC session (`initialize` + `tools/list`) and asserting the `ARKOVA_API_KEY`-unset stderr warning. This is the test that would have caught the P0 entrypoint bug; `cli.test.ts`'s in-process tests could not have.

## Conventions
- Auth: `ARKOVA_API_KEY` environment variable.
- All tool names prefixed with `arkova_` for namespace consistency (DX-04). (Was "`arkova_` or `nessie_`" before the 2026-09-02 `nessie_*` removal — see History below.)
- Compatible with Claude, OpenAI, Cursor, and any MCP client (stdio transport only — see `cli.ts`).
- Tool names/descriptions/input-property descriptions are CLAUDE.md §1.3 terminology surface (see `index.test.ts`'s standing guard above) — treat them like UI copy, not internal code, when adding or editing a tool.

## 2026-09-19 — UAT-12 / UAT-24 status and folder tools

`arkova_get_submission_status` and `arkova_submit_anchor` (action defaults to queue) round out anchor
submission parity with the API-key caller-scoped worker routes. `arkova_manage_folders` (added
2026-09-14, SCRUM-5142) is one action-discriminated tool over the canonical worker REST routes — it
forwards `ARKOVA_API_KEY`, preserves partial bulk results, and adds no MCP-only folder model. Tool
count moved 6 → 9 across these two changes; see the exact-name ratchet in `index.test.ts`.

## History (superseded — do not read as current state)

- **NCE-19 (pre-2026-08-18):** 4 `nessie_`-prefixed compliance-intelligence tools
  (`nessie_compliance_score`, `nessie_gap_analysis`, `nessie_ask`, `nessie_cross_reference`) were
  added without `index.test.ts`'s assertions being updated at the time, causing a silent 2-test
  regression until fixed 2026-08-18.
- **2026-09-02 (D5-F13 truth-audit + `nessie_*` removal):** all 4 `nessie_`-prefixed tools were
  removed outright — three 401'd for every real caller because the worker's `/compliance/*` routes
  require a Supabase JWT and explicitly reject `Bearer ak_…`, which is all this server ever sends;
  the fourth, `nessie_ask`, was already a standing 503 by founder directive. Same change: tool names
  were rewritten off "credential" (see `sdks/mcp-server/agents.md`'s "tool rename" entry),
  `arkova_create_attestation` began requiring+sending `attester_name`/`claims` and surfacing
  validation `details`, `arkova_search_anchors`/`arkova_verify_signature` began disclosing a
  disabled-capability 503 instead of swallowing it, `arkova_batch_verify` was capped at 20 (was
  100), and a `limit` NaN-parsing bug was fixed. Tool count was 6, all `arkova_`-prefixed, from this
  point until the 2026-09-19 additions above.
