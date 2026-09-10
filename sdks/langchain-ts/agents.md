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

## 2026-09-05 — 503 disclosure unified; batch cap named (PR #2589 review)

Parity pass with `sdks/mcp-server` — see that package's 2026-09-05 entry for the full rationale.
The two packages are independent (this one cannot import `packages/sdk` or the mcp-server), so the
helper, the phrase, and the constant are duplicated here deliberately rather than shared.

- **`DISABLED_CAPABILITY_PHRASE` + `disabledCapabilityMessage(status, body, subject)`** now run on
  **all 6** tools' non-OK paths (`ArkovaVerifyTool`, `ArkovaAnchorStatusTool`, `ArkovaSearchTool`,
  `ArkovaAttestTool`, `ArkovaBatchVerifyTool`, `ArkovaVerifySignatureTool`). Before, only Search and
  VerifySignature disclosed a 503 at all, with divergent fallbacks (`message ?? error` vs
  `message ?? code`). The unified chain is `message ?? error ?? code`, then `service_unavailable`.
  Same consequence as in mcp-server: `ArkovaVerifySignatureTool` on the worker's `{error, code}`
  AdES body now surfaces the human-readable `error` rather than `ADES_SIGNATURES_DISABLED`.
- **`VERIFY_BATCH_SYNC_LIMIT = 20`** exported, replacing the literal in `ArkovaBatchVerifyTool`'s
  description, its over-cap guard, and its over-cap message. Doc comment names the two upstream
  sources (`packages/sdk/src/client.ts` `VERIFY_BATCH_SYNC_LIMIT`,
  `services/worker/src/api/v1/batch.ts` `SYNC_THRESHOLD`); `index.test.ts` pins it at 20.
- `readErrorBody()` uses `try`/`catch`, not `res.json().catch()`, so a synchronously-throwing or
  absent `json()` cannot escape as a tool crash.

Suite for this package is 31 tests; `npx vitest run --root sdks` from the repo root covers both
packages (80 tests).

**Pre-existing, not introduced here:** `npx tsc --noEmit` in this package reports one error,
`tsconfig.json(5,25): TS5107 moduleResolution=node10 is deprecated`. It comes from the committed
`tsconfig.json` (last touched in PR #761) meeting the newer TypeScript resolved from the repo root
— this package declares no devDependencies of its own. Unrelated to this change and left alone.
