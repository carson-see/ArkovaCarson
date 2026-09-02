# sdks/langchain-ts/agents.md

`@arkova/langchain` — LangChain tool wrappers for the Arkova record verification API. This is the maintained package; `sdks/langchain/` (no `package.json`, never wired up for publishing) is an earlier, superseded draft with a smaller tool set — see its `src/agents.md`.

## Structure
- **`src/index.ts`** — barrel export + tool classes (`ArkovaVerifyTool`, `ArkovaAnchorStatusTool`, `ArkovaSearchTool`, `ArkovaAttestTool`, `ArkovaBatchVerifyTool`, `ArkovaVerifySignatureTool`, `getArkovaTools`).
- **`package.json`** — **not published to npm.** `@arkova/langchain` was previously documented here as "published to npm" without verification; it returns a 404 on the registry (`curl -sD - https://registry.npmjs.org/@arkova/langchain` — checked 2026-09-02). No package name is reserved and there is no version to install. See README.md's "Not yet published" note.

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in a tarball once this package is published — `"license": "MIT"` alone doesn't discharge the obligation. See `scripts/security/package-license-files.test.ts`.

## 2026-09-02 — npm-truth audit fixes (D5/F2-F13)

Companion pass to the `sdks/mcp-server` tool-rename branch, done in the same session:
- **F9 (this file's prior "published to npm" claim was false)** — corrected above and in README.md.
- **F5** — `ArkovaAnchorStatusTool` description said "Bitcoin anchor status" (CLAUDE.md §1.3 violation); fixed to "network anchor status". A standing §1.3 + credential-scrub terminology guard (mirroring `sdks/mcp-server/src/index.test.ts`) was added to `index.test.ts`.
- **Tool-set parity with `sdks/mcp-server`** — descriptions now carry the same `API_ONLY_NOTE` disclosure, `arkova_batch_verify` is capped at 20 public IDs (was 100 — `SYNC_THRESHOLD=20` server-side, see mcp-server's D6/F7), `arkova_search_anchors` and `arkova_verify_signature` disclose a disabled-capability 503 instead of swallowing it into a bare "API returned 503", `arkova_create_attestation`'s description now documents the required `attester_name`/`claims` fields, and "credential"/"fingerprint" over-claims were scrubbed from descriptions (F6, F8) — `credential_type` survives only as the literal API response field name.
