# packages/sdk/agents.md

`@carsonarkova/sdk` — TypeScript SDK for the Arkova Verification API (PH1-SDK-01 + INT-01).

## Structure
- **`src/`** — client, types, barrel export.
- **`examples/`** — usage examples.
- **`vitest.config.ts`** — test runner config.
- **`package.json`** — published to npm; works in Node.js and browser.

## Conventions
- Client-side fingerprinting via SHA-256 (documents never leave the user's device).
- Published via `.github/workflows/publish-sdk.yml`.
- Must stay in sync with `integrations/shared/src/fingerprint.ts` algorithm.
- **npm scope is `carsonarkova`, not `arkova`** (founder ruling 2026-08-01): the org that was
  actually created and that the Secret Manager `NPM` token is scoped to (`package:write` +
  `org:write`) is `carsonarkova` (owner: crseeger), confirmed empty at the time of the rename.
  The `arkova` scope returned 403 on every access/org check for that token — either never
  created or owned by someone else; `carsonarkova` was ruled to be the intended org all along,
  so the package name changed to match instead of chasing the `arkova` scope. Do not rename
  back without a new explicit ruling. `packages/embed` (`@arkova/embed`) was NOT included in
  this ruling and still targets the old scope — that's a known, currently-unresolved mismatch,
  not an oversight (see `scripts/publish-packages.sh`).

## Methods added since PH1-SDK-01
- `anchorBulk(inputs, options?)` (W3 / HAKI-REQ-02 wiring, 2026-07-28) — wires `POST /api/v1/anchor/bulk` (`services/worker/src/api/v1/anchor-bulk.ts`). Rows accept either a pre-computed `fingerprint` or raw `data` (fingerprinted client-side via the existing `fingerprint()` helper — never both, never neither). Caps at `BULK_ANCHOR_MAX_ROWS` (1000, mirrors the server's `.max(1000)`) and throws `ArkovaError({code:'batch_too_large'})` client-side rather than auto-chunking — chunking would split intra-batch duplicate detection and credit deduction across requests. `dryRun` / `duplicateStrategy` / `batchId` map to the server's `dry_run` / `duplicate_strategy` / `batch_id`. See `client.test.ts` `describe('anchorBulk', ...)` for the full contract (cap boundary, mixed input types, dry-run, per-row errors, 409 duplicate-fail, 402 insufficient-credits).
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball — `"license": "MIT"` alone doesn't discharge the obligation. See `scripts/security/package-license-files.test.ts`.
