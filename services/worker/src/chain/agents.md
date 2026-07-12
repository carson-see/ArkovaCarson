# agents.md — services/worker/src/chain/

_Last updated: 2026-04-26_

## What This Folder Contains

Bitcoin chain client implementation for anchoring document fingerprints on-chain via OP_RETURN transactions.

## 2026-07-07 — Lane 1 s3.25: frozen fingerprint→on-chain mapping regression pin (SCRUM-2486 AC-3)

`fingerprint-mapping-regression.test.ts` PINS the fingerprint → OP_RETURN payload → verify-extract round-trip with HARD-CODED expected bytes (a frozen fixture computed out-of-band, NOT recomputed from the code under test) so any future refactor that changes the mapping fails loudly. This mapping is a FROZEN WIRE CONTRACT — ~2.97M anchors are already committed under it. The test IMPORTS the real exported pure functions from `signet.ts` (`canonicalMetadataJson`, `hashMetadata`, `truncateMetadataHash`, `extractAnchorFingerprint`) — it does NOT modify the soak-locked `signet.ts`. Pinned: the `ARKV` prefix + byte layout (36B no-meta / 44B with-8B-meta), the compiled OP_RETURN scriptPubKey hex, the canonical-JSON key-sort, the sha256 metadata hash + its 8-byte truncation, and the extract round-trip (including that a trailing metadata hash doesn't disturb fingerprint extraction). A DRIFT-GUARD case confirms a changed prefix would NOT match the pin. Fixture provenance: `fingerprint = sha256("arkova-scrum-2486-frozen-fixture-v1")`. If the wire format is ever INTENTIONALLY versioned, recompute + bump the frozen constants with a migration/re-anchor plan — do NOT edit them to make a red test green. Apply/soak deferred to Sprint-4; pure unit test (T0/T1). Companion ACs AC-2/AC-4 live in `src/jobs/` (see that folder's agents.md).

| File | Purpose |
|------|---------|
| `types.ts` | `ChainClient` interface + `ChainIndexLookup` interface + `IndexEntry` + request/response types |
| `client.ts` | Async factory (`initChainClient()` / `getInitializedChainClient()`) — returns `MockChainClient` or `BitcoinChainClient` based on config. Includes `SupabaseChainIndexLookup` for O(1) fingerprint verification. |
| `mock.ts` | In-memory mock for tests and development |
| `signet.ts` | Real Bitcoin implementation — `BitcoinChainClient` (renamed from `SignetChainClient`, alias kept). Supports signet, testnet, mainnet via `SigningProvider` + `FeeEstimator` + `UtxoProvider` abstractions. |
| `signing-provider.ts` | Signing abstraction — `WifSigningProvider` (ECPair, signet/testnet), `KmsSigningProvider` (AWS KMS, code-level only, NOT in production), `GcpKmsSigningProvider` (**production mainnet**). See `gcp-kms-signing-provider.ts` + SCRUM-902. |
| `fee-estimator.ts` | Fee estimation — `StaticFeeEstimator` (fixed rate) + `MempoolFeeEstimator` (live API) |
| `utxo-provider.ts` | UTXO provider abstraction — `RpcUtxoProvider` (Bitcoin Core RPC) + `MempoolUtxoProvider` (Mempool.space REST) + factory |
| `wallet.ts` | Treasury wallet utilities — keypair generation, address derivation, WIF validation |
| `client.test.ts` | Factory tests (28 tests) — async factory, SupabaseChainIndexLookup, signet/mainnet/mock paths |
| `mock.test.ts` | Mock client tests (18 tests) |
| `signet.test.ts` | Bitcoin client tests (47 tests) — uses dynamically-built funding txs for PSBT validation |
| `utxo-provider.test.ts` | UTXO provider tests (34 tests) |
| `wallet.test.ts` | Wallet utility tests (13 tests) |
| `signet.integration.test.ts` | Integration tests (8 tests) — real TX construction + signing with bitcoinjs-lib, broadcast skipped in CI |

## Recent Changes

