# agents.md — services/worker/src/chain/

_Last updated: 2026-07-06_

## What This Folder Contains

Bitcoin chain client implementation for anchoring document fingerprints on-chain via OP_RETURN transactions.

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

- **2026-07-06 S3-P0 #1417-HIGH — no-double-broadcast: typed reject gate + infallible broadcast + tri-state getReceipt (Lane 1 /debug):**
  - **`utxo-provider.ts`**: new typed **`BroadcastRejectedError`** (definitive mempool/relay refusal) + **`isBroadcastRejectedError(err)`** — the SINGLE unwind gate. TRUE only for `BroadcastRejectedError`, `RpcApplicationError` (the #1408 rpcCall fix surfaces `sendrawtransaction` JSON-RPC errors typed), or an explicit reject-text (`isBroadcastRejectText`, a conservative Bitcoin-Core reject-token set — over-broad tokens excluded so a transport/proxy message never over-unwinds). Every `HttpError` (401/402/404/5xx), timeout, and unknown error → FALSE → DEFER. `MempoolUtxoProvider.broadcastTx` now throws the typed reject on explicit relay-verdict text (bare non-OK stays `HttpError` → DEFER). `BroadcastRejectedError` is also non-retryable in `isRetryableError`.
  - **`signet.ts`**: (b) `broadcastSignedTx` is now **infallible after `broadcastTx` succeeds** — the post-broadcast `getBlockchainInfo` height read is wrapped in try/catch → falls back to height 0 (a live broadcast is never misread as failed). (c) `getReceipt` is now **TRI-STATE**: found / definitively-absent (RPC code `-5` or mempool HTTP 404 → `null`, via `isDefinitivelyAbsent`) / lookup-failed (outage/auth/quota → **THROW**). A provider outage no longer masquerades as "tx unknown" → rebroadcast → 4xx → unwind.
  - Consumer: `jobs/batch-anchor.ts` both unwind sites (Phase 3c + reconcile rebroadcast) swapped from `!isRetryableError` to `isBroadcastRejectedError`. NO machine transition changed — `bitcoinAnchor.machine.ts` already models "unwind only on a definitive reject"; the fix makes the implementation faithful. `tla-precheck check`: proofPassed, 11 invariants, 757 states / 196 distinct, no error.
  - Tests: `utxo-provider.test.ts` (+reject-text classifier / unwind-gate / typed Mempool reject), `signet.test.ts` (+infallible broadcast on 402/timeout, +getReceipt tri-state: -5/404 → null, 402/401/5xx/unknown → throw), `jobs/batch-anchor.intent.test.ts` (+402 after broadcast → no unwind, +401 during reconcile rebroadcast → DEFER, +genuine dust reject → unwind fires). Reconciled with a concurrent parallel fix (257352c2) — kept the typed gate + tri-state; dropped its batch-local substring helper.

- **2026-07-06 S3-P0 — prepare/broadcast split for persisted pre-broadcast intents (Lane 1, Sprint 3; stacked on S3-C2):**
  - **`types.ts`**: new `PreparedChainTx` ({txHex, txId, feeSats, opReturnData, metadataHash?}) + OPTIONAL `ChainClient.prepareFingerprintTx()` / `broadcastSignedTx()` (optional so existing ChainClient mocks don't break; clients without them get the legacy single-call path).
  - **`signet.ts`**: `submitFingerprint` refactored into `prepareFingerprintTx` (the EXACT pre-broadcast pipeline it always ran — metadata hash → fee estimate + PERF-7 ceiling → UTXO fetch → single/multi selection → PSBT build + sign — stopping before the network) + `broadcastSignedTx` (broadcast previously-signed bytes; computes the txid from the hex; empty provider txid → computed fallback, i.e. already-known == success). `submitFingerprint` is now EXACTLY prepare→broadcast composed — pinned by a test asserting broadcast bytes == prepared bytes. `PreparedChainTx.opReturnData` carries the verbatim committed payload (`"ARKV"(4)+root(32)[+metadataHash]`, NO version byte) for `anchor_proofs.op_return_payload` persistence. RFC6979 deterministic signing ⇒ same UTXO set → identical bytes/txid (pinned).
  - **`mock.ts`**: `MockChainClient` implements both (deterministic txid per fingerprint, idempotent re-broadcast of the same hex) so USE_MOCKS soak rigs exercise the intent pipeline with real-client semantics.
  - Consumer: `jobs/batch-anchor.ts` persists {txid + signed hex} durably BEFORE broadcasting and reconciles interrupted batches on the next tick (see jobs/agents.md). Lifecycle modeled first in `machines/bitcoinAnchor.machine.ts` (check green).

- **2026-07-06 S3-C2 — chain-resilience hardening (Lane 1, Sprint 3; lands BEFORE the batch-anchoring producer so it inherits hardened retry/backoff):**
  - **`retryWithBackoff` bounded termination (no-infinite-loop guarantee):** `maxRetries` is now sanitized — floored to an integer and clamped to `[0, HARD_MAX_RETRIES=8]`; `NaN` falls back to the default (3). Previously `maxRetries: Infinity` looped forever and `NaN`/negative values threw `undefined` without ever calling the fn. `baseDelayMs` is sanitized (non-finite / non-positive → default 1000ms) and each per-attempt delay is capped at `MAX_BACKOFF_DELAY_MS=30_000` PRE-jitter (jitter ∈ [50%,100%) only ever shortens it). Both constants are exported. EVERY retry path now provably reaches a terminal state (success or throw) in ≤ 1+8 attempts.
  - **HTTP 429 reclassified as transient** in `isRetryableError` (rate limit → bounded backoff-with-jitter retry). Other 4xx remain non-retryable. The QA-CHAOS-02 pin in `src/tests/chaos-mempool-unavail.test.ts` was updated to the new contract.
  - **Provider-failure semantics on confirmation-proof fetch (`confirmation-proof.ts`):** a TRANSIENT GetBlock read failure (network / 5xx / timeout / 429, i.e. `isRetryableError`-class, after the provider's own bounded retries are exhausted) on the header/inclusion-proof fetch now degrades to **`pending`** (retry next cron tick) instead of `stale` — a network blip is NOT evidence of a reorg, and no proof field is ever fabricated (no header-only or mempool-derived pseudo-proof; mempool.space still deliberately lacks `getTxOutProof`). Definitive RPC application errors (e.g. `gettxoutproof`: "Not all transactions found in specified or retrieved block") remain `stale` — the provider answered and the answer was negative, preserving the pinned-blockhash reorg signal that `jobs/confirmation-proof-populate.ts` documents. `getRawTransaction` failure was already `pending` (unchanged). Downstream consumer unchanged: both `pending` and `stale` leave `block_header IS NULL` so the row re-matches the next scan; the change corrects status/log/count semantics (no false "reorg/missing" warns on provider blips).
  - **Broadcast idempotency regressions:** "already-known == success" (`isDuplicateTxError` → `{ txid: '' }`, caller falls back to the locally-computed txid) was already implemented on all three provider paths; explicit regression tests now cover EACH path (`RpcUtxoProvider` / `MempoolUtxoProvider` / `GetBlockHybridProvider`), including the canonical duplicate-on-RETRY case (first broadcast landed, response lost), every known already-known error variant, HTTP-5xx-carrying-duplicate-text, non-duplicate errors NOT retried, and bounded exhaustion on persistent 5xx.
  - Tests: `utxo-provider.test.ts` +26 (bounded termination / delay caps / 429 / per-provider idempotency / proof-method retry), `confirmation-proof.test.ts` +9 (transient→pending incl. failure-then-recovery round-trip with a verified branch, definitive-error→stale, mempool-shaped-provider honest-pending). NO lifecycle (`machines/bitcoinAnchor.machine.ts`), NO OP_RETURN payload, NO provider-selection changes.

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
