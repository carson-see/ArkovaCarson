# sdks/mcp-server/agents.md

`arkova-mcp-server` — MCP server tools for Arkova credential verification (works with Claude, OpenAI, Cursor). This is the **local/stdio** MCP server; the **hosted** endpoint is `edge.arkova.ai` (`services/edge/`), a separate Cloudflare Worker implementation with its own tool set and transport (streamable HTTP, not stdio) — see `sdks/agents.md`.

## Structure
- **`src/index.ts`** — `TOOL_DEFINITIONS` + `handleToolCall()`: the tool library, transport-agnostic.
- **`src/cli.ts`** — the npm `bin` entrypoint (`arkova-mcp-server`). Wires `index.ts` onto a real `@modelcontextprotocol/sdk` `Server` over `StdioServerTransport`. Has a shebang (`#!/usr/bin/env node`); `tsc` preserves it in `dist/cli.js`. Exports `createServer()` so tests can drive the server over an `InMemoryTransport` instead of real stdio — importing this module never starts a live server on its own (guarded by `import.meta.url === file://${process.argv[1]}`, true only when the compiled file is the process entry point).
- **`package.json`** — published to npm as unscoped `arkova-mcp-server` (2026-08-18, CTO ruling — see `packages/sdk/agents.md` for the parallel npm-name history). `bin.arkova-mcp-server -> dist/cli.js`, `"type": "module"` (required — `tsconfig.json` targets `module: ESNext`; without it Node refuses to load the emitted `export`/`import` syntax as CommonJS). Real `dependencies`/`devDependencies` were added in the same change — the package previously declared **none** despite `"test": "vitest run"` and `"build": "tsc"` scripts, silently relying on whatever `npx` happened to resolve. `package-lock.json` is now committed for the same reason `packages/sdk/package-lock.json` is.
- **`node_modules/`, `package-lock.json` before 2026-08-18** — not committed / didn't exist; this package installs independently of the repo root (no npm workspaces here), same as `packages/sdk`.

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball — `"license": "MIT"` alone doesn't discharge the obligation. See `scripts/security/package-license-files.test.ts`.

## Known pre-existing gap, not addressed in the 2026-08-18 npm-publish-prep change
Nessie is off in production by standing founder directive (2026-08-01), yet 4 of the 10 tools here (`nessie_compliance_score`, `nessie_gap_analysis`, `nessie_ask`, `nessie_cross_reference`) call Nessie-backed endpoints and will presumably error/degrade for any real user of the now-publicly-published package. This is pre-existing (NCE-19) and out of scope for a packaging/naming change — flagged for separate follow-up rather than silently fixed or silently shipped without comment.
