# sdks/mcp-server/agents.md

`@arkova/mcp-server` — MCP server tools for Arkova credential verification (works with Claude, OpenAI, Cursor).

## Structure
- **`src/`** — MCP tool implementations.
- **`package.json`** — published to npm.

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball — `"license": "MIT"` alone doesn't discharge the obligation. See `scripts/security/package-license-files.test.ts`.
