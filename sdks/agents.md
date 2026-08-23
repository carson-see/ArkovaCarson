# sdks/agents.md

Developer SDK packages for integrating with the Arkova Verification API. Each subdirectory is an independent package.

## Subdirectories
- **`langchain/`** — LangChain Python-style tool wrappers (verify, oracle, search). Peer dep: `@langchain/core`.
- **`langchain-ts/`** — LangChain TypeScript tool wrappers (verify, anchor status, search, attest, batch, signature).
- **`mcp-server/`** — Model Context Protocol server exposing 10 tools (6 `arkova_` verification + 4 `nessie_` compliance intelligence, NCE-19) for Claude/OpenAI/Cursor.

## Files
- **`vitest.config.ts`** — shared Vitest config for all SDK packages. This is the CI entry point: the root `Tests` job in `.github/workflows/ci.yml` runs `node_modules/.bin/vitest run --root sdks` (step id `sdk-tests`), which discovers every `**/*.test.ts` under `sdks/`. Before 2026-08-15 nothing ran these suites in CI (BUG-2026-08-15-035) — keep new SDK tests as `*.test.ts` under a package `src/` so this config picks them up. Vitest resolves from the root node_modules; the SDK packages carry no devDependencies of their own.

## Conventions
- All SDKs authenticate via `ARKOVA_API_KEY` (starts with `ak_`).
- Tests must mock all HTTP calls; never hit real Arkova endpoints.
- Story: PH2-AGENT-06 (SCRUM-403).

## Where is the TypeScript SDK?

**`packages/sdk/`** — that is the one true `@carsonarkova/sdk` (class `Arkova`),
wired into `.github/workflows/publish-sdk.yml` and
`scripts/publish-packages.sh`. A stale duplicate previously lived here at
`sdks/typescript/` (class `ArkovaClient`) claiming the same npm name and
version with an incompatible API; it was removed 2026-07-12. Do not
recreate TypeScript client code under `sdks/` — extend `packages/sdk/`.
