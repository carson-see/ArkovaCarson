# Anchoring Worker
_Last updated: 2026-03-12 | Story: P7-TS-05, P7-TS-10, P7-TS-11, P7-TS-12, P7-TS-13, CRIT-2_

## Overview

The anchoring worker is a dedicated Node.js + Express service that handles all backend processing for Arkova. Per the Constitution, this is the **only** backend runtime — no frontend framework API routes (Arkova uses Vite for the frontend, which has no server-side API layer).

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   React App     │────▶│  Supabase Edge  │────▶│  Worker Service │
│   (Vite)        │     │   (Auth/DB)     │     │  (Node+Express) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │  Chain APIs     │
                                               │  (Bitcoin)      │
                                               └─────────────────┘
```

## Directory Structure (Actual)

```
services/
└── worker/
    ├── src/
    │   ├── index.ts              # Express server + cron + graceful shutdown
    │   ├── config.ts             # Environment config
    │   ├── jobs/
    │   │   ├── anchor.ts         # Process pending anchors + dispatch webhooks
    │   │   ├── report.ts         # Report generation job
    │   │   └── webhook.ts        # Webhook delivery job (legacy stub)
    │   ├── chain/
    │   │   ├── client.ts          # Async factory (initChainClient/getInitializedChainClient) + SupabaseChainIndexLookup
    │   │   ├── signet.ts          # BitcoinChainClient (supports signet/testnet/mainnet via provider abstractions)
    │   │   ├── mock.ts            # Mock implementation
    │   │   ├── signing-provider.ts # WifSigningProvider (ECPair) + KmsSigningProvider (AWS KMS)
    │   │   ├── fee-estimator.ts   # StaticFeeEstimator + MempoolFeeEstimator
    │   │   ├── wallet.ts          # Wallet utilities (keypair gen, address derivation, WIF validation)
    │   │   ├── utxo-provider.ts   # UTXO provider (RpcUtxoProvider, MempoolUtxoProvider, factory)
    │   │   └── types.ts           # ChainClient + ChainIndexLookup + IndexEntry interfaces
    │   ├── stripe/
    │   │   ├── client.ts         # Stripe SDK + webhook signature verification
    │   │   ├── handlers.ts       # Webhook event handlers
    │   │   └── mock.ts           # Mock Stripe for tests
    │   ├── webhooks/
    │   │   └── delivery.ts       # Outbound webhook delivery engine
    │   ├── types/                # Shared type definitions
    │   └── utils/
    │       ├── correlationId.ts  # Request correlation tracking
    │       ├── db.ts             # Supabase service_role client
    │       ├── logger.ts         # Structured logging
    │       └── rateLimit.ts      # Rate limiter
    ├── package.json
    └── tsconfig.json
```

## Responsibilities

### 1. Anchor Processing

Process PENDING anchors, submit to chain, log audit events, and dispatch webhooks (`jobs/anchor.ts`):

```typescript
async function processAnchor(anchorId: string): Promise<boolean> {
  const anchor = await db.from('anchors')
    .select('*').eq('id', anchorId).eq('status', 'PENDING').single();

  if (!anchor.data) return false;

  // Submit fingerprint to chain (uses initialized singleton)
  const chainClient = getInitializedChainClient();
  const receipt = await chainClient.submitFingerprint({
    fingerprint: anchor.data.fingerprint,
    timestamp: new Date().toISOString(),
  });

  // Update anchor with chain data (service_role only — Constitution 1.4)
  await db.from('anchors').update({
    status: 'SECURED',
    chain_tx_id: receipt.receiptId,
    chain_block_height: receipt.blockHeight,
    chain_timestamp: receipt.blockTimestamp,
  }).eq('id', anchorId);

  // Upsert chain index entry — O(1) verification lookup (P7-TS-13, non-fatal)
  await (db as any).from('anchor_chain_index').upsert({
    fingerprint_sha256: anchor.data.fingerprint,
    chain_tx_id: receipt.receiptId,
    chain_block_height: receipt.blockHeight,
    chain_block_timestamp: receipt.blockTimestamp,
    confirmations: receipt.confirmations,
    anchor_id: anchorId,
  }, { onConflict: 'fingerprint_sha256,chain_tx_id' });

  // Log audit event (non-fatal)
  await db.from('audit_events').insert({ /* ... */ });

  // Dispatch webhook (non-fatal, skipped if no org_id)
  if (anchor.data.org_id) {
    await dispatchWebhookEvent(anchor.data.org_id, 'anchor.secured', anchorId, { /* ... */ });
  }
  return true;
}
```

Webhook dispatch is non-fatal — if it fails, the anchor remains SECURED and a warning is logged. Individual users without `org_id` skip webhook dispatch entirely.

### 2. Webhook Processing

- **Inbound:** Stripe webhook handlers (`stripe/handlers.ts`)
- **Outbound:** Delivery engine (`webhooks/delivery.ts`) with exponential backoff and HMAC-SHA256 signing

See [09_webhooks.md](./09_webhooks.md) for details.

### 3. Report Generation

Report processing job (`jobs/report.ts`) generates reports requested via the `reports` table (migration 0019). Output stored as `report_artifacts`.

### 4. Scheduled Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `processPendingAnchors` | Every minute | Process PENDING anchors → chain → SECURED → audit → webhook |
| `processWebhookRetries` | Every 2 minutes | Retry failed webhook deliveries with exponential backoff |
| `resetMonthlyCounts` | 1st of month | Reset anchor quotas |

## Configuration

### Environment Variables

```bash
# Database
SUPABASE_SERVICE_ROLE_KEY=...     # Worker-only, never in browser

