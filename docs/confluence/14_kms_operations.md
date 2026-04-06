# AWS KMS Operations — Bitcoin Treasury Signing
_Last updated: 2026-03-24 | Story: DH-03 (unblocked by this document), MVP-29_

## Overview

Arkova uses AWS KMS for mainnet Bitcoin transaction signing. The `KmsSigningProvider` in `services/worker/src/chain/signing-provider.ts` wraps an asymmetric KMS key (ECC_SECG_P256K1 / secp256k1) to sign OP_RETURN anchor transactions.

Signet and testnet use `WifSigningProvider` (ECPair from environment variable). KMS is **mainnet only**.

**Provider options:** AWS KMS (primary) or GCP Cloud KMS (MVP-29 alternative). Both support secp256k1 asymmetric signing. The provider is selected based on environment configuration.

## Architecture

```
┌─────────────────────┐
│   Anchor Worker      │
│   (processAnchor)    │
└──────────┬──────────┘
           │ sign(hash)
           ▼
┌─────────────────────┐
│  KmsSigningProvider  │ ← async factory: KmsSigningProvider.create()
│  (signing-provider)  │
└──────────┬──────────┘
           │ kms:Sign (ECDSA_SHA_256)
           ▼
┌─────────────────────┐
│    AWS KMS Key       │ ← ECC_SECG_P256K1, SIGN_VERIFY usage
│  (us-east-1)         │
└─────────────────────┘
```

## Key Provisioning Steps

### 1. Create the KMS Key

```bash
aws kms create-key \
  --key-spec ECC_SECG_P256K1 \
  --key-usage SIGN_VERIFY \
  --description "Arkova mainnet Bitcoin treasury signing key" \
  --tags TagKey=Environment,TagValue=production \
         TagKey=Service,TagValue=arkova-worker \
         TagKey=Purpose,TagValue=bitcoin-treasury \
  --region us-east-1
```

Record the `KeyId` from the response. This is the value for `KMS_KEY_ID` environment variable.

### 2. Create a Key Alias (Optional but Recommended)

```bash
aws kms create-alias \
  --alias-name alias/arkova-treasury-mainnet \
  --target-key-id <KeyId-from-step-1> \
  --region us-east-1
```

### 3. Verify the Key

```bash
# Confirm key spec and usage
aws kms describe-key --key-id <KeyId> --region us-east-1

# Expected output includes:
#   KeySpec: ECC_SECG_P256K1
#   KeyUsage: SIGN_VERIFY
#   KeyState: Enabled
```

### 4. Derive the Bitcoin Address

Once the KMS key exists, use `KmsSigningProvider.create()` to fetch the public key and derive the P2PKH address:

```typescript
import { KmsSigningProvider } from './chain/signing-provider.js';
import * as bitcoin from 'bitcoinjs-lib';

const provider = await KmsSigningProvider.create({
  keyId: process.env.KMS_KEY_ID!,
  region: 'us-east-1',
});

const { address } = bitcoin.payments.p2pkh({
  pubkey: provider.getPublicKey(),
  network: bitcoin.networks.bitcoin, // mainnet
});

console.log(`Treasury address: ${address}`);
// Fund this address before enabling ENABLE_PROD_NETWORK_ANCHORING
```

### 5. Set Environment Variables

```bash
# Worker .env (production)
KMS_KEY_ID=<KeyId-or-alias>       # e.g., alias/arkova-treasury-mainnet
KMS_REGION=us-east-1              # optional, defaults to us-east-1
BITCOIN_NETWORK=mainnet
ENABLE_PROD_NETWORK_ANCHORING=true
```

## IAM Policy Requirements

