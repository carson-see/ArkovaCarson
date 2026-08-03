# sdks/langchain/src/agents.md

LangChain tool wrappers for Arkova credential verification (PH2-AGENT-06).

## Files
- **`index.ts`** — barrel export for `ArkovaVerifyTool`, `ArkovaOracleTool`, `ArkovaSearchTool`, `getArkovaTools`.
- **`tools.ts`** — LangChain-compatible tool classes. Each wraps an Arkova API endpoint. Peer dependency: `@langchain/core`.

## Conventions
- Default base URL: `https://app.arkova.ai/api/v1`. Override via `ArkovaToolConfig.baseUrl`.
- 10s default timeout.
- Tools are designed for `AgentExecutor` integration.

## Publishing status (2026-07-28, engineering-counsel MIT/LICENSE review)
This directory has **no `package.json`** and is **not published**. It's an
earlier, smaller draft (3 tools: `ArkovaVerifyTool`, `ArkovaOracleTool`,
`ArkovaSearchTool`) superseded by the maintained, publishable package at
`sdks/langchain-ts/` (6 tools, has `package.json` + `LICENSE` + README +
tsconfig). No LICENSE file was added here — there is nothing to package.
If this source is ever revived as its own publishable package, add a
`package.json` with `"license": "MIT"` plus a `LICENSE` file (copy from
`packages/verifier-cli/LICENSE`) at that time; don't assume publishing
intent that hasn't been decided.