# Chain — BitcoinChainClient (CRIT-2 COMPLETE)
BITCOIN_TREASURY_WIF=...          # Signing key (signet/testnet) — never logged
BITCOIN_NETWORK=signet            # "signet", "testnet", or "mainnet"
BITCOIN_RPC_URL=...               # Optional — RPC endpoint (for RpcUtxoProvider)
BITCOIN_RPC_AUTH=...              # Optional — RPC auth credentials
BITCOIN_KMS_KEY_ID=...            # AWS KMS key ID (mainnet only)
BITCOIN_KMS_REGION=us-east-1      # AWS KMS region (mainnet only)
BITCOIN_FEE_STRATEGY=static       # "static" or "mempool" (live fee estimation)
BITCOIN_STATIC_FEE_RATE=2         # sats/vB for static strategy (default: 2)
BITCOIN_FALLBACK_FEE_RATE=5       # sats/vB fallback if mempool API fails
MEMPOOL_API_URL=...               # Optional — Mempool.space API base URL

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Worker
WORKER_PORT=3001
NODE_ENV=development
```

### Network Configuration

Per Constitution, use approved terminology in UI:

| Internal | UI Display |
|----------|------------|
| `testnet` | Test Environment |
| `mainnet` | Production Network |

## Chain Integration

### Current State (CRIT-2 — CODE COMPLETE)

The chain client uses an **async factory pattern** with provider abstractions that support signet, testnet, and mainnet from a single `BitcoinChainClient` implementation.

**Factory:** `initChainClient()` initializes the singleton at startup (async — KMS needs network call). `getInitializedChainClient()` returns it synchronously in hot paths like `processAnchor()`.

**Paths:**
- `config.useMocks || nodeEnv === 'test'` → `MockChainClient`
- `enableProdNetworkAnchoring + signet/testnet + WIF` → `BitcoinChainClient` with `WifSigningProvider`
- `enableProdNetworkAnchoring + mainnet + KMS key` → `BitcoinChainClient` with `KmsSigningProvider`
- All other cases → `MockChainClient` (safe fallback)

**Architecture:**
```
BitcoinChainClient
  ├── SigningProvider   (WifSigningProvider | KmsSigningProvider)
  ├── FeeEstimator      (StaticFeeEstimator | MempoolFeeEstimator)
  ├── UtxoProvider      (RpcUtxoProvider | MempoolUtxoProvider)
  └── ChainIndexLookup  (SupabaseChainIndexLookup — O(1) verification)
