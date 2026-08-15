# sdks/mcp-server/agents.md

`@arkova/mcp-server` — MCP server tools for Arkova credential verification (works with Claude, OpenAI, Cursor).

## Structure
- **`src/`** — MCP tool implementations.
- **`package.json`** — published to npm.

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball — `"license": "MIT"` alone doesn't discharge the obligation. See `scripts/security/package-license-files.test.ts`.

## 2026-08-15 BUG-008/027 — `nessie_ask` must not pass a disabled capability through as an answer

`nessie_ask` calls the worker in `mode=context`. Before the worker was gated, that returned HTTP 200
with `{"answer":"No relevant verified documents were found…","confidence":0}` and this handler passed
it through **verbatim** — a fluent sentence an agent reads as a completed search over an empty corpus,
not as "the feature is off". CTO ruling R-1 STRENGTHENED (2026-08-12).

`handleNessieAsk` now inspects a 503 for `code: 'nessie_disabled'` / `enabled: false` and returns an
error that says, in words, that this is **NOT** an empty result and no search ran. An ordinary
upstream failure still reports as `returned <status>` — keep the two distinguishable. The tool
description leads with `DISABLED`.

**This package's suite has 2 PRE-EXISTING failures on `main`**, unrelated to the above: `should define
6 tools` (there are 10) and `should use arkova_ prefix on all tool names` (the `nessie_*` tools do
not). They are not covered by root CI — the root `vitest.config.ts` `include` is `tests/**`, `src/**`,
`scripts/**`, so nothing under `sdks/` runs there. Run `npx vitest run` in this directory. Do not
"fix" the count assertion by trimming tools; the stale number is the bug.
