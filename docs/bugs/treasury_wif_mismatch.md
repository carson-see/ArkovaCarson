# BUG: Treasury WIF Mismatch in Cloud Run Secret Manager

**ID:** BUG-OPS-01
**Date:** 2026-03-20 (discovered via debug logging)
**Severity:** CRITICAL (blocks all anchor processing on production)
**Status:** OPEN — requires manual secret update

## Summary

The `BITCOIN_TREASURY_WIF` secret stored in GCP Secret Manager produces a different address than the funded treasury address.

## Details

| Item | Value |
|------|-------|
| **Worker derives address** | `tb1qwejl9rjuuv2w04mrj2ggcc9qkmt3lxfn3rdcr9` |
| **Funded treasury address** | `tb1ql90xtpfzpyc03d2dghggqfdksfxe6ucjufah0r` |
| **Funded balance** | 293,314 sats (confirmed, 1 UTXO) |

## Symptoms

- Every minute, the `process-anchors` cron fires, finds the PENDING anchor, attempts chain submission
- Chain client fetches UTXOs for the **wrong address** (derived from the stored WIF)
- Returns 0 UTXOs → `Error: No UTXOs available for treasury address`
- Error serialized as `{}` in pino logs (fixed in this PR — Error objects now properly serialized)
- Anchor stays PENDING indefinitely

## Root Cause

The WIF in Secret Manager (`projects/arkova1/secrets/BITCOIN_TREASURY_WIF`) corresponds to a different keypair than the one used to fund the treasury.

## Fix Required

Update the `BITCOIN_TREASURY_WIF` secret to the WIF that derives to `tb1ql90xtpfzpyc03d2dghggqfdksfxe6ucjufah0r`:

```bash
# 1. Create new secret version with the correct WIF
echo -n "YOUR_CORRECT_WIF" | gcloud secrets versions add BITCOIN_TREASURY_WIF --data-file=- --project arkova1

# 2. Redeploy worker to pick up new secret
gcloud run deploy arkova-worker --image us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:latest --region us-central1 --project arkova1
```

**DO NOT log or commit the WIF value** (Constitution 1.4).

## How Discovered

1. Worker deployed with `p_flag_key` fix — anchoring enabled
2. Cron running every minute but anchor stuck at PENDING
3. Temporarily set `LOG_LEVEL=debug` on Cloud Run to see debug logs
4. Saw `"address": "tb1qwejl9rjuuv2w04mrj2ggcc9qkmt3lxfn3rdcr9"` in chain client init log
5. Compared to funded address `tb1ql90xtpfzpyc03d2dghggqfdksfxe6ucjufah0r`
6. Confirmed wrong address has 0 UTXOs via mempool.space API

## Also Fixed in This PR

- Error serialization: pino `createRpcLogger.error()` now includes `err`, `errorMessage`, `errorStack` instead of empty `{}` for Error objects
- Added pino stdSerializers for both `error` and `err` keys
