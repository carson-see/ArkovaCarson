# Anchoring Worker
_Last updated: 2026-03-12 ~1:00 AM EST | Story: P7-TS-05, P7-TS-10, P7-TS-11, P7-TS-12_

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
    │   │   ├── client.ts         # ChainClient factory (Mock or Signet based on config)
    │   │   ├── signet.ts         # Real Signet implementation (bitcoinjs-lib, OP_RETURN)
    │   │   ├── mock.ts           # Mock implementation
    │   │   ├── wallet.ts         # Wallet utilities (keypair gen, address derivation, WIF validation)
    │   │   ├── utxo-provider.ts  # UTXO provider (RpcUtxoProvider, MempoolUtxoProvider, factory)
    │   │   └── types.ts          # ChainClient interface
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
async function processAnchor(anchorId: string): Promise<void> {
  const anchor = await db.from('anchors')
    .select('*')
    .eq('id', anchorId)
    .eq('status', 'PENDING')
    .single();

  if (!anchor.data) return;

  // Submit fingerprint to chain
  const receipt = await chainClient.submitFingerprint({
    fingerprint: anchor.data.fingerprint,
    timestamp: new Date().toISOString(),
  });

  // Update anchor with chain data (service_role only — Constitution 1.4)
  await db.from('anchors')
    .update({
      status: 'SECURED',
      chain_tx_id: receipt.txId,
      chain_block_height: receipt.blockHeight,
      chain_timestamp: receipt.timestamp,
    })
    .eq('id', anchorId);

  // Log audit event (non-fatal)
  await db.from('audit_events').insert({
    event_type: 'anchor.secured',
    event_category: 'ANCHOR',
    target_type: 'anchor',
    target_id: anchorId,
    details: `Secured on chain: ${receipt.receiptId}`,
  });

  // Dispatch webhook (non-fatal, skipped if no org_id)
  if (anchor.data.org_id) {
    await dispatchWebhookEvent(anchor.data.org_id, 'anchor.secured', anchorId, {
      anchor_id: anchorId,
      public_id: anchor.data.public_id,
      fingerprint: anchor.data.fingerprint,
      status: 'SECURED',
      chain_tx_id: receipt.receiptId,
      chain_block_height: receipt.blockHeight,
      secured_at: receipt.blockTimestamp,
    });
  }
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

# Chain (SignetChainClient implemented — CRIT-2 PARTIAL)
BITCOIN_TREASURY_WIF=...          # Signing key — never logged
BITCOIN_NETWORK=signet            # "signet", "testnet", or "mainnet"
BITCOIN_RPC_URL=...               # Optional — Signet/mainnet RPC endpoint

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

### Current State (CRIT-2 — PARTIAL)

`getChainClient()` in `chain/client.ts` returns `SignetChainClient` when `ENABLE_PROD_NETWORK_ANCHORING=true`, otherwise `MockChainClient`. SignetChainClient implements OP_RETURN anchoring with `ARKV` 4-byte prefix + 32-byte SHA-256 fingerprint using `bitcoinjs-lib`.

**Completed:**
1. ~~Install `bitcoinjs-lib`~~ — `bitcoinjs-lib ^6.1.7`, `ecpair ^3.0.1`, `tiny-secp256k1 ^2.2.4`
2. ~~Implement real ChainClient with OP_RETURN~~ — `SignetChainClient` in `chain/signet.ts` (~414 lines)
3. ~~Wallet utilities~~ — `chain/wallet.ts` (keypair gen, address derivation, WIF validation) + 13 tests
4. ~~CLI scripts~~ — `scripts/generate-signet-keypair.ts`, `scripts/check-signet-balance.ts`
5. ~~UTXO provider~~ — `chain/utxo-provider.ts` (`RpcUtxoProvider` + `MempoolUtxoProvider` + factory) + 35 tests. Integrated into SignetChainClient + getChainClient().

**Remaining:**
1. Fund Signet treasury via faucet (signetfaucet.com or alt.signetfaucet.com)
2. Signet node connectivity test (verify SignetChainClient against real Signet node)
3. AWS KMS signing for mainnet
4. Mainnet treasury funding

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
  submitFingerprint(data: {
    fingerprint: string;
    timestamp: string;
  }): Promise<ChainReceipt>;

  verifyFingerprint(fingerprint: string): Promise<VerificationResult>;

  getReceipt(txId: string): Promise<ChainReceipt>;
}

interface ChainReceipt {
  txId: string;
  blockHeight: number;
  timestamp: string;
  confirmations: number;
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
| Chain client interface | Complete | SignetChainClient + MockChainClient (CRIT-2 PARTIAL — AWS KMS remaining) |
| Wallet utilities | Complete | P7-TS-11: keypair gen, address derivation, WIF validation, CLI scripts |
| UTXO provider | Complete | P7-TS-12: RpcUtxoProvider + MempoolUtxoProvider, factory, integrated into SignetChainClient |
| Stripe webhook handlers | Complete | P7-TS-03 |
| Outbound webhook delivery | Complete | Wired to anchor lifecycle (HARDENING-4). Dispatches on SECURED. |
| Webhook retry scheduling | Complete | `processWebhookRetries()` runs every 2 minutes via cron |
| Report generation | Complete | `report.ts` |
| Rate limiter | Complete | `utils/rateLimit.ts` |
| Worker test coverage | 363 tests across 17 files, 80%+ on all paths | HARDENING-1/2/3/4/5 + Signet + wallet + UTXO provider (2026-03-12) |

## Testing

### Unit Tests

```bash
cd services/worker
npm test
```

**Current coverage (2026-03-12 ~1:00 AM EST):** 363 tests across 17 test files. All worker source files pass 80% per-file thresholds. Critical path files (`anchor.ts`, `chain/client.ts`, `chain/mock.ts`, `chain/signet.ts`, `chain/utxo-provider.ts`, `chain/wallet.ts`, `webhooks/delivery.ts`, `stripe/client.ts`, `stripe/handlers.ts`) at 98-100%. Chain-specific: 147 tests across 6 files (signet 30, utxo-provider 31, wallet 13, client 9, mock 18, anchor 46).

### Mock Mode

Tests use mock interfaces for all external services (Constitution 1.7):

```typescript
const mockChain: IAnchorPublisher = {
  publishAnchor: jest.fn().mockResolvedValue({ txId: 'mock_tx' })
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