```

**Key implementation details:**
- OP_RETURN anchoring: 4-byte `ARKV` prefix + 32-byte SHA-256 fingerprint via `bitcoinjs-lib` PSBT
- `SupabaseChainIndexLookup` queries `anchor_chain_index` table (migration 0050) for O(1) `verifyFingerprint()`
- Chain index populated via non-fatal upsert in `processAnchor()` after SECURED status set
- Mainnet uses `bitcoin.networks.bitcoin` (not string `'mainnet'`)
- `(db as any)` cast for `anchor_chain_index` queries until `database.types.ts` regenerated with migration 0050

**Completed (all code):**
1. ~~`bitcoinjs-lib`~~ — `bitcoinjs-lib ^6.1.7`, `ecpair ^3.0.1`, `tiny-secp256k1 ^2.2.4`
2. ~~`BitcoinChainClient`~~ — `chain/signet.ts` (renamed from `SignetChainClient`, alias kept)
3. ~~Signing providers~~ — `chain/signing-provider.ts` (`WifSigningProvider` + `KmsSigningProvider`)
4. ~~Fee estimators~~ — `chain/fee-estimator.ts` (`StaticFeeEstimator` + `MempoolFeeEstimator`)
5. ~~UTXO providers~~ — `chain/utxo-provider.ts` (`RpcUtxoProvider` + `MempoolUtxoProvider` + factory)
6. ~~Wallet utilities~~ — `chain/wallet.ts` + CLI scripts
7. ~~Async factory~~ — `chain/client.ts` (`initChainClient()` / `getInitializedChainClient()`)
8. ~~Chain index~~ — `SupabaseChainIndexLookup` in `client.ts` + migration 0050 (`anchor_chain_index` table)
9. ~~Signet treasury funded~~ — 500,636 sats at `mx1zmGtQTghi4GWcJaV1oPwJ5TKhGfFpjs`

**Operational remaining (not code):**
1. Signet E2E connectivity test — awaiting UTXO confirmation for first broadcast
2. AWS KMS key provisioning in AWS console
3. Mainnet treasury funding

### Wallet Setup Procedure

```bash
# 1. Generate a new Signet keypair
cd services/worker
npx tsx scripts/generate-signet-keypair.ts
# → Outputs WIF (private key) and P2PKH address (m/n prefix)
# → NEVER commit or log the WIF (Constitution 1.4)

# 2. Store WIF in .env (gitignored)
echo "BITCOIN_TREASURY_WIF=<wif-from-step-1>" >> .env
echo "BITCOIN_NETWORK=signet" >> .env
echo "BITCOIN_RPC_URL=http://<signet-node>:38332" >> .env

# 3. Fund via Signet faucet
# Visit https://signetfaucet.com or https://alt.signetfaucet.com
# Paste the P2PKH address from step 1

# 4. Verify funding
npx tsx scripts/check-signet-balance.ts
# → Shows chain info, UTXOs, balance, estimated anchoring capacity

# 5. Document the address (NOT the WIF) in MEMORY.md
```

### Non-Custodial Model

The worker only submits fingerprints. It does NOT hold private keys for user wallets, process user cryptocurrency, or accept deposits.

All network fees are paid from a **corporate fee account**.

### Chain Client Interface

```typescript
interface ChainClient {
  submitFingerprint(data: SubmitFingerprintRequest): Promise<ChainReceipt>;
  verifyFingerprint(fingerprint: string): Promise<VerificationResult>;
  getReceipt(receiptId: string): Promise<ChainReceipt | null>;
  healthCheck(): Promise<boolean>;
}

interface SubmitFingerprintRequest {
  fingerprint: string;
  timestamp: string;
  metadata?: Record<string, string>;
}

interface ChainReceipt {
  receiptId: string;       // Network receipt ID (OP_RETURN tx hash)
  blockHeight: number;
  blockTimestamp: string;   // ISO 8601
  confirmations: number;
}

interface ChainIndexLookup {
  lookupFingerprint(fingerprint: string): Promise<IndexEntry | null>;
}

