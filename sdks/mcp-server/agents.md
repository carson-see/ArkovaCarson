# sdks/mcp-server/agents.md

`arkova-mcp-server` — MCP server tools for Arkova credential verification (works with Claude, OpenAI, Cursor). This is the **local/stdio** MCP server; the **hosted** endpoint is `edge.arkova.ai` (`services/edge/`), a separate Cloudflare Worker implementation with its own tool set and transport (streamable HTTP, not stdio) — see `sdks/agents.md`.

## Structure
- **`src/index.ts`** — `TOOL_DEFINITIONS` + `handleToolCall()`: the tool library, transport-agnostic.
- **`src/cli.ts`** — the npm `bin` entrypoint (`arkova-mcp-server`). Wires `index.ts` onto a real `@modelcontextprotocol/sdk` `Server` over `StdioServerTransport`. Has a shebang (`#!/usr/bin/env node`); `tsc` preserves it in `dist/cli.js`. Exports `createServer()` so tests can drive the server over an `InMemoryTransport` instead of real stdio — importing this module never starts a live server on its own, guarded by `isRunAsScript()`.
  - **P0 fix (npm-publish clean-room verification, 2026-08-18):** the guard used to be a plain `import.meta.url === \`file://${process.argv[1]}\`` string compare. That is true under `node dist/cli.js` but npm's `bin` field is ALWAYS installed as a symlink (`node_modules/.bin/arkova-mcp-server -> ../arkova-mcp-server/dist/cli.js`, same for a global install, same for `npx`'s temp cache) — Node's ESM loader resolves `import.meta.url` through the symlink to the real file while `process.argv[1]` stays the invoked (symlinked) path, so the two never matched for any real install. `main()` silently never ran: the compiled bin printed nothing and exited 0, tools never registered, for `npx -y arkova-mcp-server`, a global install, and the Claude Desktop config this README documents — i.e. every real invocation path. Fixed by resolving both sides with `realpathSync` before comparing (`isRunAsScript()`). Regression-tested in `src/cli.bin.test.ts`, which builds `dist/cli.js`, symlinks it the way npm does, and spawns a real `node` process against the symlink — the in-process `InMemoryTransport` tests in `cli.test.ts` cannot catch this class of bug because importing the module under vitest never exercises the argv-vs-symlink comparison a real spawned process does.
- **`src/cli.bin.test.ts`** — the symlinked-bin regression test described above. Builds fresh in `beforeAll` so it always exercises the actual shipped `dist/`, not a stale one.
- **`package.json`** — published to npm as unscoped `arkova-mcp-server` (2026-08-18, CTO ruling — see `packages/sdk/agents.md` for the parallel npm-name history). `bin.arkova-mcp-server -> dist/cli.js`, `"type": "module"` (required — `tsconfig.json` targets `module: ESNext`; without it Node refuses to load the emitted `export`/`import` syntax as CommonJS). Real `dependencies`/`devDependencies` were added in the same change — the package previously declared **none** despite `"test": "vitest run"` and `"build": "tsc"` scripts, silently relying on whatever `npx` happened to resolve. `package-lock.json` is now committed for the same reason `packages/sdk/package-lock.json` is.
- **`node_modules/`, `package-lock.json` before 2026-08-18** — not committed / didn't exist; this package installs independently of the repo root (no npm workspaces here), same as `packages/sdk`.

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball — `"license": "MIT"` alone doesn't discharge the obligation. See `scripts/security/package-license-files.test.ts`.

## Nessie-off gap — investigated and resolved (npm-publish clean-room verification, 2026-08-18)
Nessie is off in production by standing founder directive (2026-08-01). The prior note here flagged all 4 `nessie_`-prefixed tools as at risk without checking server-side — the real picture, confirmed by reading `services/worker/src/api/v1/`:
- `nessie_compliance_score` → `GET /api/v1/compliance/score`, `nessie_gap_analysis` → `POST /api/v1/compliance/gap-analysis`, `nessie_cross_reference` → `POST /api/v1/compliance/cross-reference` — all three route to `services/worker/src/compliance/score-calculator.ts` / `cross-reference.ts`, deterministic rule-based compliance calculators with **no AI/embedding call and no feature-flag gate**. They work today with a valid API key, independent of the Nessie AI pipeline being off.
- `nessie_ask` → `GET /api/v1/nessie/query` is the one tool that actually depends on the disabled feature — gated by the `ENABLE_PUBLIC_RECORD_EMBEDDINGS` switchboard flag (`services/worker/src/api/v1/nessie-query.ts`), which is off, so it returns a clean `503 { error: 'Nessie query endpoint is not enabled' }` (not a crash, not a hang).

