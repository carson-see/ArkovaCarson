# sdks/agents.md

Developer SDK packages for integrating with the Arkova Verification API. Each subdirectory is an independent package.

## Subdirectories
- **`langchain/`** — **UNSHIPPED. Not a package; not built, tested, published, or imported by
  anything.** LangChain Python-style tool wrappers (verify, oracle, search) that exist only as
  `src/index.ts` + `src/tools.ts` + `src/agents.md`. Verified 2026-09-05: no `package.json`, so no
  name, version, dependency set, `build`/`test` script, or `files` list; no `*.test.ts`, so
  `vitest run --root sdks` discovers nothing here and CI covers none of it; no README and no
  LICENSE; no entry in `.github/workflows/publish-sdk.yml` or `scripts/publish-packages.sh`; and no
  file anywhere in the repo imports it (`scripts/staging/fullsoak-sdk-integration.sh` and
  `scripts/security/package-license-files.test.ts` both reference `langchain-ts`, the sibling — the
  names are one hyphen apart, which is exactly how this gets misread). Its stated peer dep on
  `@langchain/core` is aspirational: nothing declares it. **Do not cite it as a shipped surface, do
  not soak it, and do not delete it** — it is kept as source-of-record for the Python-style wrapper
  shape. The shipped TypeScript LangChain wrappers are `langchain-ts/` below.
- **`langchain-ts/`** — LangChain TypeScript tool wrappers (verify, anchor status, search, attest, batch, signature).
- **`mcp-server/`** — Model Context Protocol server exposing 6 `arkova_`-prefixed verification
  tools for Claude/OpenAI/Cursor. Published to npm as unscoped `arkova-mcp-server`, `bin` entry
  runs the stdio server via `npx`. This is the **local/stdio** MCP server — the **hosted** MCP
  endpoint is `edge.arkova.ai` (`services/edge/`), a completely separate implementation with its
  own tool set; do not confuse the two or assume a fix to one reaches the other.
  **2026-09-02:** the 4 `nessie_`-prefixed compliance-intelligence tools (NCE-19) that used to be
  listed here were removed — three 401'd for every real caller (the worker's `/compliance/*`
  routes require a Supabase JWT and explicitly reject `Bearer ak_…`, which is all this server ever
  sends) and the fourth was already a standing 503 by founder directive. See
  `mcp-server/agents.md`'s "nessie_* tool removal" entry.

## Files
- **`vitest.config.ts`** — shared Vitest config for all SDK packages. This is the CI entry point: the root `Tests` job in `.github/workflows/ci.yml` runs `node_modules/.bin/vitest run --root sdks` (step id `sdk-tests`), which discovers every `**/*.test.ts` under `sdks/`. Before 2026-08-15 nothing ran these suites in CI (BUG-2026-08-15-035) — keep new SDK tests as `*.test.ts` under a package `src/` so this config picks them up. Vitest resolves from the root node_modules; the SDK packages carry no devDependencies of their own.

## Conventions
- All SDKs authenticate via `ARKOVA_API_KEY` (starts with `ak_`).
- Tests must mock all HTTP calls; never hit real Arkova endpoints.
- Story: PH2-AGENT-06 (SCRUM-403).

## Where is the TypeScript SDK?

**`packages/sdk/`** — that is the one true `arkova` package (class `Arkova`),
wired into `.github/workflows/publish-sdk.yml` and
`scripts/publish-packages.sh`. A stale duplicate previously
`scripts/publish-packages.sh` / `scripts/release/publish-npm.sh`. A stale duplicate previously
lived here at `sdks/typescript/` (class `ArkovaClient`) claiming the same npm name and
version with an incompatible API; it was removed 2026-07-12. Do not
recreate TypeScript client code under `sdks/` — extend `packages/sdk/`.
Published npm name history: `@arkova/sdk` -> `@carsonarkova/sdk` (2026-08-01, org-scope
ruling, see `HANDOFF.md` `## History`) -> unscoped `arkova` (2026-08-18, CTO ruling, PyPI
parity — see `packages/sdk/agents.md`).


## 2026-09-05 — UNSHIPPED marking, duplicate bullet removed (PR #2589 review)

- **`langchain/` marked UNSHIPPED** above, with the evidence inline. It was listed as a peer of the
  three real packages, which is how a reviewer comes to believe it is built and covered. It is
  neither. Kept in the tree, per instruction — the marking is the fix, not deletion.
- **Removed a stale duplicate `mcp-server/` bullet.** This file carried the entry twice: the
  corrected 6-tool version, immediately followed by the superseded 10-tool one (6 `arkova_` +
  4 `nessie_`). The 4 `nessie_` tools were removed 2026-09-02; the second bullet contradicted the
  first two lines above it. One bullet now, the correct one.
- Both `mcp-server/` and `langchain-ts/` gained 2026-09-05 entries in their own `agents.md` for the
  503-disclosure and `VERIFY_BATCH_SYNC_LIMIT` changes in the same review pass.
