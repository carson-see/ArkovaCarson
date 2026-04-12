# Operational Runbook — Production Launch
_Last updated: 2026-03-24 | Stories: P7-TS-05, MVP-01_

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

### 1.3 Testnet 4 (Recommended for Testnet Launch)

**Why Testnet 4 over Signet:** More active network, consistent block production, better Mempool.space support. Same bitcoinjs-lib network params (`bitcoin.networks.testnet`), same address format (m/n... P2PKH).

| Step | Action | Who |
|------|--------|-----|
| 1 | Generate testnet4 keypair (or reuse signet WIF — same format) | Ops |
| 2 | Fund from faucet: `https://mempool.space/testnet4/faucet` | Ops |
| 3 | Set `BITCOIN_NETWORK=testnet4` in Cloud Run env | Ops |
| 4 | Set `BITCOIN_TREASURY_WIF` in Cloud Run env | Ops |
| 5 | Set `ENABLE_PROD_NETWORK_ANCHORING=true` in switchboard_flags | Ops |

**Mempool API:** Default URL is `https://mempool.space/testnet4/api` (no override needed). To use a custom endpoint, set `MEMPOOL_API_URL`.

**To switch from Signet to Testnet 4:**
1. Change `BITCOIN_NETWORK=testnet4` (from `signet`)
2. Reuse existing signet WIF (both use testnet params) or generate new keypair
3. Fund the address from the testnet4 faucet
4. Restart worker

### 1.4 Signet (Legacy — Already Verified)

- Treasury: `mx1zmGtQTghi4GWcJaV1oPwJ5TKhGfFpjs` (500,636 sats)
- E2E broadcast TX: `b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57`
- Set `BITCOIN_NETWORK=signet` + `BITCOIN_TREASURY_WIF` for signet deployment
- **Note:** Signet is still fully supported. Testnet 4 is recommended for new deployments.

## 2. Worker Production Deployment (MVP-01)

**Code status:** COMPLETE (Dockerfile, .env.example, deploy workflow, health check endpoint)

**Deployment targets:** GCP Cloud Run (primary) or Railway (alternative — see Section 7).

### 2.1 Cloud Run Environment Variables

Set these in GCP Cloud Run configuration (or via `gcloud run services update`). For Railway, set via `railway variables set`:

| Variable | Source | Notes |
|----------|--------|-------|
| `SUPABASE_URL` | Supabase dashboard | `https://vzwyaatejekddvltxyye.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API | Rotate after initial setup |
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys | Use live key for production |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard → after webhook registration | See step 2.2 |
| `BITCOIN_TREASURY_WIF` | Generated via `generate-signet-keypair.ts` | For signet; KMS for mainnet |
| `BITCOIN_NETWORK` | `testnet4` for testnet launch (recommended) | `mainnet` when ready |
| `ENABLE_PROD_NETWORK_ANCHORING` | `true` | Gates real Bitcoin calls |
| `FRONTEND_URL` | `https://app.arkova.ai` | CORS origin (must match production domain) |
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

