# Bitcoin Mainnet Window — Readiness Checklist

> **Purpose:** Step-by-step operational guide for the temporary mainnet anchoring window.
> **Status:** Code READY, KMS PROVISIONED, WIF CONFIGURED, treasury funding PENDING
> **Created:** 2026-03-24
> **Updated:** 2026-03-24

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

## Infrastructure Readiness

### GCP KMS Key: PROVISIONED

| Property | Value |
|----------|-------|
| Project | `arkova-vault` |
| Keyring | `arkova-signing` |
| Key | `bitcoin-mainnet` |
| Algorithm | `ec-sign-secp256k1-sha256` |
| Protection | HSM |
| Location | `global` |
| Version | 1 |
| State | ENABLED |
| Resource Name | `projects/arkova-vault/locations/global/keyRings/arkova-signing/cryptoKeys/bitcoin-mainnet/cryptoKeyVersions/1` |

### Workload Identity Federation: CONFIGURED

Zero static service account keys. GitHub Actions authenticates to GCP via OIDC token exchange.

| Property | Value |
|----------|-------|
| GCP Project | `arkova-vault` (599397545362) |
| Pool | `arkova-railway-workers` |
| Provider | `github-actions` |
| Issuer | `https://token.actions.githubusercontent.com` |
| Condition | `assertion.repository == "ArkovaCarson/arkova-mvp"` |
| Service Account | `railway-worker@arkova-vault.iam.gserviceaccount.com` |
| SA Role on KMS Key | `roles/cloudkms.signerVerifier` |
| WIF Role on SA | `roles/iam.workloadIdentityUser` |
| Org Policy | `iam.disableServiceAccountKeyCreation` enforced (no static keys) |

**WIF Provider Resource (for GitHub secrets):**
```
projects/599397545362/locations/global/workloadIdentityPools/arkova-railway-workers/providers/github-actions
```

### CI/CD: CONFIGURED

The deploy workflow (`.github/workflows/worker-deploy.yml`) includes:
- `KMS_PROVIDER=gcp` env var
- `GCP_KMS_KEY_RESOURCE_NAME` pointing to the provisioned key
- WIF authentication via `google-github-actions/auth@v2`

**GitHub Secrets Required:**

| Secret | Value |
|--------|-------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/599397545362/locations/global/workloadIdentityPools/arkova-railway-workers/providers/github-actions` |
| `GCP_SERVICE_ACCOUNT` | `railway-worker@arkova-vault.iam.gserviceaccount.com` |

---

## Remaining Steps

### Step 1: Cross-Project IAM (if Cloud Run is in `arkova1`)

The Cloud Run service runs in project `arkova1` but the KMS key is in `arkova-vault`.
The Cloud Run default service account needs KMS access:

```bash
# Option A: Grant the Cloud Run SA access to the KMS key in arkova-vault
gcloud kms keys add-iam-policy-binding bitcoin-mainnet \
  --keyring=arkova-signing \
  --location=global \
  --project=arkova-vault \
  --role="roles/cloudkms.signerVerifier" \
  --member="serviceAccount:CLOUD_RUN_SA@arkova1.iam.gserviceaccount.com"

# Option B: Attach railway-worker SA to Cloud Run (preferred — single SA for all access)
gcloud run services update arkova-worker \
  --region=us-central1 \
  --project=arkova1 \
  --service-account=railway-worker@arkova-vault.iam.gserviceaccount.com
```

### Step 2: Update GitHub Secrets

Set these in GitHub → Settings → Secrets → Actions:

```
GCP_WORKLOAD_IDENTITY_PROVIDER = projects/599397545362/locations/global/workloadIdentityPools/arkova-railway-workers/providers/github-actions
GCP_SERVICE_ACCOUNT = railway-worker@arkova-vault.iam.gserviceaccount.com
```

### Step 3: Derive Treasury Address

After deploying with mainnet config, the worker logs the treasury address on startup:

```bash
# Deploy with mainnet config and check logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=arkova-worker AND textPayload:treasury" \
  --limit=5 --project=arkova1
```

### Step 4: Fund Treasury Wallet

Fund the derived mainnet address with BTC.

Each OP_RETURN anchor costs ~250-500 sats in fees at typical fee rates.
- 500 anchors at 500 sats each = 250,000 sats = 0.0025 BTC
- Budget 0.005 BTC for a large batch session

### Step 5: Switch to Mainnet

```bash
gcloud run services update arkova-worker \
  --region=us-central1 \
  --project=arkova1 \
  --set-env-vars \
    BITCOIN_NETWORK=mainnet,\
    MEMPOOL_API_URL=https://mempool.space/api

# Verify health
URL=$(gcloud run services describe arkova-worker --region=us-central1 --project=arkova1 --format='value(status.url)')
curl -sf "${URL}/health" | jq .
```

### Step 6: Test Single Anchor

```bash
# Trigger single anchor processing
curl -H "X-Cron-Secret: $CRON_SECRET" "${URL}/jobs/process-anchors"

# Verify tx on mempool.space mainnet
```

### Step 7: Run Batch & Revert

```bash
# After batch completes, revert to signet
gcloud run services update arkova-worker \
  --region=us-central1 \
  --project=arkova1 \
  --set-env-vars \
    BITCOIN_NETWORK=signet,\
    MEMPOOL_API_URL=https://mempool.space/signet/api
```

---

## Safety Checklist

- [x] KMS key provisioned with HSM protection level
- [x] Workload Identity Federation configured (zero static keys)
- [x] Service account has `cloudkms.signerVerifier` on KMS key
- [x] GitHub Actions OIDC → GCP WIF → SA impersonation chain verified
- [x] CI/CD workflow updated with KMS env vars
- [ ] GitHub secrets updated (GCP_WORKLOAD_IDENTITY_PROVIDER, GCP_SERVICE_ACCOUNT)
- [ ] Cross-project IAM configured (Cloud Run SA → arkova-vault KMS)
- [ ] Treasury address derived and verified
- [ ] Treasury funded (confirm balance on mempool.space)
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

---

## Security Notes

- **No static service account keys exist.** Org policy `iam.disableServiceAccountKeyCreation` enforced.
- **WIF condition** restricts token exchange to `ArkovaCarson/arkova-mvp` repo only.
- **KMS key is HSM-backed** — private key material never leaves Google's HSM.
- **Treasury WIF** (for signet) is in Secret Manager; mainnet uses KMS exclusively.
- All signing operations are audit-logged in GCP Cloud Audit Logs.
