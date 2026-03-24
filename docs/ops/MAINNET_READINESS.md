# Bitcoin Mainnet Window — Readiness Checklist

> **Purpose:** Step-by-step operational guide for the temporary mainnet anchoring window.
> **Status:** Code READY, infrastructure PENDING
> **Created:** 2026-03-24

---

## Code Readiness: COMPLETE

All code paths for mainnet are implemented and tested:

| Component | Status | File |
|-----------|--------|------|
| BitcoinChainClient (mainnet network) | READY | `services/worker/src/chain/signet.ts` |
| GCP KMS SigningProvider | READY | `services/worker/src/chain/gcp-kms-signing-provider.ts` |
| AWS KMS SigningProvider | READY | `services/worker/src/chain/signing-provider.ts` |
| Chain client factory (mainnet branch) | READY | `services/worker/src/chain/client.ts:246-308` |
| Mempool.space fee estimator (mainnet) | READY | `services/worker/src/chain/fee-estimator.ts` |
| UTXO provider (mempool.space mainnet) | READY | `services/worker/src/chain/utxo-provider.ts` |
| Config schema (KMS_PROVIDER, etc.) | READY | `services/worker/src/config.ts` |

---

## Infrastructure Steps (OPS-05 + OPS-06)

### Step 1: Provision KMS Signing Key

**Option A: GCP Cloud KMS (Recommended — already on GCP)**

```bash
# Create keyring
gcloud kms keyrings create arkova-mainnet \
  --location=us-central1

# Create secp256k1 signing key
gcloud kms keys create bitcoin-mainnet-signer \
  --keyring=arkova-mainnet \
  --location=us-central1 \
  --purpose=asymmetric-signing \
  --default-algorithm=ec-sign-secp256k1-sha256 \
  --protection-level=hsm

# Get the key version resource name
gcloud kms keys versions list \
  --key=bitcoin-mainnet-signer \
  --keyring=arkova-mainnet \
  --location=us-central1

# Output format: projects/PROJECT_ID/locations/us-central1/keyRings/arkova-mainnet/cryptoKeys/bitcoin-mainnet-signer/cryptoKeyVersions/1
```

**Option B: AWS KMS**

```bash
aws kms create-key \
  --key-spec ECC_SECG_P256K1 \
  --key-usage SIGN_VERIFY \
  --description "Arkova Bitcoin mainnet anchor signing key"
```

### Step 2: Derive Treasury Address

After provisioning the KMS key, derive the Bitcoin address:

```bash
# The worker will log the treasury address on startup
# Set env vars and start worker — it derives the address from the KMS public key
```

### Step 3: Fund Treasury Wallet

Fund the derived mainnet address with BTC. Recommended: 0.001 BTC (~$60 at current prices) for initial batch.

Each OP_RETURN anchor costs ~250-500 sats in fees at typical fee rates.
- 500 anchors at 500 sats each = 250,000 sats = 0.0025 BTC
- Budget 0.005 BTC for a large batch session

### Step 4: Set Environment Variables (Cloud Run)

```bash
# Switch to mainnet
gcloud run services update arkova-worker \
  --set-env-vars \
    BITCOIN_NETWORK=mainnet,\
    KMS_PROVIDER=gcp,\
    GCP_KMS_KEY_RESOURCE_NAME=projects/PROJECT_ID/locations/us-central1/keyRings/arkova-mainnet/cryptoKeys/bitcoin-mainnet-signer/cryptoKeyVersions/1,\
    ENABLE_PROD_NETWORK_ANCHORING=true,\
    MEMPOOL_API_URL=https://mempool.space/api

# Verify health
curl https://WORKER_URL/health
```

### Step 5: Run Mainnet Anchoring Batch

```bash
# Trigger anchor processing
curl -H "X-Cron-Secret: $CRON_SECRET" \
  https://WORKER_URL/jobs/process-anchors

# Monitor in logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=arkova-worker" \
  --limit=50 --format="table(timestamp,textPayload)"
```

### Step 6: Revert to Signet

After the mainnet window:

```bash
gcloud run services update arkova-worker \
  --set-env-vars \
    BITCOIN_NETWORK=signet,\
    ENABLE_PROD_NETWORK_ANCHORING=true,\
    MEMPOOL_API_URL=https://mempool.space/signet/api

# Remove mainnet KMS vars (optional, they're ignored when network=signet)
```

---

## Safety Checklist

- [ ] KMS key provisioned with HSM protection level
- [ ] Treasury address derived and verified
- [ ] Treasury funded (confirm balance on mempool.space)
- [ ] BITCOIN_NETWORK=mainnet set
- [ ] ENABLE_PROD_NETWORK_ANCHORING=true set
- [ ] Mempool API URL set to mainnet (https://mempool.space/api)
- [ ] Test with single anchor first (manual trigger)
- [ ] Verify tx appears on mempool.space mainnet
- [ ] Run batch processing
- [ ] Confirm all SUBMITTED → SECURED
- [ ] Revert to signet when done
- [ ] Document mainnet tx IDs in production records

---

## Fee Monitoring

The worker's `MempoolFeeEstimator` automatically queries mainnet fee rates.
If rates exceed `BITCOIN_MAX_FEE_RATE` (configurable), anchors are queued.

Default fallback: 5 sat/vB (safe for non-urgent anchoring).

Recommended env var: `BITCOIN_MAX_FEE_RATE=20` (skip anchoring when fees spike).
