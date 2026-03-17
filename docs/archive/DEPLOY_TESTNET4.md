# Deploying Arkova Worker with Bitcoin Testnet4 Anchoring

_Last updated: 2026-03-16 | Sprint: testnet4-anchoring_

This guide covers deploying the Arkova worker service with real Bitcoin testnet4 anchoring enabled. Testnet4 is the recommended test network — it uses the same address format as mainnet but with free test coins.

---

## Prerequisites

- GCP Cloud Run deployment working (`arkova-worker-kvojbeutfa-uc.a.run.app`)
- Supabase production database with all migrations applied (through 0063)
- `switchboard_flags` table has `ENABLE_PROD_NETWORK_ANCHORING` flag

---

## 1. Generate a Testnet4 Treasury Keypair

Use the existing CLI script in the worker:

```bash
cd services/worker
npx tsx scripts/generate-signet-keypair.ts
```

This outputs:
- **WIF** (Wallet Import Format private key) — store securely, NEVER commit
- **Address** (P2PKH address starting with `m` or `n`) — safe to share

> Testnet4, signet, and testnet all use the same bitcoinjs-lib network parameters (`bitcoin.networks.testnet`), so the same keypair generation works for all three.

---

## 2. Fund the Treasury Wallet

Testnet4 faucets provide free test coins:

1. Copy the treasury address from step 1
2. Visit a testnet4 faucet (e.g., `https://mempool.space/testnet4/faucet`)
3. Request coins to your treasury address
4. Verify the balance:

```bash
npx tsx scripts/check-signet-balance.ts <your-address>
```

Or check on mempool.space: `https://mempool.space/testnet4/address/<your-address>`

You need at least a few thousand satoshis. Each OP_RETURN anchor transaction costs ~200-300 sats in fees at 1 sat/vB.

---

## 3. Required Environment Variables for Cloud Run

Set these secrets in GCP Secret Manager and mount them in Cloud Run:

```bash
# Bitcoin chain configuration
BITCOIN_NETWORK=testnet4
BITCOIN_TREASURY_WIF=<wif-from-step-1>         # NEVER log this
BITCOIN_UTXO_PROVIDER=mempool                    # No node required
BITCOIN_FEE_STRATEGY=static                      # Use static 1 sat/vB for testnet4
BITCOIN_STATIC_FEE_RATE=1

# Enable real chain calls
ENABLE_PROD_NETWORK_ANCHORING=true

# Required existing secrets (already configured)
SUPABASE_URL=https://vzwyaatejekddvltxyye.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
STRIPE_SECRET_KEY=<your-stripe-key>
STRIPE_WEBHOOK_SECRET=<your-webhook-secret>
API_KEY_HMAC_SECRET=<your-hmac-secret>

# Worker config
NODE_ENV=production
WORKER_PORT=3001
FRONTEND_URL=https://arkova-carson.vercel.app
```

### Setting secrets via gcloud:

```bash
# Create the treasury WIF secret
echo -n "<your-wif>" | gcloud secrets create bitcoin-treasury-wif \
  --project=arkova1 --data-file=-

# Update the Cloud Run service to mount the new secret
gcloud run services update arkova-worker \
  --project=arkova1 \
  --region=us-central1 \
  --set-secrets="BITCOIN_TREASURY_WIF=bitcoin-treasury-wif:latest" \
  --set-env-vars="BITCOIN_NETWORK=testnet4,ENABLE_PROD_NETWORK_ANCHORING=true,BITCOIN_UTXO_PROVIDER=mempool,BITCOIN_FEE_STRATEGY=static,BITCOIN_STATIC_FEE_RATE=1"
```

---

## 4. Enable the Switchboard Flag

The worker checks the `ENABLE_PROD_NETWORK_ANCHORING` flag at two levels:

1. **Startup (env var):** Determines whether to initialize the real `BitcoinChainClient` or `MockChainClient`
2. **Runtime (switchboard_flags table):** Checked before each processing batch — acts as a kill switch

Enable in Supabase:

```sql
UPDATE switchboard_flags
SET value = true
WHERE id = 'ENABLE_PROD_NETWORK_ANCHORING';
```

To emergency-disable anchoring without redeploying, set the flag back to `false`:

```sql
UPDATE switchboard_flags
SET value = false
WHERE id = 'ENABLE_PROD_NETWORK_ANCHORING';
```

---

## 5. Cloud Scheduler Cron Jobs

Cloud Scheduler triggers the worker's HTTP endpoints. These endpoints are authenticated via Cloud Run IAM (OIDC tokens).

The following jobs should already exist (MVP-28):

| Job | Schedule | Endpoint | Description |
|-----|----------|----------|-------------|
| `process-anchors` | `* * * * *` (every minute) | `POST /jobs/process-anchors` | Process PENDING → SECURED |
| `webhook-retries` | `*/2 * * * *` (every 2 min) | `POST /jobs/webhook-retries` | Retry failed webhooks |
| `credit-expiry` | `0 0 1 * *` (1st of month) | `POST /jobs/credit-expiry` | Monthly credit allocation |

> The worker also runs internal `node-cron` schedules as a belt-and-suspenders backup.