**Auth fallback (SCRUM-640, PR #356):** The worker's `verifyCronAuth` middleware accepts **either** auth method:

1. `X-Cron-Secret` header (matched against `CRON_SECRET` env var, constant-time comparison)
2. `Authorization: Bearer <OIDC token>` (verified against Google JWKS with audience = `CRON_OIDC_AUDIENCE`)

Production fails secure only if **neither** `CRON_SECRET` nor `CRON_OIDC_AUDIENCE` is configured. Previously the middleware bailed at `!config.cronSecret` even when OIDC was set, causing persistent 401s on revisions 00286–00290. Google JWKS is memoized at module scope to avoid re-fetching on every request.

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

## 3. OPS-01: Apply Migrations 0059–0109 to Production Supabase

**Priority:** CRITICAL — blocks all P8 AI features, GDPR deletion, and security hardening in production.

**Migration status:** 109 total migrations (0001-0109, with 0033+0078 skipped, 0068 split into 0068a/0068b). Migrations 0001-0107 applied to production.

**Migrations pending (sample of key ranges):**

| # | File | Description | Dependencies |
|---|------|-------------|--------------|
| 0059 | `0059_ai_credits_usage.sql` | AI credits + usage events tables, RPCs | None |
| 0060 | `0060_credential_embeddings.sql` | pgvector embeddings table + HNSW index + org-scoped RLS | pgvector extension |
| 0061 | `0061_gdpr_pii_erasure.sql` | PII erasure RPCs + audit_events null trigger + backfill | None |
| 0062 | `0062_security_hardening_high.sql` | GRANT on 13 tables, ORG_ADMIN RLS, parameterized search RPC | None |
| 0063 | `0063_security_sprint2.sql` | CSP headers, rate limit tables, additional hardening | None |
| 0064 | `0064_p8_phase2_ai_intelligence.sql` | AI feedback, integrity scoring, review queue tables | 0060 |
| 0065 | `0065_account_deletion.sql` | Account deletion flow + cascade policies | 0061 |
| 0090 | `0090_prompt_version_tracking.sql` | AI prompt version tracking table + RLS | None |
| 0091 | `0091_ai_eval_golden_dataset.sql` | Golden dataset + scoring tables for AI eval | None |
| 0092-0097 | Various | AI infrastructure, fraud audit, batch anchoring support | Varies |
| 0098 | `0098_orphan_anchor_check.sql` | Orphan anchor detection + cleanup RPC | None |
| 0099-0107 | Various | x402 payments, CLE verification, Nessie RAG, attestations | Varies |
| 0108-0109 | Uncommitted | New work in progress | Varies |

**Steps:**

```bash
# 1. Verify current migration state
supabase migration list --project-ref vzwyaatejekddvltxyye

# 2. Back up production database (Supabase dashboard → Database → Backups)

# 3. Apply migrations one at a time (recommended for safety)
supabase db push --project-ref vzwyaatejekddvltxyye

# 4. If supabase db push applies all at once, verify each:
#    Check that pgvector extension is enabled (required by 0060)
#    Verify new tables: credential_embeddings, ai_feedback, ai_integrity_scores, ai_review_queue
#    Verify new RPCs: erase_user_pii, search_public_credentials, cleanup_expired_data

# 5. Regenerate types after migration
supabase gen types typescript --project-ref vzwyaatejekddvltxyye > src/types/database.types.ts

# 6. Verify RLS policies are active
#    Run: SELECT tablename, policyname FROM pg_policies ORDER BY tablename;
```

**Rollback:** Each migration file contains `-- ROLLBACK:` comments at the bottom with compensating SQL.

**Verification queries:**

```sql
-- Verify 0060: pgvector + embeddings table
SELECT * FROM pg_extension WHERE extname = 'vector';
SELECT count(*) FROM information_schema.tables WHERE table_name = 'credential_embeddings';

-- Verify 0061: PII erasure RPCs exist
SELECT proname FROM pg_proc WHERE proname IN ('erase_user_pii', 'null_audit_pii_fields');

-- Verify 0062: GRANT on tables
SELECT grantee, table_name, privilege_type FROM information_schema.table_privileges
WHERE grantee = 'authenticated' AND table_schema = 'public' ORDER BY table_name;

-- Verify 0065: Account deletion
SELECT proname FROM pg_proc WHERE proname = 'delete_user_account';
```

## 4. OPS-02: Strip Demo Seeds from Production

**Priority:** CRITICAL — demo accounts with known passwords (`Demo1234!`) are live in production.

**Script:** `scripts/strip-demo-seeds.sql` (177 lines, reviewed and safe)

**Steps:**

```bash
# 1. Review the script (already reviewed — targets 7 demo email patterns)
cat scripts/strip-demo-seeds.sql

# 2. Run against production via Supabase SQL Editor or psql
#    Option A: Supabase Dashboard → SQL Editor → paste + run
#    Option B: psql connection string from Supabase dashboard
psql "postgresql://postgres:[PASSWORD]@db.vzwyaatejekddvltxyye.supabase.co:5432/postgres" \
  -f scripts/strip-demo-seeds.sql

# 3. Verify no demo accounts remain
#    The script outputs a completion report via RAISE NOTICE
#    Additionally verify:
SELECT email FROM auth.users WHERE email LIKE '%arkova.local' OR email LIKE '%demo.arkova.io';
# Expected: 0 rows
```

**Demo accounts targeted:**
- `admin_demo@arkova.local`
- `user_demo@arkova.local`
- `beta_admin@betacorp.local`
- `admin@umich-demo.arkova.io`
- `registrar@umich-demo.arkova.io`
- `admin@midwest-medical.arkova.io`
- `individual@demo.arkova.io`

**Safety:** Script runs inside a transaction. If any step fails, all changes are rolled back.

## 5. OPS-03: Set Sentry DSN Environment Variables

**Priority:** HIGH — error tracking is configured in code but not connected to Sentry.

**Prerequisites:** Create a Sentry project at https://sentry.io (or self-hosted instance).

| Project | Platform | Suggested Name |
|---------|----------|----------------|
| Frontend | React (Browser) | `arkova-frontend` |
| Worker | Node.js (Express) | `arkova-worker` |

**Steps:**

```bash
# 1. Get DSN values from Sentry → Project Settings → Client Keys (DSN)
#    Frontend DSN: https://xxx@o123.ingest.sentry.io/456
#    Worker DSN: https://yyy@o123.ingest.sentry.io/789

# 2. Set frontend DSN on Vercel
vercel env add VITE_SENTRY_DSN production
# Paste the frontend DSN value

# 3. Set worker DSN on Cloud Run via GCP Secret Manager
echo -n "https://yyy@o123.ingest.sentry.io/789" | \
  gcloud secrets create sentry-dsn \
    --project=arkova1 \
    --data-file=- \
    --replication-policy=automatic

# 4. Mount the secret to Cloud Run
gcloud run services update arkova-worker \
  --project=arkova1 \
  --region=us-central1 \
  --update-secrets=SENTRY_DSN=sentry-dsn:latest

# 5. Redeploy Vercel to pick up new env var
vercel --prod

# 6. Verify — trigger a test error and check Sentry dashboard
```

## 6. OPS-04: Configure Sentry Source Map Upload

**Priority:** HIGH — stack traces in production are obfuscated without source maps.

**Code status:** COMPLETE — `vite.config.ts` already has `sentryVitePlugin` configured. Only needs auth token.

**Steps:**

```bash
# 1. Create a Sentry auth token
#    Sentry → Settings → Auth Tokens → Create New Token
#    Scopes needed: project:releases, org:read

# 2. Set auth token in Vercel (used during build)
vercel env add SENTRY_AUTH_TOKEN production
# Paste the auth token

# 3. Optionally set org/project if different from defaults
vercel env add SENTRY_ORG production    # default: 'arkova'
vercel env add SENTRY_PROJECT production # default: 'arkova-frontend'

# 4. Redeploy — source maps will upload automatically during build
vercel --prod

# 5. Verify — check Sentry → Releases for new release with source maps
#    The plugin auto-deletes .map files from dist/ after upload (security best practice)
```

**Worker source maps:** The worker runs on Cloud Run (not Vite). Source maps for the worker are not automatically uploaded. For worker stack traces, either:
- Upload manually via `sentry-cli releases files <release> upload-sourcemaps ./dist`
- Add `@sentry/esbuild-plugin` to the worker build if using esbuild

## 7. Railway Deployment (Alternative to Cloud Run)

A `railway.json` configuration exists in `services/worker/` for deploying the worker to Railway as an alternative to GCP Cloud Run.

### Railway Setup

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and link project
railway login
cd services/worker
railway link

# Deploy
railway up
```

### Railway Environment Variables

Set the same environment variables listed in Section 2.1 via the Railway dashboard or CLI:

```bash
railway variables set SUPABASE_URL=https://vzwyaatejekddvltxyye.supabase.co
railway variables set BITCOIN_NETWORK=testnet4
# ... (all other variables from Section 2.1)
```

### Railway vs. Cloud Run

| Feature | Cloud Run | Railway |
|---------|-----------|---------|
| Auto-scaling | Yes (0 to N) | Yes (1 to N) |
| Cron scheduling | Cloud Scheduler (external) | Built-in cron support |
| Secret management | GCP Secret Manager | Railway variables (encrypted) |
| Region | us-central1 | US-West (default) |
| Cost | Pay-per-request | Usage-based |

> **Note:** Railway is suitable for staging/preview environments and as a backup deployment target. Production currently targets Cloud Run.

## 8. Fee Spike Monitoring Procedure

### When to Investigate

- Worker logs `fee_spike_skipped` events
- Anchors remain in `PENDING` status longer than 30 minutes
- `MAX_FEE_SAT_PER_VBYTE` threshold is being hit repeatedly

### Monitoring Steps

1. **Check current fee rates:**
   ```bash
   curl https://mempool.space/api/v1/fees/recommended
   ```

2. **Check worker audit events:**
   ```sql
   SELECT * FROM audit_events
   WHERE event_type = 'fee_spike_skipped'
   ORDER BY created_at DESC LIMIT 20;
   ```

3. **Check stuck transactions:**
   ```sql
   SELECT id, chain_tx_id, status, updated_at
   FROM anchors
   WHERE status = 'SUBMITTED'
   AND updated_at < now() - interval '60 minutes';
   ```

4. **Adjust fee threshold if needed:**
   ```bash
   # Temporarily raise the max fee (Cloud Run)
   gcloud run services update arkova-worker \
     --update-env-vars MAX_FEE_SAT_PER_VBYTE=100

   # Or on Railway
   railway variables set MAX_FEE_SAT_PER_VBYTE=100
   ```

5. **After fee spike subsides:** Reset `MAX_FEE_SAT_PER_VBYTE` to default (50).

## 9. Other Pre-Launch Manual Steps

| Task | Description | Who | Status |
|------|-------------|-----|--------|
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

## 10. Supabase Disaster Recovery Plan (DEP-01)

**Priority:** P0 — Supabase is a total SPOF (auth, data, RLS, RPC all go down together).

### 10.1 Recovery Targets

| Metric | Target | Rationale |
|--------|--------|-----------|
| **RTO** (Recovery Time Objective) | 4 hours | Time to restore from backup to a new Supabase project |
| **RPO** (Recovery Point Objective) | 24 hours | Nightly pg_dump — max 24h data loss |

### 10.2 Backup Strategy

**Layer 1: Supabase-managed backups + PITR** (automatic, included in Pro plan)
- Daily backups retained for 7 days
- Point-in-Time Recovery available
- Limitation: lives inside Supabase infrastructure — not independent

**Layer 2: Nightly pg_dump to GCS** (independent backup)

```bash
# GCS bucket: arkova-db-backups (arkova1 project, 90-day retention lifecycle policy)
# Cloud Run job runs nightly at 03:00 UTC via Cloud Scheduler

# Manual backup (emergency):
pg_dump "$SUPABASE_POOLER_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  -f "arkova-backup-$(date +%Y%m%d-%H%M%S).dump"

# Upload to GCS:
gsutil cp arkova-backup-*.dump gs://arkova-db-backups/manual/
```

### 10.3 Restore Procedure

```bash
# 1. Create a new Supabase project (or use disaster recovery project)
#    Dashboard: https://supabase.com/dashboard → New Project

# 2. Download the latest backup from GCS
gsutil ls -l gs://arkova-db-backups/nightly/ | tail -5
gsutil cp gs://arkova-db-backups/nightly/LATEST_BACKUP.dump .

# 3. Restore to new project
pg_restore \
  --dbname="$NEW_SUPABASE_POOLER_URL" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  LATEST_BACKUP.dump

# 4. Verify row counts match expected
psql "$NEW_SUPABASE_POOLER_URL" -c "
  SELECT 'anchors' AS tbl, count(*) FROM anchors
  UNION ALL SELECT 'organizations', count(*) FROM organizations
  UNION ALL SELECT 'profiles', count(*) FROM profiles
  UNION ALL SELECT 'audit_events', count(*) FROM audit_events;
"

# 5. Swap connection strings
#    a. Update Cloud Run env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#    b. Update Vercel env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
#    c. Redeploy both services

# 6. Verify auth works (login with known test account)
# 7. Verify anchoring pipeline (submit test anchor, confirm SECURED)
```

### 10.4 Monitoring

- Backup job sends Sentry alert on failure (via Cloud Run job error handler)
- GCS bucket has `nearline` storage class for cost efficiency
- Monthly: verify backup integrity by restoring to a test project

---

## 11. Cloudflare Tunnel Failover Procedure (DEP-02)

**Priority:** P0 — Cloudflare Tunnel (`cloudflared`) is the sole ingress path to the worker.

### 11.1 Detecting a Tunnel Outage

```bash
# Check tunnel status via Cloudflare dashboard
# Dashboard → Zero Trust → Networks → Tunnels → arkova-worker

# Or from the worker host:
cloudflared tunnel info arkova-worker

# Health check (if tunnel is up, this succeeds):
curl -f https://worker.arkova.ai/health
# If 502/504/timeout → tunnel is down
```

### 11.2 Failover: Direct Cloud Run URL Bypass

**When to use:** Cloudflare Tunnel is confirmed down, anchoring/billing is blocked, estimated tunnel recovery > 30 minutes.

**Security trade-offs of bypass mode:**
- Zero Trust access policies are bypassed
- No Cloudflare WAF/DDoS protection
- Cloud Run URL is publicly accessible (protected only by IAM)

**Steps:**

```bash
# 1. Activate direct Cloud Run access (IAM allowlist)
gcloud run services add-iam-policy-binding arkova-worker \
  --project=arkova1 \
  --region=us-central1 \
  --member="allUsers" \
  --role="roles/run.invoker"

# 2. Update cron jobs to target Cloud Run URL directly
#    (instead of going through the tunnel)
CLOUD_RUN_URL="https://arkova-worker-270018525501.us-central1.run.app"
for JOB in process-anchors webhook-retries generate-reports credit-expiry \
           batch-anchor batch-confirm embed-records fetch-sec fetch-court \
           fetch-openstates fetch-sam expiry-alerts; do
  gcloud scheduler jobs update http "$JOB" \
    --project=arkova1 \
    --location=us-central1 \
    --uri="${CLOUD_RUN_URL}/cron/${JOB}"
done

# 3. Update FRONTEND_URL if needed (CORS)
#    If the frontend calls the tunnel URL, temporarily update CORS_ALLOWED_ORIGINS
gcloud run services update arkova-worker \
  --project=arkova1 \
  --region=us-central1 \
  --update-env-vars "CORS_ALLOWED_ORIGINS=*"

# 4. Verify worker is reachable
curl "${CLOUD_RUN_URL}/health"
```

### 11.3 Rollback (Tunnel Recovered)

```bash
# 1. Verify tunnel is healthy
curl -f https://worker.arkova.ai/health

# 2. Revoke public access to Cloud Run
gcloud run services remove-iam-policy-binding arkova-worker \
  --project=arkova1 \
  --region=us-central1 \
  --member="allUsers" \
  --role="roles/run.invoker"

# 3. Restore cron job URLs to tunnel endpoint
TUNNEL_URL="https://worker.arkova.ai"
for JOB in process-anchors webhook-retries generate-reports credit-expiry \
           batch-anchor batch-confirm embed-records fetch-sec fetch-court \
           fetch-openstates fetch-sam expiry-alerts; do
  gcloud scheduler jobs update http "$JOB" \
    --project=arkova1 \
    --location=us-central1 \
    --uri="${TUNNEL_URL}/cron/${JOB}"
done

# 4. Restore CORS
gcloud run services update arkova-worker \
  --project=arkova1 \
  --region=us-central1 \
  --update-env-vars "CORS_ALLOWED_ORIGINS=https://app.arkova.ai"

# 5. Verify end-to-end flow through tunnel
curl -f https://worker.arkova.ai/health
```

---

## Change Log

| Date | Change |
|------|--------|
| 2026-03-15 | Initial creation — consolidates P7-TS-05 + MVP-01 operational items |
| 2026-03-16 | Updated: Stripe webhook COMPLETE (we_1TBHb6BBeICNeQqrolzWA2yj), API_KEY_HMAC_SECRET mounted, health endpoint corrected to /health, Cloud Run URL confirmed, remaining tasks itemized with status |
| 2026-03-16 | Cloud Scheduler: 4 cron jobs created (process-anchors, webhook-retries, generate-reports, credit-expiry). MVP-28 COMPLETE. |
| 2026-03-16 | Vercel: VITE_APP_URL set, domains added (app.arkova.ai, arkova.ai, www.arkova.ai). DNS instructions added (Section 3.1). |
| 2026-03-16 | Bitcoin Testnet 4 migration: added Section 1.3 (Testnet 4 setup), renamed Section 1.3 → 1.4 (Signet legacy). Default network changed from signet to testnet4. |
| 2026-03-16 | Added OPS-01 through OPS-04 sections with exact commands: migration apply, demo seed strip, Sentry DSN setup, source map upload. |
| 2026-03-24 | Updated migration tracking to 109 migrations (0090-0109 range added). Added Railway deployment instructions (Section 7). Added fee spike monitoring procedure (Section 8). Updated Cloud Run references to include Railway as deployment target. |
| 2026-04-12 | DEP-01: Added Supabase DR plan (Section 10) — RTO 4h, RPO 24h, GCS backup, restore runbook. DEP-02: Added Cloudflare Tunnel failover procedure (Section 11) — direct Cloud Run bypass with security compensating controls. |
