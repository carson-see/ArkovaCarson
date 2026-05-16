# sdks/langchain/src/agents.md

LangChain tool wrappers for Arkova credential verification (PH2-AGENT-06).

## Files
- **`index.ts`** — barrel export for `ArkovaVerifyTool`, `ArkovaOracleTool`, `ArkovaSearchTool`, `getArkovaTools`.
- **`tools.ts`** — LangChain-compatible tool classes. Each wraps an Arkova API endpoint. Peer dependency: `@langchain/core`.

## Conventions
- Default base URL: `https://app.arkova.ai/api/v1`. Override via `ArkovaToolConfig.baseUrl`.
- 10s default timeout.
- Tools are designed for `AgentExecutor` integration.
