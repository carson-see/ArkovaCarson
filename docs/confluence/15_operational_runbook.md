# Operational Runbook — Production Launch
_Last updated: 2026-03-16 | Stories: P7-TS-05, MVP-01_

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

### 2.2 Stripe Webhook Registration — COMPLETE

Webhook registered 2026-03-16.

| Field | Value |
|-------|-------|
| Webhook ID | `we_1TBHb6BBeICNeQqrolzWA2yj` |
| Endpoint URL | `https://arkova-worker-kvojbeutfa-uc.a.run.app/webhooks/stripe` |
| Events | `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed` |
| Secret | Stored in GCP Secret Manager (`stripe-webhook-secret`, version 3) |
| `API_KEY_HMAC_SECRET` | Stored in GCP Secret Manager, mounted to Cloud Run |

### 2.3 Cloud Scheduler (Cron Jobs) — COMPLETE

All 4 cron jobs created 2026-03-16 via `gcloud scheduler jobs create http`. All use OIDC authentication with the Cloud Run service account.

| Job | Schedule | Target | Status |
|-----|----------|--------|--------|
| `process-anchors` | `*/5 * * * *` (every 5 min) | `POST /cron/process-anchors` | ENABLED |
| `webhook-retries` | `*/10 * * * *` (every 10 min) | `POST /cron/webhook-retries` | ENABLED |
| `generate-reports` | `0 * * * *` (hourly) | `POST /cron/generate-reports` | ENABLED |
| `credit-expiry` | `0 0 1 * *` (monthly) | `POST /cron/credit-expiry` | ENABLED |

**Auth:** OIDC token with audience `https://arkova-worker-kvojbeutfa-uc.a.run.app`, service account `270018525501-compute@developer.gserviceaccount.com`.

**Management:**
```bash
# List jobs
gcloud scheduler jobs list --project=arkova1 --location=us-central1

# Manually trigger a job
gcloud scheduler jobs run process-anchors --project=arkova1 --location=us-central1

# Pause/resume a job
gcloud scheduler jobs pause process-anchors --project=arkova1 --location=us-central1
gcloud scheduler jobs resume process-anchors --project=arkova1 --location=us-central1
```

### 2.4 Deployment Verification

**Cloud Run URL:** `https://arkova-worker-kvojbeutfa-uc.a.run.app`

> **Note:** `gcloud` may report both old and new revision URLs as aliases. The canonical URL above is stable.

```bash
# Health check (note: /health, NOT /api/health)
curl https://arkova-worker-kvojbeutfa-uc.a.run.app/health

# Expected: { "status": "ok", "timestamp": "..." }
```

**Status as of 2026-03-16:** Health endpoint verified and returning 200 OK. All secrets mounted via GCP Secret Manager.

## 3. Other Pre-Launch Manual Steps

| Task | Description | Who |
|------|-------------|-----|
| ~~Apply migrations 0052-0053~~ | ~~`supabase db push` against production~~ | ~~Ops~~ | ✅ DONE 2026-03-15 |
| ~~Stripe webhook~~ | ~~Register webhook endpoint~~ | ~~Ops~~ | ✅ DONE 2026-03-16 (`we_1TBHb6BBeICNeQqrolzWA2yj`) |
| ~~API_KEY_HMAC_SECRET~~ | ~~Generate + mount to Cloud Run~~ | ~~Ops~~ | ✅ DONE 2026-03-16 |
| ~~Vercel env vars~~ | ~~Set `VITE_APP_URL` in production~~ | ~~Ops~~ | ✅ DONE 2026-03-16 — `VITE_APP_URL=https://arkova-carson.vercel.app` (prod + dev) |
| ~~Vercel domains~~ | ~~Add custom domains to Vercel projects~~ | ~~Ops~~ | ✅ DONE 2026-03-16 — `app.arkova.ai` → arkova-carson, `arkova.ai` + `www.arkova.ai` → arkova-marketing |
| DNS — Namecheap | Set A records at Namecheap (registrar) pointing to Vercel | Ops | PENDING — see Section 3.1 |
| DNS — migration | Redirect `arkova.io` → `arkova.ai` (301) + cancel old Pro plan | Ops | PENDING |
| Vercel env — Sentry | Set `VITE_SENTRY_DSN` in Vercel production | Ops | PENDING — need Sentry DSN value |
| GCP secret — Sentry | Set `SENTRY_DSN` for worker in GCP Secret Manager | Ops | PENDING — need Sentry DSN value |
| Key rotation | Rotate Stripe live key → update GCP secret | Security | PENDING |
| Key rotation | Rotate Supabase service role key → update GCP secret | Security | PENDING |
| Seed data strip | Remove demo users from production Supabase before public launch | Ops | PENDING |

### 3.1 DNS Configuration (Namecheap)

Domains are added to Vercel but DNS records need to be set at the registrar (Namecheap — `pdns1/pdns2.registrar-servers.com`).

**Required A records:**

| Host | Type | Value | Project |
|------|------|-------|---------|
| `@` (arkova.ai) | A | `76.76.21.21` | arkova-marketing |
| `www` | A | `76.76.21.21` | arkova-marketing |
| `app` | A | `76.76.21.21` | arkova-carson |

**Alternative:** Change nameservers to Vercel DNS (`ns1.vercel-dns.com`, `ns2.vercel-dns.com`) for automatic configuration.

**To set at Namecheap:**
1. Log in to Namecheap → Domain List → arkova.ai → Manage → Advanced DNS
2. Add three A records above
3. Wait for DNS propagation (up to 48h, usually <1h)
4. Verify: `dig app.arkova.ai` should return `76.76.21.21`

## Change Log

| Date | Change |
|------|--------|
| 2026-03-15 | Initial creation — consolidates P7-TS-05 + MVP-01 operational items |
| 2026-03-16 | Updated: Stripe webhook COMPLETE (we_1TBHb6BBeICNeQqrolzWA2yj), API_KEY_HMAC_SECRET mounted, health endpoint corrected to /health, Cloud Run URL confirmed, remaining tasks itemized with status |
| 2026-03-16 | Cloud Scheduler: 4 cron jobs created (process-anchors, webhook-retries, generate-reports, credit-expiry). MVP-28 COMPLETE. |
| 2026-03-16 | Vercel: VITE_APP_URL set, domains added (app.arkova.ai, arkova.ai, www.arkova.ai). DNS instructions added (Section 3.1). |