interface IndexEntry {
  chainTxId: string;
  blockHeight: number | null;
  blockTimestamp: string | null;
  confirmations: number | null;
  anchorId: string | null;
}
```

## Health Check

```typescript
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: process.env.npm_package_version,
    uptime: process.uptime(),
  });
});
```

Available regardless of feature flag state (Constitution 1.9).

## Current Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Express server + cron | Complete | `index.ts` with graceful shutdown |
| Anchor processing jobs | Complete | `anchor.ts` — full lifecycle including webhook dispatch |
| Chain client interface | Complete | BitcoinChainClient + MockChainClient (CRIT-2 CODE COMPLETE — all provider abstractions implemented) |
| Wallet utilities | Complete | P7-TS-11: keypair gen, address derivation, WIF validation, CLI scripts |
| UTXO provider | Complete | P7-TS-12: RpcUtxoProvider + MempoolUtxoProvider, factory, integrated into BitcoinChainClient |
| Stripe webhook handlers | Complete | P7-TS-03 |
| Outbound webhook delivery | Complete | Wired to anchor lifecycle (HARDENING-4). Dispatches on SECURED. |
| Webhook retry scheduling | Complete | `processWebhookRetries()` runs every 2 minutes via cron |
| Report generation | Complete | `report.ts` |
| Rate limiter | Complete | `utils/rateLimit.ts` |
| Signing providers | Complete | CRIT-2: WifSigningProvider (ECPair) + KmsSigningProvider (AWS KMS) |
| Fee estimators | Complete | CRIT-2: StaticFeeEstimator + MempoolFeeEstimator |
| Chain index (P7-TS-13) | Complete | SupabaseChainIndexLookup — O(1) verification via `anchor_chain_index` table (migration 0050) |
| Worker test coverage | 408 tests across 17 files, 80%+ on all paths | HARDENING-1/2/3/4/5 + Signet + wallet + UTXO provider + signing + fee + index (2026-03-12) |

## Testing

### Unit Tests

```bash
cd services/worker
npm test
```

**Current coverage (2026-03-12 ~5:00 AM EST):** 416 tests across 18 test files. All worker source files pass 80% per-file thresholds (85.91% statement, 73.98% branch, 87.87% function). Critical path files (`anchor.ts`, `chain/client.ts`, `chain/mock.ts`, `chain/signet.ts`, `chain/signing-provider.ts`, `chain/fee-estimator.ts`, `chain/utxo-provider.ts`, `chain/wallet.ts`, `webhooks/delivery.ts`, `stripe/client.ts`, `stripe/handlers.ts`) at 98-100%. Chain-specific: 200 tests across 9 files (signet 47, signet.integration 8, utxo-provider 34, wallet 13, client 28, mock 18, anchor 46, signing-provider + fee-estimator). Integration tests in `signet.integration.test.ts` construct and sign real Bitcoin Signet transactions (broadcast skipped in CI per Constitution 1.7).

### Mock Mode

Tests use mock interfaces for all external services (Constitution 1.7):

```typescript
const mockChain = {
  submitFingerprint: vi.fn().mockResolvedValue({
    receiptId: 'mock_receipt_001',
    blockHeight: 850000,
    blockTimestamp: '2026-03-12T00:00:00Z',
    confirmations: 6,
  }),
  verifyFingerprint: vi.fn(),
  getReceipt: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(true),
};
```

## Related Documentation

- [08_payments_entitlements.md](./08_payments_entitlements.md) — Payment system
- [09_webhooks.md](./09_webhooks.md) — Webhook implementation
- [06_on_chain_policy.md](./06_on_chain_policy.md) — Content policy

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit | Rewrote: fixed "Next.js" to "Vite" framing, updated directory structure to match actual files (added webhooks/delivery.ts, anchorWithClaim.ts, report.ts, utils/correlationId.ts, utils/rateLimit.ts; removed nonexistent cleanup.ts, Dockerfile), documented implementation status and known gaps |
| 2026-03-10 | HARDENING-1/2/3 | Updated coverage status: 114 tests, 80%+ thresholds on all 6 critical paths. Removed anchorWithClaim.ts reference (deleted as dead code in HARDENING-1). |
| 2026-03-10 5:20 PM EST | HARDENING-4 | Webhook dispatch wired in anchor.ts. processWebhookRetries added to cron. 132 tests. P7-TS-10 COMPLETE. Removed stale anchorWithClaim.ts from directory listing. |
| 2026-03-10 8:00 PM EST | HARDENING-5 | 96 new tests across 7 new test files covering all remaining worker source files (config, index, stripe/mock, jobs/report, jobs/webhook, utils/correlationId, utils/rateLimit). Exported `cleanupExpiredEntries()` from rateLimit.ts for testability. Total: 228 worker tests, 14 test files. 80%+ thresholds on all files. Worker hardening sprint COMPLETE. |
| 2026-03-11 ~11:30 PM EST | P7-TS-11 | Added wallet utilities (wallet.ts), CLI scripts (generate-signet-keypair.ts, check-signet-balance.ts), 13 wallet tests. Updated chain integration section with current state and wallet setup procedure. Updated directory structure with signet.ts and wallet.ts. |
| 2026-03-12 ~1:00 AM EST | P7-TS-12 | Added UTXO provider (utxo-provider.ts: RpcUtxoProvider + MempoolUtxoProvider + factory), 35 tests. Integrated into SignetChainClient + getChainClient(). Updated directory, implementation status, coverage. Fixed signet.test.ts failures (ESM compat + PSBT validation). 363 worker tests total. |
| 2026-03-12 ~2:00 AM EST | Signet E2E | Updated test counts (369 worker tests, 153 chain tests). Signet treasury funded (500,636 sats), awaiting UTXO confirmation for first real OP_RETURN broadcast. |
| 2026-03-12 ~3:00 AM EST | CRIT-2 | CRIT-2 CODE COMPLETE. Added signing-provider.ts (WIF + KMS), fee-estimator.ts (static + mempool), SupabaseChainIndexLookup (P7-TS-13). Refactored signet.ts → BitcoinChainClient with provider abstractions. Rewrote client.ts to async factory (initChainClient/getInitializedChainClient). Migration 0050 (anchor_chain_index table). Updated ChainClient/ChainReceipt interfaces. 408 worker tests. Remaining: operational (Signet E2E broadcast, AWS KMS key provisioning, mainnet treasury funding). |
