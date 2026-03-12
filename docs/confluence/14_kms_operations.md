# AWS KMS Operations — Bitcoin Treasury Signing
_Last updated: 2026-03-12 | Story: DH-03 (unblocked by this document)_

## Overview

Arkova uses AWS KMS for mainnet Bitcoin transaction signing. The `KmsSigningProvider` in `services/worker/src/chain/signing-provider.ts` wraps an asymmetric KMS key (ECC_SECG_P256K1 / secp256k1) to sign OP_RETURN anchor transactions.

Signet and testnet use `WifSigningProvider` (ECPair from environment variable). KMS is **mainnet only**.

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

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-12 | DH-03 | Initial document — key provisioning, IAM, rotation, DR |
