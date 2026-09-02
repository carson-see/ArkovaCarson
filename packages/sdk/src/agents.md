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

### Open question (NOT resolved here): `[]` means different things to the two branches

`mapProofBundle` fails the WHOLE bundle closed when `merkleProof.length === 0`
(an empty app-tree branch is treated as unverifiable), while `txInclusionBranch`
treats `[]` as COMPLETE evidence — a single-transaction block genuinely has no
siblings, which is also how the API reader, the writer, `sourceProofInput` and
the verifier CLI read it.

Both readings are defensible and they are inconsistent with each other. The
app-tree behaviour is PRE-EXISTING (it predates migration 0427 and is asserted
by `client.test.ts`), so it was deliberately left alone rather than changed in
passing: flipping it would alter what `proofBundle !== null` guarantees for
single-leaf records, which is an SDK contract decision and wants an explicit
ruling plus its own soak — not a drive-by edit inside a review-fix commit.

If you are here to settle it, the question is: for a SINGLE-LEAF app tree, is
`merkleProof: []` an honest complete branch (root == leaf) or an unverifiable
one? The bitcoin-tree side has already answered the analogous question with
"complete". Whichever way it goes, the two should end up agreeing.
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
