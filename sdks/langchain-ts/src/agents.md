# sdks/langchain-ts/src/agents.md

LangChain TypeScript tool wrappers for Arkova (PH2-AGENT-06 / SCRUM-403).

## Files
- **`index.ts`** — tool implementations: `ArkovaVerifyTool`, `ArkovaAnchorStatusTool`, `ArkovaSearchTool`, `ArkovaAttestTool`, `ArkovaBatchVerifyTool`, `ArkovaVerifySignatureTool`, and `getArkovaTools()` convenience factory.
- **`index.test.ts`** — colocated tests for all tools with mocked fetch.

## Conventions
- Tools accept `ArkovaToolConfig` (`apiKey`, optional `baseUrl`, `timeoutMs`).
- Each tool has a `name` and `description` suitable for LLM tool-use.
- The compatibility contract is the zero-dependency `{ name, description,
  call(string) }` shape. These classes do not extend `@langchain/core` tool or
  Runnable classes; README examples must require an application-side adapter
  for framework versions that require those types.
- `arkovaFetch` sets `redirect: 'error'` after caller options. Never follow a
  redirect while carrying the custom `X-API-Key` header.
- 10s default timeout.
