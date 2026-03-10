# Anchoring Worker
_Last updated: 2026-03-10 | Story: P7-TS-05, P7-TS-10_

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
    │   │   ├── anchor.ts         # Process pending anchors
    │   │   ├── anchorWithClaim.ts # Anchor with claim processing
    │   │   ├── report.ts         # Report generation job
    │   │   └── webhook.ts        # Webhook delivery job (stub)
    │   ├── chain/
    │   │   ├── client.ts         # ChainClient factory (returns MockChainClient)
    │   │   ├── mock.ts           # Mock implementation
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

Process PENDING anchors and submit to chain (`jobs/anchor.ts`, `jobs/anchorWithClaim.ts`):

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

  // Log audit event
  await db.from('audit_events').insert({
    event_type: 'anchor.secured',
    event_category: 'ANCHOR',
    target_type: 'anchor',
    target_id: anchorId,
    details: `Secured on chain: ${receipt.txId}`,
  });
}
```

The `anchoring_jobs` table (migration 0017) provides a safe claim mechanism with `FOR UPDATE SKIP LOCKED` to prevent duplicate processing.

### 2. Webhook Processing

- **Inbound:** Stripe webhook handlers (`stripe/handlers.ts`)
- **Outbound:** Delivery engine (`webhooks/delivery.ts`) with exponential backoff and HMAC-SHA256 signing

See [09_webhooks.md](./09_webhooks.md) for details.

### 3. Report Generation

Report processing job (`jobs/report.ts`) generates reports requested via the `reports` table (migration 0019). Output stored as `report_artifacts`.

### 4. Scheduled Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `processAnchors` | Every minute | Claim and process PENDING anchoring jobs |
| `deliverWebhooks` | Every minute | Retry failed webhook deliveries |
| `resetMonthlyCounts` | 1st of month | Reset anchor quotas |

## Configuration

### Environment Variables

```bash
# Database
SUPABASE_SERVICE_ROLE_KEY=...     # Worker-only, never in browser

# Chain (currently mock — CRIT-2)
BITCOIN_TREASURY_WIF=...          # Signing key — never logged
BITCOIN_NETWORK=testnet           # "mainnet" or "testnet"

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

### Current State (CRIT-2)

`getChainClient()` in `chain/client.ts` always returns `MockChainClient`. No real Bitcoin integration exists yet. The production path requires:

1. Install `bitcoinjs-lib`
2. Implement real ChainClient with OP_RETURN
3. Bitcoin Signet testing first
4. AWS KMS for mainnet signing

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
| Anchor processing jobs | Complete | `anchor.ts`, `anchorWithClaim.ts` |
| Chain client interface | Complete | MockChainClient only (CRIT-2) |
| Stripe webhook handlers | Complete | P7-TS-03 |
| Outbound webhook delivery | Partial | Engine exists, not wired to anchor lifecycle |
| Report generation | Complete | `report.ts` |
| Rate limiter | Complete | `utils/rateLimit.ts` |
| Worker test coverage | 0% | Production blocker — hardening sprint planned |

## Testing

### Unit Tests

```bash
cd services/worker
npm test
```

**Current coverage: 0%.** Worker hardening sprint (CLAUDE.md Section 9, Week 1) is the prerequisite before real chain integration.

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