The worker's IAM role (or instance profile) needs these permissions on the KMS key:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ArkovaWorkerKMSSigning",
      "Effect": "Allow",
      "Action": [
        "kms:Sign",
        "kms:GetPublicKey"
      ],
      "Resource": "arn:aws:kms:us-east-1:<ACCOUNT_ID>:key/<KEY_ID>"
    }
  ]
}
```

**Principle of least privilege:**
- `kms:Sign` — required for transaction signing
- `kms:GetPublicKey` — required at provider initialization (cached after first call)
- **No** `kms:Decrypt`, `kms:Encrypt`, `kms:CreateKey`, or `kms:ScheduleKeyDeletion`
- Resource scoped to the specific key ARN, not `*`

### Key Policy (on the KMS key itself)

The KMS key policy must grant the worker IAM role access:

```json
{
  "Sid": "AllowWorkerSigning",
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::<ACCOUNT_ID>:role/<WORKER_ROLE_NAME>"
  },
  "Action": [
    "kms:Sign",
    "kms:GetPublicKey"
  ],
  "Resource": "*"
}
```

## Key Rotation Procedure

AWS KMS supports automatic key rotation for symmetric keys, but **not for asymmetric keys** (ECC_SECG_P256K1). Manual rotation is required.

### When to Rotate

- Suspected key compromise
- Compliance requirement (annual rotation policy)
- IAM role change affecting key access

### Rotation Steps

1. **Create new KMS key** (follow provisioning steps above)
2. **Derive new Bitcoin address** from the new key's public key
3. **Fund the new address** — transfer sufficient BTC for anchor operations
4. **Update environment variables** to point to the new key ID
5. **Deploy worker** with new configuration
6. **Verify** a test anchor succeeds with the new key
7. **Disable old key** (do NOT delete immediately):
   ```bash
   aws kms disable-key --key-id <OLD_KEY_ID> --region us-east-1
   ```
8. **After 90 days** with no issues, schedule deletion:
   ```bash
   aws kms schedule-key-deletion \
     --key-id <OLD_KEY_ID> \
     --pending-window-in-days 30 \
     --region us-east-1
   ```

**The old Bitcoin address remains valid** — any UTXOs at the old address are still spendable only by the old key. Sweep remaining funds from the old address to the new address before disabling the old key.

### Rotation Checklist

- [ ] New KMS key created with `ECC_SECG_P256K1` / `SIGN_VERIFY`
- [ ] New Bitcoin address derived and recorded
- [ ] New address funded with sufficient BTC
- [ ] Worker env vars updated (`KMS_KEY_ID`)
- [ ] Worker redeployed
- [ ] Test anchor broadcast succeeds
- [ ] Remaining funds swept from old address
- [ ] Old key disabled (not deleted)
- [ ] Old key deletion scheduled (90-day delay)
- [ ] Audit event logged for key rotation

## Disaster Recovery

### Scenario 1: Key Disabled Accidentally

```bash
# Re-enable the key
aws kms enable-key --key-id <KEY_ID> --region us-east-1
```

No data loss — the Bitcoin address and UTXOs are unchanged.

### Scenario 2: Key Scheduled for Deletion

If the key is pending deletion (7-30 day window):

```bash
# Cancel the deletion
aws kms cancel-key-deletion --key-id <KEY_ID> --region us-east-1

# Re-enable the key
aws kms enable-key --key-id <KEY_ID> --region us-east-1
```

### Scenario 3: Key Deleted (Irrecoverable)

**This is a critical incident.** If the KMS key has been deleted:

1. The Bitcoin address associated with that key is **permanently unspendable**
2. Any BTC at that address is **lost forever**
3. Create a new key and address (follow provisioning steps)
4. Fund the new address
5. All previously anchored transactions remain valid on-chain — they do not depend on the key continuing to exist

**Prevention:** Enable CloudTrail logging on all KMS API calls. Set up CloudWatch alarms for `kms:ScheduleKeyDeletion` and `kms:DisableKey` events.

### Scenario 4: Worker Cannot Reach KMS

- `initChainClient()` will fail at startup
- The worker will not process anchors (fail-closed behavior)
- Anchors will remain in PENDING status until connectivity is restored
- Check: IAM permissions, VPC/security group rules, KMS key state, region configuration

### CloudTrail Monitoring

```bash
# Check recent KMS operations on the treasury key
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=<KEY_ARN> \
  --max-results 20 \
  --region us-east-1
