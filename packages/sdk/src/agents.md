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

## PR #2695 — observed timestamp contract

`VerificationResult.anchorTimestamp` is `string | null`, matching the other SDK timestamp models. `verify()` and `verifyBatch()` normalize omitted/null wire values to null; a local fingerprint mismatch also returns null, never an empty substitute. Tests cover both verification entry points, the local rejection path, and the five existing detail/fingerprint readers. SDK source/build repair is distinct from publishing a new npm version; this PR does not publish a package.

The 2026-09-10 SDK suite also exposed stale terminology expectations from migration 0427. Corrected its proof JSDoc to use network/receipt wording and reviewed the additional technical `hash`/`block` references in sibling validation and inclusion-position documentation. The forbidden-term scanner is unchanged.

## PR #2589 — integrate the observed timestamp contract

The current-main merge preserves the nullable observed timestamp from #2695 alongside the rich verification fields. Reviewed terminology counts combine migration0427 technical proof references with the additional documented `merkleProofHash` field; the scanner and strict banned list remain unchanged. The combined SDK suite and build qualify the merged mapping.

## 2026-09-12 — WebhookEventType + its pin gained the attestation events (SCRUM-3982)

`types.ts`: `attestation.created` and `attestation.revoked` appended to the
`WebhookEventType` union. `client.test.ts`: both added to
`WEBHOOK_EVENT_TYPE_PIN`, the exhaustive `Record<WebhookEventType, true>` whose
missing member fails `tsc --noEmit` and whose deleted row fails `vitest run`.

Two traps hit here, both now costly to rediscover:

- **No semicolons in comments inside that union.** The PR-time gate
  `scripts/ci/check-webhook-event-registration-drift.ts` locates it with
  `/export type WebhookEventType\s*=([\s\S]*?);/` — non-greedy to the FIRST
  `;`. A semicolon in a comment truncates the region, and the gate then reports
  every member after it as "Missing" from this mirror, which reads like a
  forgotten edit rather than a truncated read.
- **`terminology.test.ts` counts banned §1.3 words in this source, comments
  included.** The word "block" in a new comment bumped the ratcheted count and
  reddened the suite. Reword the comment rather than raising the expected count.

`attestation.revoked` is typed and subscribable but its worker producer is
unreachable today, so no delivery of it has occurred — see
`services/worker/src/webhooks/agents.md`.

## 2026-09-14 — SCRUM-5142 folders

`ArkovaClient.folders` mirrors the canonical worker REST surface: list/create/update/bindConnector/delete/moveRecords. Keep bulk moves capped by the server contract and preserve per-row failures.
The folder contract suite must cover omission-safe rename, explicit root reparent, connector binding/clear, deletion, and both bulk identifier modes.
## 2026-09-19 — remaining webhook types mirrored

`WebhookEventType` includes `job.completed` plus the four registered compliance contracts. The exhaustive client-test pin and repository drift gate keep the SDK union aligned with the worker allowlist; this is a source change for the next artifact freeze and does not claim a package release.

## SCRUM-5211 — authenticated redirects fail closed

The private fetch wrapper forces `redirect: 'error'` after caller options are
spread. This protects every SDK method, including `getAnchor()` and `verify()`,
and prevents a caller override. Keep redirect policy in the shared transport;
applying it only in `request()` leaves typed methods able to forward
`X-API-Key` when Fetch follows a cross-origin redirect. SDK unit tests and the
API CLI's two-origin integration suite cover direct and `probe`
health/read/verify/folder paths.
## 2026-09-19 — UAT-12 receipt/status parity

`AnchorReceipt` maps wire `credit_state` and `idempotent`; `getAnchorSubmissionStatus(publicId)` maps the bounded durable status response. Preserve every enum value and camelCase mapping when the worker contract changes.
The client validates both lifecycle and instant status enums at the JSON boundary before returning
the typed result; unknown persisted values fail closed as `ArkovaError(502, invalid_response)` rather
than being asserted into the public union or rendered as a known state.
