# packages/sdk/agents.md

`@arkova/sdk` — TypeScript SDK for the Arkova Verification API (PH1-SDK-01 + INT-01).

## Structure
- **`src/`** — client, types, barrel export.
- **`examples/`** — usage examples.
- **`vitest.config.ts`** — test runner config.
- **`package.json`** — published to npm; works in Node.js and browser.

## Conventions
- Client-side fingerprinting via SHA-256 (documents never leave the user's device).
- Published via `.github/workflows/publish-sdk.yml`.
- Must stay in sync with `integrations/shared/src/fingerprint.ts` algorithm.

## Methods added since PH1-SDK-01
- `anchorBulk(inputs, options?)` (W3 / HAKI-REQ-02 wiring, 2026-07-28) — wires `POST /api/v1/anchor/bulk` (`services/worker/src/api/v1/anchor-bulk.ts`). Rows accept either a pre-computed `fingerprint` or raw `data` (fingerprinted client-side via the existing `fingerprint()` helper — never both, never neither). Caps at `BULK_ANCHOR_MAX_ROWS` (1000, mirrors the server's `.max(1000)`) and throws `ArkovaError({code:'batch_too_large'})` client-side rather than auto-chunking — chunking would split intra-batch duplicate detection and credit deduction across requests. `dryRun` / `duplicateStrategy` / `batchId` map to the server's `dry_run` / `duplicate_strategy` / `batch_id`. See `client.test.ts` `describe('anchorBulk', ...)` for the full contract (cap boundary, mixed input types, dry-run, per-row errors, 409 duplicate-fail, 402 insufficient-credits).