**Resolution: document, don't hide.** Hiding all 4 tools would have removed 3 genuinely working ones on a false premise. Instead: `nessie_ask`'s tool description now discloses the current 503 in the wire-level `tools/list` response (not just the README), and `handleNessieAsk` in `index.ts` now surfaces the server's actual error message instead of a bare `Nessie query API returned 503`, so a caller can tell "not launched yet" apart from "outage" or "bad input." The README's Tools table carries the same disclosure plus a note that the other 3 don't depend on this flag. See `arkova`'s (the SDK's) parallel fix in `packages/sdk/README.md`'s "Nessie semantic search" section — `arkova.query()`/`arkova.ask()` hit the same `/api/v1/nessie/query` endpoint.
## 2026-08-15 BUG-008/027 — `nessie_ask` must not pass a disabled capability through as an answer

`nessie_ask` calls the worker in `mode=context`. Before the worker was gated, that returned HTTP 200
with `{"answer":"No relevant verified documents were found…","confidence":0}` and this handler passed
it through **verbatim** — a fluent sentence an agent reads as a completed search over an empty corpus,
not as "the feature is off". CTO ruling R-1 STRENGTHENED (2026-08-12).

`handleNessieAsk` now inspects a 503 for `code: 'nessie_disabled'` / `enabled: false` and returns an
error that says, in words, that this is **NOT** an empty result and no search ran. An ordinary
upstream failure still reports as `returned <status>` — keep the two distinguishable. The tool
description leads with `DISABLED`.

**Suite status (corrected 2026-09-02):** this package's suite is **green** and **is** gated by
root CI. The two failures previously recorded here (`should define 6 tools`, `should use arkova_
prefix on all tool names`) no longer exist — the assertions were updated to the real 10-tool shape
(6 `arkova_` + 4 `nessie_`). The claim that nothing under `sdks/` runs in CI described the
pre-2026-08-15 state and was fixed by BUG-2026-08-15-035: `.github/workflows/ci.yml` job `test`,
step id `sdk-tests`, runs `node_modules/.bin/vitest run --root sdks`, which discovers every
`**/*.test.ts` under `sdks/`. A failing SDK test now blocks merge. Run locally with
`node_modules/.bin/vitest run --root sdks` from the repo root, or `npx vitest run` in this
directory.

## 2026-09-02 — tool rename: "credential" removed from tool names

`arkova_verify_anchor` → `arkova_verify_anchor`, `arkova_credential_status` →
`arkova_anchor_status`, `arkova_search_anchors` → `arkova_search_anchors`.

**Why.** In an agent's tool namespace "credentials" reads as *authentication secrets*, not as
*verified records*. Given the old names, an agent asked to "search arkova credentials" did not call
this server at all — it resolved the word to secrets, swept the local filesystem with its own
file-read tools, and printed `.env.local` / `.env.staging` contents including a live production
`ORG_ADMIN` password. The server itself was never involved and could not have been: every handler
here is a `fetch()` to `/api/v1/*` and the package's only `fs` call is `realpathSync` in
`cli.ts` for the entrypoint guard. The tool *name* was the whole defect.

**No aliases.** Keeping the old names available would preserve exactly the ambiguity that caused the
failure. Renamed in place; adopter risk was checked first (prod `audit_events` holds zero
`MCP_TOOL_CALL` rows, and the package was 13 days old with its source not yet on `main`).

**`API_ONLY_NOTE`** in `index.ts` is the second half of the fix: it is appended to the three
descriptions and states, in the surface the model actually reads, that these tools query the Arkova
API over HTTPS and do not read local files, environment variables, or secrets. Do not drop it when
editing descriptions.

**The same collision exists on the hosted worker** (`services/edge/`), renamed in the same change:
`verify_anchor` → `verify_anchor`, `search_anchors` → `search_anchors`. The two
implementations are independent — a fix to one does not reach the other. The edge worker also ships
bare `search` and `verify` (v2 "agent-friendly" tools) with no `arkova_` prefix at all; that is
the same class of namespace hazard and is **not** fixed here.
