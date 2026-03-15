# Operational Runbook — Production Launch
_Last updated: 2026-03-15 | Stories: P7-TS-05, MVP-01_

## Overview

This document tracks the **manual operational steps** required for production launch that cannot be automated in code. All corresponding code is complete and tested.

## 1. Bitcoin Chain Client — Mainnet (P7-TS-05)

**Code status:** COMPLETE (455+ worker tests, signet E2E broadcast verified TX `b8e381df`)

### 1.1 AWS KMS Key Provisioning

Follow `docs/confluence/14_kms_operations.md` for detailed instructions.

| Step | Action | Who |
|------|--------|-----|
| 1 | Create asymmetric signing key in AWS KMS (ECC_SECG_P256K1) | Ops |
| 2 | Note the Key ID and ARN | Ops |
| 3 | Set `BITCOIN_KMS_KEY_ID` env var in Cloud Run | Ops |
| 4 | Set `BITCOIN_KMS_REGION` env var in Cloud Run | Ops |
| 5 | Grant Cloud Run service account `kms:Sign` and `kms:GetPublicKey` permissions | Ops |
| 6 | Verify with `KmsSigningProvider` health check | Ops |

### 1.2 Mainnet Treasury Funding

| Step | Action | Who |
|------|--------|-----|
| 1 | Derive mainnet address from KMS public key | Ops (use `check-signet-balance.ts` adapted for mainnet) |
| 2 | Fund treasury address with BTC (minimum ~50,000 sats for initial anchoring) | Finance |
| 3 | Verify balance via Mempool.space or Bitcoin Core RPC | Ops |
| 4 | Set `BITCOIN_NETWORK=mainnet` in Cloud Run env | Ops |
| 5 | Set `ENABLE_PROD_NETWORK_ANCHORING=true` in switchboard_flags | Ops |

### 1.3 Signet (Already Verified)

- Treasury: `mx1zmGtQTghi4GWcJaV1oPwJ5TKhGfFpjs` (500,636 sats)
- E2E broadcast TX: `b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57`
- Set `BITCOIN_NETWORK=signet` + `BITCOIN_TREASURY_WIF` for signet deployment

## 2. Worker Production Deployment (MVP-01)

**Code status:** COMPLETE (Dockerfile, .env.example, deploy workflow, health check endpoint)

### 2.1 Cloud Run Environment Variables

Set these in GCP Cloud Run configuration (or via `gcloud run services update`):

| Variable | Source | Notes |
|----------|--------|-------|
| `SUPABASE_URL` | Supabase dashboard | `https://vzwyaatejekddvltxyye.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API | Rotate after initial setup |
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys | Use live key for production |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard → after webhook registration | See step 2.2 |
| `BITCOIN_TREASURY_WIF` | Generated via `generate-signet-keypair.ts` | For signet; KMS for mainnet |
| `BITCOIN_NETWORK` | `signet` for testnet launch | `mainnet` when ready |
| `ENABLE_PROD_NETWORK_ANCHORING` | `true` | Gates real Bitcoin calls |
| `FRONTEND_URL` | `https://arkova-carson.vercel.app` | CORS origin |
| `NODE_ENV` | `production` | |
| `API_KEY_HMAC_SECRET` | Generate with `openssl rand -hex 32` | For API key hashing |

### 2.2 Stripe Webhook Registration

| Step | Action |
|------|--------|
| 1 | Go to Stripe Dashboard → Developers → Webhooks |
| 2 | Add endpoint: `https://arkova-worker-kvojbeutfa-uc.a.run.app/webhooks/stripe` |
| 3 | Select events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed` |
| 4 | Copy the webhook signing secret |
| 5 | Set `STRIPE_WEBHOOK_SECRET` env var in Cloud Run |

### 2.3 Cloud Scheduler (Cron Jobs)

| Job | Schedule | Target |
|-----|----------|--------|
| Process pending anchors | `*/5 * * * *` (every 5 min) | `POST /cron/process-anchors` |
| Webhook retries | `*/10 * * * *` (every 10 min) | `POST /cron/webhook-retries` |
| Report generation | `0 * * * *` (hourly) | `POST /cron/generate-reports` |
| Credit expiry | `0 0 1 * *` (monthly) | `POST /cron/credit-expiry` |

### 2.4 Deployment Verification

```bash
# Health check
curl https://arkova-worker-kvojbeutfa-uc.a.run.app/api/health

# Expected: { "status": "ok", "chain": "signet|mainnet", "timestamp": "..." }
```

## 3. Other Pre-Launch Manual Steps

| Task | Description | Who |
|------|-------------|-----|
| DNS | Point `app.arkova.io` to Vercel deployment | Ops |
| Marketing DNS | Point `arkova.ai` to marketing site Vercel project | Ops |
| Seed data strip | Remove demo users from production Supabase | Ops |
| Sentry DSN | Set `VITE_SENTRY_DSN` (frontend) and `SENTRY_DSN` (worker) | Ops |
| Apply migrations 0052-0053 | `supabase db push` against production | Ops |
| Key rotation | Rotate Stripe live key + Supabase service role key post-setup | Security |

## Change Log

| Date | Change |
|------|--------|
| 2026-03-15 | Initial creation — consolidates P7-TS-05 + MVP-01 operational items |
