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

## DI-775 / SCRUM-3538 — `WebhookEventType` mirrors the worker allowlist

`WebhookEventType` in `types.ts` is a hand-maintained mirror of
`PAYLOAD_SCHEMAS_BY_EVENT_TYPE` in `services/worker/src/webhooks/payload-schemas.ts` (the worker's
`VALID_WEBHOOK_EVENTS` is `Object.keys()` of that map). `anchor.superseded` was missing from the
union for months while the worker dispatched it and the CRUD API accepted subscriptions to it, so a
typed SDK consumer could not subscribe to an event Arkova was already sending.

`client.test.ts` now pins the union with an exhaustive `Record<WebhookEventType, true>` plus a
runtime key-set assertion. Know its limits before trusting it: it is a hardcoded list, so it catches
an edit to the union that forgets the pin, **not** a new event registered in the worker; and neither
`npm test` nor `npm run typecheck` here runs on a pull request — `.github/workflows/publish-sdk.yml`
is the only workflow that touches this package and it triggers on an `sdk-v*` tag. The PR-time gate
for the drift class is `scripts/ci/check-webhook-event-registration-drift.ts`, which parses the
worker map and compares this union against it from inside the required root `Tests` job.

When you add a member here, add it in the worker's declaration order — the drift check compares the
code mirrors as ordered arrays.