```

Recommended CloudWatch alarms:

| Event | Alarm | Severity |
|-------|-------|----------|
| `kms:ScheduleKeyDeletion` | Immediate page | CRITICAL |
| `kms:DisableKey` | Immediate alert | HIGH |
| `kms:Sign` failure rate > 5% | Alert | MEDIUM |
| `kms:GetPublicKey` failure | Alert on first occurrence | MEDIUM |

## Security Notes

- The KMS key ID is **never logged** (Constitution 1.4)
- `KmsSigningProvider` loads the key ID from environment variables only
- The private key **never leaves AWS KMS** — signing happens within the HSM
- Public key is fetched once at initialization and cached in memory
- DER-to-compact signature conversion happens in the worker (see `derToCompact()`)
- The `KmsClientLike` interface enables mock testing without AWS SDK (Constitution 1.7)

## Code References

| File | Purpose |
|------|---------|
| `services/worker/src/chain/signing-provider.ts` | `KmsSigningProvider` class + `KmsClientLike` interface |
| `services/worker/src/chain/signing-provider.test.ts` | 39 tests (mock KMS, 98%+ coverage) |
| `services/worker/src/chain/client.ts` | `initChainClient()` factory — creates KMS provider when `BITCOIN_NETWORK=mainnet` |
| `services/worker/src/chain/signet.ts` | `BitcoinChainClient` — uses any `SigningProvider` for tx signing |

## GCP Cloud KMS Provider (MVP-29)

As an alternative to AWS KMS, Arkova supports GCP Cloud KMS for environments already running on Google Cloud (e.g., Cloud Run worker deployment).

### GCP Key Setup (Production)

The production keyring is `arkova-signing` in the `global` location (same project as Cloud Run):

```bash
# Production key already provisioned:
# projects/arkova1/locations/global/keyRings/arkova-signing/cryptoKeys/bitcoin-mainnet/cryptoKeyVersions/1

# To create a new keyring (if needed):
gcloud kms keyrings create arkova-signing \
  --location=global \
  --project=arkova1

# To create an asymmetric signing key (secp256k1):
gcloud kms keys create bitcoin-mainnet \
  --keyring=arkova-signing \
  --location=global \
  --purpose=asymmetric-signing \
  --default-algorithm=ec-sign-secp256k1-sha256 \
  --project=arkova1
```

### GCP Environment Variables

```bash
GCP_KMS_KEY_RESOURCE_NAME=projects/arkova1/locations/global/keyRings/arkova-signing/cryptoKeys/bitcoin-mainnet/cryptoKeyVersions/1
KMS_PROVIDER=gcp    # "aws" or "gcp" (production uses gcp)
```

### GCP IAM

The Cloud Run service account (`270018525501-compute@developer.gserviceaccount.com`) needs `roles/cloudkms.signerVerifier` on the key resource:

```bash
gcloud kms keys add-iam-policy-binding bitcoin-mainnet \
  --keyring=arkova-signing \
  --location=global \
  --project=arkova1 \
  --member="serviceAccount:270018525501-compute@developer.gserviceaccount.com" \
  --role="roles/cloudkms.signerVerifier"
