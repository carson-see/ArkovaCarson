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

**2026-09-02 — superseded: all 4 removed, not just disclosed.** The "document, don't hide" resolution above held only while this server's auth model matched the compliance routes' auth model. It didn't: this server sends `X-API-Key` on every request (see `arkovaFetch` in `index.ts`), but `services/worker/src/api/v1/router.ts` mounts a Supabase-JWT-only `requireAuth` middleware on `/compliance/score`, `/compliance/gap-analysis`, and `/compliance/cross-reference` — its very first line is `if (!authHeader?.startsWith('Bearer ') || authHeader.startsWith('Bearer ak_'))`, which explicitly rejects `Bearer ak_…` API keys, and this server never sends an `Authorization` header at all. So the "no feature-flag gate, work today with a valid API key" finding above was accurate about the feature flag and wrong about reachability: all three 401 for every real caller of this package, regardless of key validity. `nessie_ask` was already a standing 503 by founder directive (below). With 0 of 4 `nessie_`-prefixed tools reachable, disclosure was no longer the right fix — `nessie_compliance_score`, `nessie_gap_analysis`, `nessie_ask`, and `nessie_cross_reference` were removed from `TOOL_DEFINITIONS` and `handleToolCall` in `index.ts`. Tool count is now 6 (all `arkova_`-prefixed). This paragraph is superseded, not deleted, so the investigative finding above (which flag gates which tool) stays correct history. See `arkova`'s (the SDK's) parallel Nessie note in `packages/sdk/README.md` — that fix is unaffected, since `packages/sdk` calls `/api/v1/nessie/query` directly with whatever auth the caller supplies, not through this package's fixed `X-API-Key`-only `arkovaFetch`.
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
prefix on all tool names`) no longer exist — and the 10-tool shape (6 `arkova_` + 4 `nessie_`) this
note once described is itself superseded: the 4 `nessie_`-prefixed tools were removed the same day
(see "nessie_* tool removal" below), so the assertions now pin the real 6-tool, all-`arkova_` shape.
The claim that nothing under `sdks/` runs in CI described the
pre-2026-08-15 state and was fixed by BUG-2026-08-15-035: `.github/workflows/ci.yml` job `test`,
step id `sdk-tests`, runs `node_modules/.bin/vitest run --root sdks`, which discovers every
`**/*.test.ts` under `sdks/`. A failing SDK test now blocks merge. Run locally with
`node_modules/.bin/vitest run --root sdks` from the repo root, or `npx vitest run` in this
directory.

## 2026-09-02 — tool rename: "credential" removed from tool names

`arkova_verify_credential` → `arkova_verify_anchor`, `arkova_credential_status` →
`arkova_anchor_status`, `arkova_search_credentials` → `arkova_search_anchors`.
(A prior revision of this note corrupted this table — a blanket find/replace of "credential"
rewrote the *old* column too, so it read `arkova_verify_anchor` → `arkova_verify_anchor` and
`arkova_search_anchors` → `arkova_search_anchors`, an apparent no-op. Fixed above: the pre-rename
names are the whole point of the row.)

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

## 2026-09-02 — nessie_* tool removal + npm-truth audit fixes (D5, F2-F13)

**D5 — all 4 `nessie_`-prefixed tools removed.** See the superseded-resolution note above. Tool
count is 6, all `arkova_`-prefixed. `index.test.ts`'s exact-name ratchet, the DX-04 prefix test, and
`cli.bin.test.ts`'s symlinked stdio smoke test were all updated from 10 to 6.

**F2/F11/F12 — `arkova_create_attestation` 400'd on every call.** The worker's
`CreateAttestationSchema` (`services/worker/src/api/v1/attestations.ts`) requires `attester_name`
(min 1 char) and a non-empty `claims` array; the tool exposed neither. Both are now required
`inputSchema` properties (`claims` as a JSON-array-of-objects string, matching the existing
`public_ids`/former `anchor_ids` encoding pattern for complex inputs), passed through in
`handleCreateAttestation`. On a 400 the worker's `details: [{field, message}]` array is now
appended to the error text instead of being dropped (F11). The description's "Requires organization
admin privileges" claim was false — the route only calls `requireAuth` (any authenticated caller);
fixed (F12).

**F3/F4 — a disabled capability must not read as an empty/negative result.** `arkova_search_anchors`
(worker: `Semantic search is not currently enabled`, `service_unavailable`) and
`arkova_verify_signature` (worker: `ADES_SIGNATURES_DISABLED`) both used to collapse a live 503 into
a bare `"… API returned 503"`. Both now mirror the disclosure pattern the removed `nessie_ask` used
(quoted above): state in words that the capability is off in this environment, that this is **NOT**
an empty/negative result, and include the server's own message.

**D6/F7 — `arkova_batch_verify` capped at 20.** The worker's `SYNC_THRESHOLD=20`; above it the API
returns `202 {job_id,…}` with no results and this tool has no way to fetch them. The schema's
`public_ids` property carries `maxItems: 20` (a hint, since the wire encoding is still a JSON string
per the `Record<string,string>` args shape — see F2 note above), the handler rejects >20 before
calling the API, and the description now reads "up to 20 public IDs at once; results returned
inline" instead of the old max-100 claim.

**F6 — dropped the false "or document fingerprint" claim.** `arkova_verify_anchor` /
`arkova_anchor_status` and their `public_id` property descriptions said the API accepts "public ID
or document fingerprint". `GET /api/v1/verify/:publicId` (what these tools call) only matches
`public_id` — fingerprint-based lookup is a *different* endpoint (`POST /api/verify-anchor`) this
package doesn't call. Same fix applied to `sdks/langchain-ts`.

**F8 — "credential" scrubbed from every agent-visible string** in `index.ts` (descriptions,
property descriptions, result/error text) and in `sdks/langchain-ts/src/index.ts`. `credential_type`
survives only as the literal API response field name, never in prose. `index.test.ts` gained two
standing guards: no tool NAME may contain "credential", and no description/property description may
contain "credentials" (plural) at all — mirrored in `sdks/langchain-ts/src/index.test.ts`.

**F10 — `parseInt(args.limit || '5', 10)` sent `limit=NaN` on non-numeric input.** Replaced with a
`parseLimit()` helper using `Number.isFinite`, same default of 5.

**F9/F13 — `sdks/langchain-ts`** was never actually published (`@arkova/langchain` 404s on the npm
registry); its README and agents.md previously claimed otherwise. Corrected in both files —
see `sdks/langchain-ts/agents.md`. `sdks/langchain/src/tools.ts:80` said "blockchain anchor
timestamp" (§1.3 violation); fixed to "network anchor timestamp".

**Version:** `package.json` and `SERVER_VERSION` (`cli.ts`) bumped to `3.0.0` — breaking change
(tool removal + rename). `sdks/langchain-ts/package.json` bumped to `3.0.0` in the same pass for
tool-set parity.
