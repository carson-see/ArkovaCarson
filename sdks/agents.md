# sdks/agents.md

Developer SDK packages for integrating with the Arkova Verification API. Each subdirectory is an independent package.

## Subdirectories
- **`typescript/`** — `@arkova/sdk` TypeScript client (anchor, verify, batch). Published to npm.
- **`langchain/`** — LangChain Python-style tool wrappers (verify, oracle, search). Peer dep: `@langchain/core`.
- **`langchain-ts/`** — LangChain TypeScript tool wrappers (verify, anchor status, search, attest, batch, signature).
- **`mcp-server/`** — Model Context Protocol server exposing 6 Arkova tools for Claude/OpenAI/Cursor.

## Files
- **`vitest.config.ts`** — shared Vitest config for all SDK packages.

## Conventions
- All SDKs authenticate via `ARKOVA_API_KEY` (starts with `ak_`).
- Tests must mock all HTTP calls; never hit real Arkova endpoints.
- Story: PH2-AGENT-06 (SCRUM-403).