```

### Verify Address

```bash
cd services/worker
npx tsx scripts/verify-mainnet-address.ts [expected-bc1q-address]
```

## Fee Monitoring (PERF-7)

### MAX_FEE_SAT_PER_VBYTE

The worker enforces a maximum fee rate to prevent overpaying during fee spikes:

```bash
MAX_FEE_SAT_PER_VBYTE=50    # default: 50 sat/vByte
```

If the current mempool fee rate exceeds this threshold, the worker will:
1. Log a warning with the current vs. max fee rate
2. Skip the anchor batch and retry on the next cron cycle
3. Emit a `fee_spike_skipped` audit event

### Fee Rate Source

Fee estimates are fetched from the Mempool.space API (`/api/v1/fees/recommended`). The worker uses `halfHourFee` for standard anchoring priority.

## Stuck Transaction Detection & Rebroadcast

### Detection

A cron job (`/cron/check-stuck-txs`) identifies transactions that have been in `SUBMITTED` status for longer than the expected confirmation window (default: 6 blocks / ~60 minutes).

### Rebroadcast Strategy

1. **After 60 minutes:** Rebroadcast the original transaction via Mempool.space API
2. **After 120 minutes:** If still unconfirmed, log a `stuck_tx_alert` audit event for manual review
3. **RBF (Replace-By-Fee):** Not currently implemented. Stuck transactions are rebroadcast as-is.

### Environment Variables

```bash
STUCK_TX_THRESHOLD_MINUTES=60      # default: 60
STUCK_TX_REBROADCAST_ENABLED=true  # default: true
```

## Mainnet Readiness Status

| Requirement | Status | Notes |
|-------------|--------|-------|
| AWS KMS signing provider | **Complete** | `KmsSigningProvider` tested (39 tests, 98%+ coverage) |
| GCP Cloud KMS provider | **Complete** | MVP-29, production deploy uses GCP KMS |
| GCP KMS key provisioned | **Complete** | `projects/arkova1/locations/global/keyRings/arkova-signing/cryptoKeys/bitcoin-mainnet/cryptoKeyVersions/1` |
| Fee monitoring (MAX_FEE_SAT_PER_VBYTE) | **Complete** | PERF-7, prevents overpaying during fee spikes |
| Stuck TX detection | **Complete** | Cron-based detection + rebroadcast |
| Switchboard flag (`ENABLE_PROD_NETWORK_ANCHORING`) | **Complete** | Already `true` in worker-deploy.yml |
| KMS IAM binding | **Verify** | Cloud Run SA needs `roles/cloudkms.signerVerifier` on key |
| Treasury funding | **Pending** | Derive address via `verify-mainnet-address.ts`, then fund |
| Flip `BITCOIN_NETWORK` | **Pending** | Change `signet` → `mainnet` in worker-deploy.yml after funding |

## Key Ceremony Record Template (COMP-05)

Use this template to document each key generation or rotation event. Completed records serve as SOC 2 CC6.1 evidence.

### Ceremony Record

| Field | Value |
|-------|-------|
| **Date** | YYYY-MM-DD HH:MM UTC |
| **Ceremony Type** | Initial generation / Rotation / Emergency rotation |
| **Key Purpose** | Bitcoin treasury signing / API HMAC signing / JWT verification |
| **Algorithm** | e.g., ECDSA secp256k1 (EC_SIGN_SECP256K1_SHA256) |
| **KMS Provider** | AWS KMS / GCP Cloud KMS / Environment variable |
| **Key ID (masked)** | e.g., gcp-kms-***-bitcoin-mainnet |
| **Initiated By** | Name + role (e.g., Engineering Lead) |
| **Approved By** | Name + role (must differ from initiator — separation of duties) |
| **Witness** | Name + role (optional, recommended for initial generation) |

### Procedure Followed

1. [ ] Key generation command executed by authorized operator
2. [ ] Key metadata verified (algorithm, usage, region)
3. [ ] Bitcoin address derived and recorded (for treasury keys)
4. [ ] IAM/RBAC permissions scoped to least privilege
5. [ ] Environment variables updated in deployment config
6. [ ] Worker redeployed and health check confirmed
7. [ ] Test anchor/operation verified with new key
8. [ ] Audit event logged (`key_ceremony_completed`)
9. [ ] Previous key disabled (rotation only)
10. [ ] Previous key deletion scheduled with 90-day delay (rotation only)

### Separation of Duties Evidence

| Role | Can Create Keys | Can Use Keys | Can Delete Keys |
|------|----------------|-------------|-----------------|
| Engineering Lead | Yes | No (indirect via deploy) | Yes (with approval) |
| Worker Service Account | No | Yes (KMS Sign/GetPublicKey) | No |
| Cloud Admin | Yes | No | Yes (with approval) |

### Completed Ceremonies

| Date | Type | Key Purpose | Provider | Initiated By | Approved By |
|------|------|-------------|----------|-------------|-------------|
| 2026-03-12 | Initial generation | Bitcoin treasury (mainnet) | GCP Cloud KMS | Engineering Lead | Product Lead |

---

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-12 | DH-03 | Initial document — key provisioning, IAM, rotation, DR |
| 2026-03-24 | MVP-29, PERF-7 | Added GCP Cloud KMS provider option. Added fee monitoring (MAX_FEE_SAT_PER_VBYTE). Added stuck TX detection and rebroadcast. Added mainnet readiness status table. |
| 2026-03-26 | P7-TS-04 | Corrected GCP key resource name to match deploy config. Added `verify-mainnet-address.ts` script. Updated IAM commands with production SA. Updated readiness table. |
| 2026-04-05 | COMP-05 | Added key ceremony record template, separation of duties matrix, completed ceremonies log. Added key-inventory API endpoint. |

---

## Key Ceremony Documentation (COMP-05)

_Added: 2026-04-05 | Required by: SOC 2 CC6.1, eIDAS Art. 19_

### Key Ceremony Record Template

For each cryptographic key generated or rotated, the following record must be created and retained:

| Field | Description |
|-------|-------------|
| **Date** | Date and time of ceremony (UTC) |
| **Participants** | Names and roles of all participants (minimum: 1 key custodian + 1 witness) |
| **Key Purpose** | Bitcoin treasury signing / AdES document signing / timestamp signing |
| **KMS Provider** | AWS KMS / GCP Cloud HSM |
| **Key ID** | KMS key ARN or resource path (record full path; mask in API responses) |
| **Algorithm** | ECC_SECG_P256K1 (Bitcoin) / RSA-2048+ / ECDSA P-256/P-384 (AdES) |
| **Key Policy** | IAM roles/principals authorized to use the key |
| **Public Key Fingerprint** | SHA-256 of the exported public key (for future reference) |
| **Backup** | N/A for KMS-managed keys (KMS handles replication) |
| **Authorization** | Who approved the key creation (name, role, ticket reference) |
| **Cloud Audit Log Ref** | CloudTrail event ID (AWS) or Cloud Audit log entry (GCP) |
| **Rotation Schedule** | Annual / on-demand / never (immutable keys) |

### Separation of Duties

| Action | Required Role | Cannot Also Hold |
|--------|--------------|-----------------|
| Create KMS key | Infrastructure Admin | Cannot be sole signing authorizer |
| Authorize signing | Application Deployer (Cloud Run SA) | Cannot create keys |
| Rotate key | Infrastructure Admin | Requires 2nd approval |
| Delete/disable key | Infrastructure Admin | Requires CEO/CTO approval |
| View key inventory | Admin, Compliance Officer | — |

### Key Inventory API

`GET /api/v1/signatures/key-inventory` (admin/compliance_officer only)

Returns a masked inventory of all signing keys. Never returns raw key material, full ARNs, or resource paths (Constitution 1.4).

```json
{
  "keys": [
    {
      "key_id_masked": "arn:aws:kms:us-****:key/****-abcd",
      "algorithm": "ECC_SECG_P256K1",
      "purpose": "bitcoin_treasury",
      "created_at": "2026-03-15T00:00:00Z",
      "last_rotation": null,
      "status": "ACTIVE",
      "provider": "aws_kms"
    }
  ],
  "total_keys": 1,
  "generated_at": "2026-04-05T00:00:00Z"
}
```

### Existing Key Records

| Key | Provider | Algorithm | Purpose | Created | Status |
|-----|----------|-----------|---------|---------|--------|
| GCP KMS secp256k1 | GCP Cloud KMS | EC_SIGN_SECP256K1_SHA256 | Bitcoin treasury (mainnet) | 2026-03-15 | ACTIVE |
| (Planned) AdES RSA-2048 | TBD | RSA-2048 | AdES document signing | — | PLANNED |
| (Planned) AdES ECDSA P-256 | TBD | ECDSA P-256 | AdES document signing | — | PLANNED |

### Change Log

| Date | Change |
|------|--------|
| 2026-04-05 | Added key ceremony template, separation of duties, key inventory API spec (COMP-05) |
