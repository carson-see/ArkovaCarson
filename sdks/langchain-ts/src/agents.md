# sdks/langchain-ts/src/agents.md

LangChain TypeScript tool wrappers for Arkova (PH2-AGENT-06 / SCRUM-403).

## Files
- **`index.ts`** — tool implementations: `ArkovaVerifyTool`, `ArkovaAnchorStatusTool`, `ArkovaSearchTool`, `ArkovaAttestTool`, `ArkovaBatchVerifyTool`, `ArkovaVerifySignatureTool`, and `getArkovaTools()` convenience factory.
- **`index.test.ts`** — colocated tests for all tools with mocked fetch.

## Conventions
- Tools accept `ArkovaToolConfig` (`apiKey`, optional `baseUrl`, `timeoutMs`).
- Each tool has a `name` and `description` suitable for LLM tool-use.
- 10s default timeout.
