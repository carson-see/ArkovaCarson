# sdks/mcp-server/src/agents.md

Arkova MCP Server source (PH2-AGENT-06 / SCRUM-403). Exposes Arkova verification as Model Context Protocol tools.

## Files
- **`index.ts`** — MCP tool definitions (`TOOL_DEFINITIONS`) and `handleToolCall()` dispatcher. 6 tools: `arkova_verify_credential`, `arkova_credential_status`, `arkova_search_credentials`, `arkova_create_attestation`, `arkova_batch_verify`, `arkova_verify_signature`.
- **`index.test.ts`** — colocated tests with mocked fetch.

## Conventions
- Auth: `ARKOVA_API_KEY` environment variable.
- All tool names prefixed with `arkova_` for namespace consistency (DX-04).
- Compatible with Claude, OpenAI, Cursor, and any MCP client.
