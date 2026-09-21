# sdks/langchain-ts/agents.md

`@arkova/langchain` — zero-dependency, LangChain-style callable tools for the Arkova record verification API. This is the maintained package; `sdks/langchain/` (no `package.json`, never wired up for publishing) is an earlier, superseded draft with a smaller tool set — see its `src/agents.md`.

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

Suite for this package is 32 tests after release qualification. Run it from
this package directory so its local config and pinned dev toolchain are used.

Historical pre-qualification note retained verbatim for append-only policy; the
2026-09-19 section below supersedes its counts and toolchain state:

Suite for this package is 31 tests; `npx vitest run --root sdks` from the repo root covers both
packages (80 tests).

**Pre-existing, not introduced here:** `npx tsc --noEmit` in this package reports one error,
`tsconfig.json(5,25): TS5107 moduleResolution=node10 is deprecated`. It comes from the committed
`tsconfig.json` (last touched in PR #761) meeting the newer TypeScript resolved from the repo root
— this package declares no devDependencies of its own. Unrelated to this change and left alone.

## 2026-09-19 — first-public-release qualification

- The package now owns its TypeScript/Vitest dev toolchain, lockfile and local
  Vitest config, and declares ESM so its emitted `dist/index.js` loads on the
  advertised Node 18 floor.
- Every API request rejects redirects before sending the custom `X-API-Key`;
  the regression was observed red before the shared fetch helper was fixed.
- README compatibility language is deliberately narrow: these are
  zero-dependency callable tool objects, not `@langchain/core` subclasses.
- `ArkovaVerifyTool.valid` derives only from the verification API's authoritative
  `verified` boolean. `SUBMITTED`, `PENDING`, revoked, and unknown states fail
  closed; the complete API response is preserved so status and proof evidence
  remain available to the caller.

## 2026-09-21 — recovered onto `main` + closed publish gaps (PR #2986 never actually landed)

The 2026-09-19 entry above describes changes PR #2986 made but that never reached `main`: the PR's
branch merged into `fix/hygiene-webhook-payloads`, which had already merged into `main` before #2986
itself merged, orphaning the diff (GitHub still showed MERGED). Applied here with no conflicts. On
top of the recovered content:

- **`tsconfig.json` `moduleResolution` was still the deprecated `node10` alias**, despite reading
  `"node"` in the file — `tsc --showConfig` shows `"node"` normalizes to `"node10"` internally, which
  is exactly the "TS5107 moduleResolution=node10 is deprecated" error the "pre-existing" paragraph
  above describes (that paragraph is now stale: this package DOES declare its own devDependencies as
  of the recovered 2026-09-19 content). Changed to `nodenext`/`nodenext` (matching
  `sdks/mcp-server/tsconfig.json`'s existing convention) — no source changes needed since this
  package has no relative imports of its own. Regression test:
  `src/package-metadata.test.ts`.
- **README's "in parity with `sdks/mcp-server`'s tool set" claim was stale even at the moment #2986
  merged its own branch**, and doubly so now: this package has always had 6 tools, but `sdks/mcp-server`
  has grown to 9 (`arkova_submit_anchor`, `arkova_get_submission_status`, and `arkova_manage_folders`
  have no equivalent here). Reworded to state the true, non-parity subset relationship.
- `package-lock.json` didn't exist before this recovery (PR #2986 added one, but it was excluded from
  the recovered diff and regenerated fresh via `npm install --package-lock-only` per the recovery's
  "never hand-merge a lockfile" rule) and `src/package-metadata.test.ts` is new — neither is from the
  original PR.

See `packages/sdk/agents.md`'s 2026-09-21 entry for the sibling-package recovery.
