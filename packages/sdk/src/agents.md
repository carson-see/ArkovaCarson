# packages/sdk/src/agents.md

Source code for `arkova` (PH1-SDK-01 + INT-01).

## Files
- **`client.ts`** — `Arkova` class: anchor, verify, batch verify, query (Nessie), webhook management, search, org/record/fingerprint detail. Works in Node.js and browser.
- **`types.ts`** — TypeScript interfaces: `ArkovaConfig`, `AnchorReceipt`, `VerificationResult`, `SearchResponse`, `WebhookEndpoint`, `ProblemDetail`, etc.
- **`index.ts`** — barrel export.
- **`client.test.ts`** — colocated unit tests for the client. Includes a doc-accuracy regression (2026-08-18): `GET /api/v1/verify/:publicId` on an unknown ID returns `404 { error: "Record not found" }` (legacy human-readable string), and `jsonOrThrow` carries `error` through verbatim as `ArkovaError.code` — so `code` for that call is the literal string `"Record not found"`, not a normalized `not_found` slug, even though other v1 endpoints (webhooks, jobs, `credentials-ctdl.ts`) do send `not_found`. Confirmed live against production during npm-publish clean-room verification. README's error-code table now carries the same caveat; branch on `statusCode` for reliable dispatch, treat `code` as best-effort.
- **`terminology.test.ts`** (2026-08-18) — CLAUDE.md §1.3 guard over `client.ts`/`types.ts`/`index.ts`, the files that ship into `dist/`. Found live: `types.ts` had "Bitcoin block confirmations" / "Bitcoin transaction ID" / "Bitcoin block height" JSDoc and an x402 "wallet" reference — `tsup --dts` copies JSDoc verbatim into the shipped `.d.ts`/`.d.mts`, so a README-only terminology pass missed all of it. Zero-tolerance for `wallet`/`gas`/`transaction`/`blockchain`/`bitcoin`/`testnet`/`mainnet`/`utxo`/`broadcast`/`cryptocurrency`; `hash`/`block`/`crypto` are ratcheted counts, not zero-tolerance — they have legitimate technical use in the `ProofBundle`/`MerkleProofEntry` Merkle-proof documentation and in the real `crypto.subtle.digest(...)` WebCrypto call. Read the test file's header before changing either list.
- **`package-metadata.test.ts`** (2026-08-18) — asserts `package.json`'s `keywords`/`description` carry no §1.3-banned terms (found: `"bitcoin"` was a keyword, indexed on npmjs.com) and that `repository`/`author` are present (were missing, unlike the sibling `sdks/mcp-server/package.json`).

## Conventions
- All methods accept an optional `RetryConfig` for automatic retry on transient failures.
- API key auth via `X-API-Key` header.
- `ProblemDetail` follows RFC 7807.

## PROOF-05 (SCRUM-2338)
- `client.getMerkleProof(publicId)` → `MerkleProofResponse` (calls `GET /api/v1/verify/:publicId/proof`). Maps wire snake_case → camelCase.
- New types in `types.ts`: `MerkleProofResponse`, `MerkleProofEntry`, `ProofBundle`, `ProofBundleSignature`. `proofBundle` is additive + nullable (frozen schema, Constitution §1.8) — `null` when the proof is incomplete.
- `ProofBundle.leafCount` (added in Carson-P1 rework): total leaves in the batch tree; with `merkleIndex` arms the CVE-2012-2459 guard. Always present in a complete bundle. Canonical `opReturnPayload` = `ARKV`(41524b56)+32-byte root hex, NO version byte. `signature` is RESERVED/always-null on the unsigned path (signed envelope is the outer `?format=signed` wrapper).
- Bundle is non-null ONLY when ALL hold: tx_id/block_height/block_timestamp present, block_header = exactly 160 hex, block_hash = exactly 64 hex, canonical ARKV op_return, merkle_index + leaf_count present.