- **2026-06-22 PROOF-03 (SCRUM-2336) — confirmation-proof fetch (Lane 1, stacked on Train D proof-foundation):** new `confirmation-proof.ts` adds `fetchConfirmationProof(provider, { chainTxId, blockHeight?, expectedBlockHash?, minConfirmations? })` → a deterministic, serializable `ConfirmationProof` carrying the layer-2 **bitcoin-tree** evidence: the raw 80-byte `blockHeader`, `blockHash`, `blockMerkleRoot`, and the inclusion `merkleBranch` (tx → block merkleroot) + `txIndex`. Status is `confirmed | pending | stale` — a not-yet-confirmed tx returns `pending` with **NO** fabricated branch (§1.5); a reorg/missing tx returns `stale` and never crashes. SOURCE = GetBlock RPC (DISC-03): `getblockheader <hash> false` + `gettxoutproof [txid] <blockhash>`. `parseTxOutProof()` is a self-contained `CMerkleBlock` parser (header + partial-merkle-tree walk, the standard `TraverseAndExtract`) that recomputes the root and **verifies the matched leaf equals the target txid** (gettxoutproof commits to the tx via flag bits, not by carrying the txid — without this check a proof for a different tx in the same block would be accepted). OP_RETURN format is OUT OF SCOPE (verifier's concern, S2) — this fetch is format-agnostic.
  - **`utxo-provider.ts`**: `UtxoProvider` gains OPTIONAL `getBlockHeaderHex(blockhash)` + `getTxOutProof(txids, blockhash?)` (optional so existing `UtxoProvider` mocks don't break). New `ConfirmationProofProvider` narrow slice (just `getRawTransaction` + the two optional methods). Implemented on `RpcUtxoProvider` + `GetBlockHybridProvider` (route through the GetBlock RPC node — sovereign, same node as broadcast). `MempoolUtxoProvider` implements `getBlockHeaderHex` (via `/block/:hash/header`) but DELIBERATELY does NOT implement `getTxOutProof` (mempool.space has no CMerkleBlock-format endpoint), so a mempool-only deployment reports `pending` rather than fabricating an unverifiable branch.
  - Tests: `confirmation-proof.test.ts` (22) builds real `gettxoutproof` blobs in-process from a faithful `CMerkleBlock` serializer (NO real Bitcoin API, §1.7) and round-trips parse→recompute→merkleroot for 1/5/8-tx blocks at every match index, plus confirmed/pending/reorg/missing/malformed, AND the CVE-2012-2459 degenerate `left==right` reject (PR #1320). `utxo-provider.test.ts` +6 for the new RPC methods.
  - **MED-1 (CVE-2012-2459, PR #1320):** the duplicate-node reject is now ACTUALLY implemented in `walkMerkleTree` + `extractBranchForIndex` (was only claimed in a comment). For a GENUINE right child (per `calcWidthAtHeight`), `left.equals(right)` ⇒ malformed tree (return null / propagate failure), mirroring Bitcoin Core's `fBad`. Odd-row legitimate `right = left` duplicates are unaffected (they take the `else` branch, no compare).
  - **LOW-1 (residual, NOT fixed — document only):** a DEEP reorg that occurs AFTER a `confirmed` proof is populated leaves a STALE `block_header`/`block_hash` on the `anchor_proofs` row with **no re-validation path** — nothing re-fetches a header once `block_header IS NOT NULL` (the populated header is the scan watermark, so the row stops matching). On mainnet the backfill's `minConfirmations=6` makes a reorg past a populated proof unlikely (a 6-block reorg is rare), so this is accepted residual risk for now. Follow-up: on reorg detection (`jobs/chain-maintenance.ts::detectReorgs`), null out `block_header`/`block_hash` for affected anchors so the backfill re-populates under the new block.

- **2026-04-26 SCRUM-1262 R1-8 /simplify carry-over:** `GetBlockHybridProvider.listUnspent()` RPC-fallback Sentry breadcrumb + structured warn log pair extracted to `emitRpcFallback()` in `services/worker/src/utils/sentry.ts`. Future RPC-fallback sites (`getrawtransaction` / `getblockheader` / fee estimation) can now reuse the same locked field shape (`chain_rpc_fallback`, `method`, `provider`, `reason`) so Cloud Logging + Arize + db-health dashboards see one canonical event signature.

- **Session 38 (2026-04-09):** Added `estimateCurrentFee()` to `ChainClient` interface (`types.ts`) and `BitcoinChainClient` (`signet.ts`). Exposes fee estimator for pre-claim fee checks in batch anchor scaling (SCALE-4).

- **Integration tests:** Added `signet.integration.test.ts` — 8 tests constructing and signing real Bitcoin Signet transactions end-to-end (keypair generation → funding tx → OP_RETURN anchor → sign → validate). Covers: valid tx from generated keypair, known test WIF, large UTXO values, dust change handling, invalid fingerprint rejection, different fingerprints → different txIds, scriptSig DER+pubkey validation, broadcast skip documentation. Total: 416 worker tests across 18 files.

- **CRIT-2 Step 5-8:** Added `signing-provider.ts` (WIF + KMS), `fee-estimator.ts` (static + mempool), chain index lookup (`SupabaseChainIndexLookup` in `client.ts`). Refactored `signet.ts` → `BitcoinChainClient` with provider abstractions. Rewrote `client.ts` to async factory pattern (`initChainClient()` / `getInitializedChainClient()`). Supports signet (WIF), testnet (WIF), mainnet (KMS). Migration 0050 creates `anchor_chain_index` table. Config expanded with 5 new env vars.
- Broadcast test coverage: Added 3 broadcast-specific tests to `signet.test.ts` (txid mismatch handling, empty txid fallback, raw hex format verification) and 3 to `utxo-provider.test.ts` (Mempool POST format, whitespace trimming, HTTP status in errors).
- P7-TS-12: Added `utxo-provider.ts` — `UtxoProvider` interface, `RpcUtxoProvider`, `MempoolUtxoProvider`, factory.
- P7-TS-11: Added `wallet.ts` — `generateSignetKeypair()`, `addressFromWif()`, `isValidSignetWif()`.

## Do / Don't Rules

- **DO** use `getInitializedChainClient()` in hot paths (e.g., `processAnchor`) — NOT the old `getChainClient()`
- **DO** call `initChainClient()` once at startup (in `index.ts` listen callback)
- **DO** use `UtxoProvider` interface for all UTXO operations (never raw `fetch` in signet.ts)
- **DO** use `MockChainClient` in all test suites outside this folder
- **DO NOT** log the treasury WIF or KMS key ID (Constitution 1.4)
- **DO NOT** import `generateFingerprint` (Constitution 1.6 — client-side only)
- **DO NOT** call real Bitcoin APIs in tests — mock `UtxoProvider` methods
- **DO NOT** set `anchor.status = 'SECURED'` from client code — worker-only via service_role
- **DO NOT** use string `'mainnet'` for network config — use `bitcoin.networks.bitcoin` from `bitcoinjs-lib`
- Test funding txs: use `buildDummyFundingTx()` pattern — static hex strings fail PSBT validation

## MVP Launch Gap Context
- No MVP launch gap stories directly target this folder. Mainnet treasury funding is complete; GCP Cloud KMS is the production signing provider. The AWS KMS provider remains in the codebase as future optionality only — NOT deployed (SCRUM-902).

## Dependencies

- `bitcoinjs-lib`, `tiny-secp256k1`, `ecpair` — Bitcoin transaction construction + signing
- `@google-cloud/kms` — GCP Cloud KMS signing (production mainnet)
- `@aws-sdk/client-kms` — AWS KMS signing (code-level abstraction only; NOT in production, see SCRUM-902)
- `../config.js` — environment config (WIF, KMS key, RPC URL, fee strategy, feature flags)
- `../utils/logger.js` — structured logging (pino)
- `../utils/db.js` — Supabase service_role client (for `SupabaseChainIndexLookup`)
