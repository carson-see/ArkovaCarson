# sdks/mcp-server/src/agents.md

Arkova MCP Server source (PH2-AGENT-06 / SCRUM-403). Exposes Arkova verification as Model Context Protocol tools.

## Files
- **`index.ts`** — MCP tool definitions (`TOOL_DEFINITIONS`) and `handleToolCall()` dispatcher. 10 tools: `arkova_verify_credential`, `arkova_credential_status`, `arkova_search_credentials`, `arkova_create_attestation`, `arkova_batch_verify`, `nessie_compliance_score`, `nessie_gap_analysis`, `nessie_ask`, `nessie_cross_reference` (NCE-19 compliance intelligence), `arkova_verify_signature` (Phase III).
- **`index.test.ts`** — colocated tests with mocked fetch. Pins the exact tool-name list — adding/removing a tool must update it deliberately. Gated by root CI (`Tests` job, `sdk-tests` step: `node_modules/.bin/vitest run --root sdks`).

## Conventions
- Auth: `ARKOVA_API_KEY` environment variable.
- All tool names prefixed with `arkova_` or `nessie_` for namespace consistency (DX-04).
- Compatible with Claude, OpenAI, Cursor, and any MCP client.