---

## 6. Verify the Worker is Processing Anchors

### Health check:

```bash
curl https://arkova-worker-kvojbeutfa-uc.a.run.app/health
```

Expected response:

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime": 123,
  "network": "testnet4",
  "checks": { "supabase": "ok" }
}
```

### Manual trigger (non-production only):

```bash
curl -X POST https://arkova-worker-kvojbeutfa-uc.a.run.app/jobs/process-anchors
```

### Check worker logs:

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=arkova-worker" \
  --project=arkova1 --limit=50 --format=json | jq '.[].textPayload'
```

Look for:
- `Using BitcoinChainClient (testnet4)` — chain client initialized with real provider
- `Submitting fingerprint to chain` — anchor being processed
- `Fingerprint anchored on chain` — successful broadcast
- `anchor.secured` — status updated

---

## 7. Monitor Anchor Status Transitions

### Query Supabase for anchor status:

```sql
-- Recent anchor transitions
SELECT id, status, chain_tx_id, chain_block_height, chain_timestamp, created_at
FROM anchors
WHERE status = 'SECURED'
ORDER BY chain_timestamp DESC
LIMIT 10;

-- Pending anchors waiting to be processed
SELECT id, fingerprint, created_at
FROM anchors
WHERE status = 'PENDING' AND deleted_at IS NULL
ORDER BY created_at ASC;

-- Chain index entries (O(1) verification cache)
SELECT fingerprint_sha256, chain_tx_id, chain_block_height, confirmations
FROM anchor_chain_index
ORDER BY created_at DESC
LIMIT 10;
```

### Verify on mempool.space:

Each anchored transaction can be viewed at:
`https://mempool.space/testnet4/tx/<chain_tx_id>`

The OP_RETURN output will contain `ARKV` (hex: `41524b56`) followed by the 32-byte SHA-256 fingerprint.

---

## 8. Architecture Overview

```text
┌──────────────┐     ┌──────────────────┐     ┌───────────────────┐
│   Frontend    │────▶│   Supabase DB    │◀────│  Worker (Cloud    │
│  (Vercel)     │     │  (anchors table) │     │  Run + node-cron) │
│               │     │  status=PENDING  │     │                   │
└──────────────┘     └──────────────────┘     │  processAnchor()  │
                                               │    │               │
                                               │    ▼               │
                                               │  BitcoinChainClient│
                                               │    │               │
                                               │    ▼               │
                                               │  Mempool.space API │
                                               │  (testnet4)        │
                                               │    │               │
                                               │    ▼               │
                                               │  status=SECURED    │
                                               │  + chain_tx_id     │
                                               │  + audit event     │
                                               │  + webhook         │
                                               └───────────────────┘
```

### Pipeline flow:

1. **Frontend** — User uploads document, client-side SHA-256 fingerprint generated
2. **Supabase** — Anchor inserted with `status=PENDING`
3. **Worker cron** — Every minute, queries PENDING anchors
4. **Switchboard check** — Reads `ENABLE_PROD_NETWORK_ANCHORING` from DB (runtime kill switch)
5. **Fingerprint validation** — Verifies 64-char hex SHA-256 format
6. **Chain submission** — Builds OP_RETURN tx, signs with WIF, broadcasts via Mempool.space
7. **Status update** — Sets `status=SECURED`, stores `chain_tx_id`, `chain_block_height`, `chain_timestamp`
8. **Chain index** — Upserts to `anchor_chain_index` for O(1) verification
9. **Audit event** — Logs `anchor.secured` to `audit_events`
10. **Webhook** — Dispatches `anchor.secured` to org's registered endpoints

---

## 9. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Worker logs `Using MockChainClient` | `ENABLE_PROD_NETWORK_ANCHORING=false` or `USE_MOCKS=true` | Set env vars correctly |
| `No UTXOs available for treasury address` | Treasury wallet has no confirmed coins | Fund via testnet4 faucet |
| `UTXO large enough to cover fee` | All UTXOs are dust (<546 sats) | Fund with larger amounts |
| `Invalid WIF` | Wrong WIF format or wrong network | Regenerate keypair |
| `Anchor processing disabled via switchboard flag` | DB flag is `false` | `UPDATE switchboard_flags SET value = true WHERE id = 'ENABLE_PROD_NETWORK_ANCHORING'` |
| Anchors stay PENDING | Chain client not initialized or cron not running | Check worker logs for init errors |
| `Chain health check failed` | Mempool.space API unreachable | Check network connectivity, try alternate API URL |

---

## 10. Migrating to Mainnet

When ready for production:

1. Change `BITCOIN_NETWORK=mainnet`
2. Set up KMS signing (`KMS_PROVIDER=gcp` + `GCP_KMS_KEY_RESOURCE_NAME`)
3. Change `BITCOIN_FEE_STRATEGY=mempool` (live fee estimation)
4. Fund the mainnet treasury wallet with real BTC
5. Update `BITCOIN_UTXO_PROVIDER=mempool` (or run your own node with `rpc`)
6. See `docs/confluence/14_kms_operations.md` and `docs/confluence/15_operational_runbook.md`
