# sdks/typescript/src/agents.md

Source code for `@arkova/sdk` TypeScript client (standalone SDK, separate from `packages/sdk`).

## Files
- **`client.ts`** — `ArkovaClient` class: `anchor(data)`, `verify(publicId)`, `batchVerify(ids)`, `waitForBatchJob()`. Client-side SHA-256 fingerprinting.
- **`types.ts`** — TypeScript interfaces: `ArkovaConfig`, `AnchorReceipt`, `VerificationResult`, `BatchJob`, `BatchVerificationResult`.
- **`index.ts`** — barrel export.
- **`client.test.ts`** — colocated unit tests.

## Conventions
- Default base URL points to the production Cloud Run worker.
- Auth via `X-API-Key` header.
- Batch verify uses polling (`waitForBatchJob`) with configurable interval and timeout.
