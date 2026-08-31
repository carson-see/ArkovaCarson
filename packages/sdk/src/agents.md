# packages/sdk/src/agents.md

Source code for `@carsonarkova/sdk` (PH1-SDK-01 + INT-01).

## Files
- **`client.ts`** — `Arkova` class: anchor, verify, batch verify, query (Nessie), webhook management, search, org/record/fingerprint detail. Works in Node.js and browser.
- **`types.ts`** — TypeScript interfaces: `ArkovaConfig`, `AnchorReceipt`, `VerificationResult`, `SearchResponse`, `WebhookEndpoint`, `ProblemDetail`, etc.
- **`index.ts`** — barrel export.
- **`client.test.ts`** — colocated unit tests for the client.

## Conventions
- All methods accept an optional `RetryConfig` for automatic retry on transient failures.
- API key auth via `X-API-Key` header.
- `ProblemDetail` follows RFC 7807.

## PROOF-05 (SCRUM-2338)
- `client.getMerkleProof(publicId)` → `MerkleProofResponse` (calls `GET /api/v1/verify/:publicId/proof`). Maps wire snake_case → camelCase.
- New types in `types.ts`: `MerkleProofResponse`, `MerkleProofEntry`, `ProofBundle`, `ProofBundleSignature`. `proofBundle` is additive + nullable (frozen schema, Constitution §1.8) — `null` when the proof is incomplete.
- `ProofBundle.leafCount` (added in Carson-P1 rework): total leaves in the batch tree; with `merkleIndex` arms the CVE-2012-2459 guard. Always present in a complete bundle. Canonical `opReturnPayload` = `ARKV`(41524b56)+32-byte root hex, NO version byte. `signature` is RESERVED/always-null on the unsigned path (signed envelope is the outer `?format=signed` wrapper).
- Bundle is non-null ONLY when ALL hold: tx_id/block_height/block_timestamp present, block_header = exactly 160 hex, block_hash = exactly 64 hex, canonical ARKV op_return, merkle_index + leaf_count present.

## 2026-08-31 — B3: `mapProofBundle` no longer drops the bitcoin-tree half

`mapProofBundle` builds from a HARD key allow-list, so a field the API emits but
the mapper does not name is silently dropped. Migration 0427's
`tx_inclusion_branch` / `tx_block_index` — the evidence that lets a holder close
the transaction->block half of the proof LOCALLY instead of asking a Bitcoin node
— were emitted by `/proof` and discarded by every SDK consumer.

- `ProofBundle` gains `txInclusionBranch` / `txBlockIndex`, and
  `mapTxInclusionEvidence` maps them as ONE fact under the SAME rules the API
  applies on read: both halves present or neither, every sibling exactly 64 hex,
  `0 <= index < 2^length`, and each level's sibling side matching that level's
  index bit.
- **Deliberately NOT part of the fail-closed required set.** The bundle's required
  members fail the WHOLE bundle to null when malformed; these do not. They are
  additive and nullable (§1.8), so a record confirmed before 0427 must keep
  getting a bundle — gating on them would be a breaking change wearing an
  addition's clothes. An unusable pair degrades to null on both halves and leaves
  the rest of the bundle intact.
- No `proofSchemaVersion` bump: `packages/verifier-cli/src/verify.ts` fails closed
  on anything but 1.
