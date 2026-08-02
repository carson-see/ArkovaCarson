# sdks/langchain-ts/agents.md

`@arkova/langchain` — LangChain tool wrappers for the Arkova credential verification API. This is the maintained package; `sdks/langchain/` (no `package.json`, never wired up for publishing) is an earlier, superseded draft with a smaller tool set — see its `src/agents.md`.

## Structure
- **`src/index.ts`** — barrel export + tool classes (`ArkovaVerifyTool`, `ArkovaAnchorStatusTool`, `ArkovaSearchTool`, `ArkovaAttestTool`, `ArkovaBatchVerifyTool`, `ArkovaVerifySignatureTool`, `getArkovaTools`).
- **`package.json`** — published to npm.

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball — `"license": "MIT"` alone doesn't discharge the obligation. See `scripts/security/package-license-files.test.ts`.
