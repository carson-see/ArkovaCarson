# sdks/mcp-server/src/agents.md

Arkova MCP Server source (PH2-AGENT-06 / SCRUM-403; NCE-19; npm publication prep 2026-08-18). Exposes Arkova verification as Model Context Protocol tools.

## Files
- **`index.ts`** — MCP tool definitions (`TOOL_DEFINITIONS`) and `handleToolCall()` dispatcher. 10 tools: `arkova_verify_credential`, `arkova_credential_status`, `arkova_search_credentials`, `arkova_create_attestation`, `arkova_batch_verify`, `nessie_compliance_score`, `nessie_gap_analysis`, `nessie_ask`, `nessie_cross_reference` (NCE-19 compliance intelligence), `arkova_verify_signature` (Phase III).
- **`index.test.ts`** — colocated tests with mocked fetch. Pins the exact tool-name list — adding/removing a tool must update it deliberately. Gated by root CI (`Tests` job, `sdk-tests` step: `node_modules/.bin/vitest run --root sdks`).
- **`index.ts`** — MCP tool definitions (`TOOL_DEFINITIONS`) and `handleToolCall()` dispatcher. **10 tools**, not 6 — 6 `arkova_`-prefixed (`arkova_verify_credential`, `arkova_credential_status`, `arkova_search_credentials`, `arkova_create_attestation`, `arkova_batch_verify`, `arkova_verify_signature`) plus 4 `nessie_`-prefixed compliance-intelligence tools added by NCE-19 (`nessie_compliance_score`, `nessie_gap_analysis`, `nessie_ask`, `nessie_cross_reference`) without this file or `index.test.ts`'s assertions being updated at the time — `index.test.ts` silently regressed to 2 failing tests until fixed 2026-08-18. If you add or remove a tool, update the count **here** and in `index.test.ts` in the same change; this file drifting is exactly what caused the miscount.
- **`index.test.ts`** — colocated tests with mocked fetch.
- **`cli.ts`** — the npm `bin` entrypoint; wires `TOOL_DEFINITIONS`/`handleToolCall` onto a real `@modelcontextprotocol/sdk` stdio `Server`. See `sdks/mcp-server/agents.md` for why this is a separate file from `index.ts`.
- **`cli.test.ts`** — drives `cli.ts`'s `createServer()` over the SDK's `InMemoryTransport` + `Client`, i.e. through the real MCP protocol (list/call), not by reaching into private handler maps.

## Conventions
- Auth: `ARKOVA_API_KEY` environment variable.
- All tool names prefixed with `arkova_` or `nessie_` for namespace consistency (DX-04).
- Compatible with Claude, OpenAI, Cursor, and any MCP client.
- Compatible with Claude, OpenAI, Cursor, and any MCP client (stdio transport only — see `cli.ts`).
