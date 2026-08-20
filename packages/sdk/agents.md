# packages/sdk/agents.md

`arkova` — TypeScript SDK for the Arkova Verification API (PH1-SDK-01 + INT-01).

## Structure
- **`src/`** — client, types, barrel export.
- **`examples/`** — usage examples.
- **`vitest.config.ts`** — test runner config.
- **`package.json`** — published to npm; works in Node.js and browser.

## Conventions
- Client-side fingerprinting via SHA-256 (documents never leave the user's device).
- Published via `.github/workflows/publish-sdk.yml`, or manually via `scripts/release/publish-npm.sh`.
- Must stay in sync with `integrations/shared/src/fingerprint.ts` algorithm.
- **npm name is unscoped `arkova` (CTO ruling 2026-08-18), superseding the 2026-08-01
  `@carsonarkova/sdk` scoped-package ruling below.** Parity with the PyPI package, which already
  publishes unscoped as `arkova`. An unscoped name needs no npm org at all — first-publish
  ownership is per-package, not per-org — so the `carsonarkova`-vs-`arkova` org-scope question
  that blocked the 2026-08-01 attempt is moot for this package. Confirmed free via
  `npm view arkova` (E404) on 2026-08-18. `@arkova/*` scoped aliases can follow later if the
  founder creates the `arkova` org on npmjs.com, but nothing requires that today.
  `publishConfig.provenance` was dropped from `package.json` in the same change: provenance
  attestation needs CI/OIDC (`id-token: write`) and fails outright on a manual laptop publish,
  which is the near-term path (`scripts/release/publish-npm.sh`, no npm auth on the agent
  machine — operator finishes the publish themselves). `.github/workflows/publish-sdk.yml`
  still requests `--provenance` explicitly on its `npm publish` invocation and has real OIDC via
  `permissions: id-token: write`, so CI-path provenance is unaffected by this change — only the
  publishConfig default was removed. Restore `publishConfig.provenance: true` once the CI
  workflow is the proven, exercised publish path rather than the untested one.
  **Historical record, not current guidance:** the 2026-08-01 `@carsonarkova/sdk` rename (PR
  #1785) and its org-scope rationale are preserved in `HANDOFF.md` `## History` — read there for
  what actually happened, not here. `packages/embed` (`@arkova/embed`) is unaffected by either
  ruling and keeps its own scope question open (see `scripts/publish-packages.sh`).

## Methods added since PH1-SDK-01
- `anchorBulk(inputs, options?)` (W3 / HAKI-REQ-02 wiring, 2026-07-28) — wires `POST /api/v1/anchor/bulk` (`services/worker/src/api/v1/anchor-bulk.ts`). Rows accept either a pre-computed `fingerprint` or raw `data` (fingerprinted client-side via the existing `fingerprint()` helper — never both, never neither). Caps at `BULK_ANCHOR_MAX_ROWS` (1000, mirrors the server's `.max(1000)`) and throws `ArkovaError({code:'batch_too_large'})` client-side rather than auto-chunking — chunking would split intra-batch duplicate detection and credit deduction across requests. `dryRun` / `duplicateStrategy` / `batchId` map to the server's `dry_run` / `duplicate_strategy` / `batch_id`. See `client.test.ts` `describe('anchorBulk', ...)` for the full contract (cap boundary, mixed input types, dry-run, per-row errors, 409 duplicate-fail, 402 insufficient-credits).
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball — `"license": "MIT"` alone doesn't discharge the obligation. See `scripts/security/package-license-files.test.ts`.
- **`package.json` `repository`/`author`** (2026-08-18, npm-publish clean-room verification): were missing entirely — added, matching the sibling `sdks/mcp-server/package.json` pattern (`repository.directory: "packages/sdk"`). `keywords` also had `"bitcoin"` (§1.3-banned, indexed on npmjs.com) — replaced with `"credentials"`. Guarded going forward by `src/package-metadata.test.ts`.
- **README/type-doc terminology + accuracy pass** (2026-08-18, npm-publish clean-room verification, same change as the `sdks/mcp-server` P0 fix): fixed "Bitcoin anchor status"-style prose (→ "network"), x402 "wallet" references (→ "signer" — this SDK's x402 config takes a real third-party on-chain signer, a different concept from the §1.3 "Wallet → Fee Account" UI-copy mapping, which is about *Arkova's own* product surface), and added two accuracy disclosures the README previously lacked: (1) the "Nessie semantic search" section (`query()`/`ask()`) now states up front that `GET /api/v1/nessie/query` is gated off in production today (`ENABLE_PUBLIC_RECORD_EMBEDDINGS` switchboard flag, confirmed off) and returns 503 until launch; (2) the x402 section now states payments currently settle on Base Sepolia (confirmed via `services/worker/src/config.ts`'s `x402Network` default `eip155:84532` and `deploy-worker.yml`'s prod env-var, which sets the same value), not Base's production network. See `src/terminology.test.ts` for the standing guard.
