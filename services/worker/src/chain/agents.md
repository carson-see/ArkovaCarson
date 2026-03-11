# agents.md — services/worker/src/chain/
_Last updated: 2026-03-11_

## What This Folder Contains

Bitcoin chain client implementation for anchoring document fingerprints on-chain via OP_RETURN transactions.

| File | Purpose |
|------|---------|
| `types.ts` | `ChainClient` interface (`submitFingerprint`, `verifyFingerprint`, `getReceipt`, `healthCheck`) + request/response types |
| `client.ts` | Factory (`getChainClient()`) — returns `MockChainClient` or `SignetChainClient` based on config/feature flags |
| `mock.ts` | In-memory mock for tests and development |
| `signet.ts` | Real Signet implementation — `bitcoinjs-lib` PSBT construction, OP_RETURN with `ARKV` prefix + SHA-256 hash |
| `utxo-provider.ts` | UTXO provider abstraction — `RpcUtxoProvider` (Bitcoin Core RPC) + `MempoolUtxoProvider` (Mempool.space REST) + factory |
| `wallet.ts` | Treasury wallet utilities — keypair generation, address derivation, WIF validation |
| `client.test.ts` | Factory tests (8 tests) |
| `mock.test.ts` | Mock client tests (14 tests) |
| `signet.test.ts` | Signet client tests (30 tests) — uses dynamically-built funding txs for PSBT validation |
| `utxo-provider.test.ts` | UTXO provider tests (26 tests) |
| `wallet.test.ts` | Wallet utility tests (13 tests) |

## Recent Changes
- P7-TS-12: Added `utxo-provider.ts` — `UtxoProvider` interface, `RpcUtxoProvider`, `MempoolUtxoProvider`, factory. Integrated into `signet.ts` constructor + `client.ts` factory.
- P7-TS-11: Added `wallet.ts` — `generateSignetKeypair()`, `addressFromWif()`, `isValidSignetWif()`.
- Test fixes: `signet.test.ts` uses `buildDummyFundingTx()` to construct valid P2PKH funding txs that satisfy `bitcoinjs-lib` PSBT validation (txid hash match + scriptPubKey match).

## Do / Don't Rules
- **DO** use `UtxoProvider` interface for all UTXO operations (never raw `fetch` in signet.ts)
- **DO** use `MockChainClient` in all test suites outside this folder
- **DO NOT** log the treasury WIF (Constitution 1.4)
- **DO NOT** import `generateFingerprint` (Constitution 1.6 — client-side only)
- **DO NOT** call real Bitcoin APIs in tests — mock `UtxoProvider` methods
- **DO NOT** set `anchor.status = 'SECURED'` from client code — worker-only via service_role
- Test funding txs: use `buildDummyFundingTx()` pattern — static hex strings fail PSBT validation

## Dependencies
- `bitcoinjs-lib`, `tiny-secp256k1`, `ecpair` — Bitcoin transaction construction + signing
- `../config.js` — environment config (WIF, RPC URL, feature flags)
- `../utils/logger.js` — structured logging (pino)
