# agents.md — services/worker/src/chain/

_Last updated: 2026-03-12_

## What This Folder Contains

Bitcoin chain client implementation for anchoring document fingerprints on-chain via OP_RETURN transactions.

| File | Purpose |
|------|---------|
| `types.ts` | `ChainClient` interface + `ChainIndexLookup` interface + `IndexEntry` + request/response types |
| `client.ts` | Async factory (`initChainClient()` / `getInitializedChainClient()`) — returns `MockChainClient` or `BitcoinChainClient` based on config. Includes `SupabaseChainIndexLookup` for O(1) fingerprint verification. |
| `mock.ts` | In-memory mock for tests and development |
| `signet.ts` | Real Bitcoin implementation — `BitcoinChainClient` (renamed from `SignetChainClient`, alias kept). Supports signet, testnet, mainnet via `SigningProvider` + `FeeEstimator` + `UtxoProvider` abstractions. |
| `signing-provider.ts` | Signing abstraction — `WifSigningProvider` (ECPair, signet/testnet) + `KmsSigningProvider` (AWS KMS, mainnet) |
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
- No MVP launch gap stories directly target this folder. CRIT-2 operational items remain: AWS KMS key provisioning (mainnet), mainnet treasury funding.

## Dependencies

- `bitcoinjs-lib`, `tiny-secp256k1`, `ecpair` — Bitcoin transaction construction + signing
- `@aws-sdk/client-kms` — AWS KMS signing (mainnet)
- `../config.js` — environment config (WIF, KMS key, RPC URL, fee strategy, feature flags)
- `../utils/logger.js` — structured logging (pino)
- `../utils/db.js` — Supabase service_role client (for `SupabaseChainIndexLookup`)
