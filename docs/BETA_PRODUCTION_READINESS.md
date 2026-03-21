# Arkova Beta / Production Readiness Report

_Generated: 2026-03-17 | Updated: 2026-03-20 | Branch: `main`_

> **Note:** This document was originally generated 2026-03-17. Since then, Beta Sprints 1-3 (BETA-01 through BETA-13) were completed and merged (PRs #98, #100, #101), the Bitcoin network was switched to Signet with 6+ confirmed transactions, migration 0072 was added, and test counts grew to 1,979. See HANDOFF.md for the latest state.

---

## Executive Summary

Arkova's codebase is **code-complete for beta launch**. All 24 audit findings are resolved, all 12 security findings are fixed, all 29 UAT bugs are closed, and the full test suite (1,979 tests: 936 frontend + 1,043 worker) passes green. 72 migrations (0001-0072). The remaining blockers are **operational infrastructure tasks** — no code changes required.

---

## 1. What's Code-Complete and Ready

### Core Platform
| Feature | Tests | Status |
|---------|-------|--------|
| Document fingerprinting (client-side SHA-256) | 27 | Ready |
| Anchor creation + management | 42 | Ready |
| Public verification portal (5-section display) | 18 | Ready |
| Org admin credential issuance | 15 | Ready |
| CSV bulk upload | 12 | Ready |
| PDF + JSON proof downloads | 8 | Ready |
| Credential templates | 14 | Ready |
| Onboarding flow (role selection + org creation) | 11 | Ready |

### Authentication & Authorization
| Feature | Tests | Status |
|---------|-------|--------|
| Supabase Auth (email + Google OAuth) | 16 | Ready |
| AuthGuard + RouteGuard | 9 | Ready |
| RLS on all 32+ tables | 47 | Ready |
| Role immutability trigger | 4 | Ready |
| GDPR erasure RPCs (anonymize_user_data) | 6 | Ready |

### Billing & Subscriptions
| Feature | Tests | Status |
|---------|-------|--------|
| Stripe integration (webhooks + SDK) | 24 | Ready |
| Plan change/upgrade/downgrade | 8 | Ready |
| Credit system (anchor + AI credits) | 17 | Ready |
| Entitlements per subscription tier | 6 | Ready |

### Worker Service (Node.js + Express)
| Feature | Tests | Status |
|---------|-------|--------|
| Anchoring job processor | 34 | Ready |
| Webhook delivery engine | 22 | Ready |
| Cron jobs (credit expiry, data retention) | 14 | Ready |
| Verification API (v1) | 28 | Ready |
| Health check (structured aggregation) | 6 | Ready |
| Rate limiting (anonymous + API key tiers) | 12 | Ready |

### AI Intelligence (P8)
| Feature | Tests | Status |
|---------|-------|--------|
| Gemini extraction (circuit breaker + retry) | 13 | Ready |
| Client-side OCR + PII stripping | 27 | Ready |
| AI credit tracking + allocation | 17 | Ready |
| pgvector semantic search | 20 | Ready |
| Integrity scoring (5 dimensions) | 10 | Ready |
| Admin review queue | 8 | Ready |
| Extraction feedback loop | 8 | Ready |
| AI reports dashboard | 6 | Ready |
| Provider abstraction (Gemini/CF/Mock) | 16 | Ready |

### Edge Workers (Cloudflare)
| Feature | Tests | Status |
|---------|-------|--------|
| Batch processing queue | 4 | Ready |
| R2 report storage + signed URLs | 4 | Ready |
| University directory crawler | 5 | Ready |
| AI fallback provider | 4 | Ready |
| MCP server (Streamable HTTP + OAuth) | 8 | Ready |

### Infrastructure
| Feature | Tests | Status |
|---------|-------|--------|
| Sentry error tracking (PII scrubbing) | 30 | Ready |
| CI/CD pipeline (GitHub Actions) | — | Ready |
| Route-level code splitting (lazy loading) | — | Ready |
| Error boundaries (sub-route isolation) | 6 | Ready |
| Bitcoin chain client (Signet/Testnet4) | 279 | Ready (code) |

### Database
- **67 migrations** (0001-0067, 0033 skipped)
- **32+ tables** with full RLS coverage
- **12 composite indexes** for performance (migration 0067)
- **Audit trail** (append-only, PII-scrubbed)
- **Data retention** (cleanup_expired_data RPC + cron)

---

## 2. Operational Tasks Remaining (OPS-01 through OPS-07)

These are infrastructure/ops tasks — no code changes needed. Each has exact steps.

### OPS-01: Apply Migrations 0059-0067 to Production Supabase (CRITICAL)

```bash
# Connect to production Supabase
supabase link --project-ref vzwyaatejekddvltxyye

# Apply pending migrations (0059-0067)
supabase db push

# Regenerate TypeScript types from production schema
supabase gen types typescript --project-id vzwyaatejekddvltxyye > src/types/database.types.ts

# Verify migration count
supabase migration list
```

**Impact:** Enables AI features, performance indexes, audit fixes, GDPR RPCs in production.
**Risk:** LOW — all migrations tested locally with `supabase db reset`. Rollback comments in each file.
**Dependencies:** None.

### OPS-02: Run `scripts/strip-demo-seeds.sql` on Production (CRITICAL)

```bash
# Review the script first
cat scripts/strip-demo-seeds.sql

# Execute against production (via Supabase SQL Editor or psql)
supabase db execute --project-ref vzwyaatejekddvltxyye < scripts/strip-demo-seeds.sql
```

**Impact:** Removes demo users (admin_demo, user_demo, beta_admin) from production.
**Risk:** LOW — script is idempotent, only deletes known demo accounts.

### OPS-03: Set Sentry DSN Env Vars (HIGH)

```bash
# Vercel (frontend)
vercel env add VITE_SENTRY_DSN production

# Cloud Run (worker)
gcloud run services update arkova-worker \
  --set-env-vars SENTRY_DSN=<dsn>,SENTRY_SAMPLE_RATE=0.1
```

**Impact:** Enables error tracking + performance monitoring in production.
**Risk:** NONE — Sentry SDK already initialized with graceful fallback when DSN missing.

### OPS-04: Sentry Source Map Upload Plugin (MEDIUM)

```bash
# Install Vite plugin
npm install @sentry/vite-plugin --save-dev

# Add to vite.config.ts build plugins:
# sentryVitePlugin({ org: "arkova", project: "arkova-frontend", authToken: process.env.SENTRY_AUTH_TOKEN })

# Set auth token in CI
gh secret set SENTRY_AUTH_TOKEN --body <token>
```

**Impact:** Enables readable stack traces in Sentry (currently minified).
**Risk:** LOW — build-time only, doesn't affect runtime.

### OPS-05: AWS KMS Key Provisioning (CRITICAL for mainnet)

```bash
# Create KMS key for Bitcoin transaction signing
aws kms create-key \
  --description "Arkova mainnet Bitcoin signing key" \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_SECG_P256K1

# Create alias
aws kms create-alias \
  --alias-name alias/arkova-btc-mainnet \
  --target-key-id <key-id>

# Grant worker service account access
aws kms create-grant \
  --key-id <key-id> \
  --grantee-principal <worker-service-role-arn> \
  --operations Sign
```

**Impact:** Required for mainnet Bitcoin anchoring. Testnet uses WIF key (already working).
**Risk:** MEDIUM — key management is critical. Follow AWS KMS best practices.
**Dependencies:** AWS account with KMS access.

### OPS-06: Mainnet Treasury Funding (CRITICAL for mainnet)

```
1. Generate mainnet treasury address from KMS public key
2. Fund with initial BTC (recommend 0.01 BTC for ~500 OP_RETURN transactions)
3. Set BITCOIN_NETWORK=mainnet in Cloud Run env vars
4. Set ENABLE_PROD_NETWORK_ANCHORING=true
5. Monitor via worker /api/treasury/status endpoint (platform admin only)
```

**Impact:** Enables production Bitcoin anchoring.
**Risk:** HIGH — involves real funds. Start with small amount, monitor closely.
**Dependencies:** OPS-05 (KMS key).

### OPS-07: Key Rotation (Stripe + Supabase Service Role) (MEDIUM)

```bash
# Rotate Stripe webhook secret
# 1. Create new webhook endpoint in Stripe Dashboard
# 2. Update STRIPE_WEBHOOK_SECRET in Cloud Run
# 3. Verify webhook delivery in Stripe Dashboard
# 4. Delete old webhook endpoint

# Rotate Supabase service role key
# 1. Go to Supabase Dashboard > Settings > API
# 2. Regenerate service_role key
# 3. Update SUPABASE_SERVICE_ROLE_KEY in Cloud Run + any CI secrets
# 4. Verify worker health check passes
```

**Impact:** Security hygiene. Current keys may have been exposed during development.
**Risk:** MEDIUM — brief downtime possible if keys updated out of order.

---

## 3. Recommended Beta Testing Plan

### Phase 1: Internal Testing (Week 1)
- [ ] Apply OPS-01 (migrations) and OPS-02 (seed strip) to production
- [ ] Set OPS-03 (Sentry DSN) for error visibility
- [ ] Team members test all core flows:
  - Individual: sign up → anchor document → verify → download proof
  - Org admin: create org → invite member → issue credential → bulk upload
  - Public: verify via public URL → proof download
- [ ] Monitor Sentry for errors
- [ ] Verify Stripe webhook delivery (test mode → live mode transition)

### Phase 2: Closed Beta (Weeks 2-3)
- [ ] Invite 5-10 trusted users (mix of individual + org admin)
- [ ] Provide feedback form (Formspree or in-app)
- [ ] Monitor:
  - Error rates in Sentry
  - Webhook delivery success rates
  - AI extraction accuracy (review queue)
  - Credit consumption patterns
- [ ] Fix any P0/P1 bugs found

### Phase 3: Open Beta (Weeks 4-6)
- [ ] Enable self-service sign-up
- [ ] Monitor at scale:
  - Database performance (indexes from AUDIT-17)
  - Health check endpoint (`/health?detailed=true`)
  - Rate limiting effectiveness
  - Bitcoin anchoring queue depth
- [ ] Complete OPS-05/06 for mainnet (if testnet validation successful)
- [ ] GEO stories (GEO-03 privacy/terms, GEO-08 content expansion)

### Phase 4: Production Launch
- [ ] OPS-07 key rotation
- [ ] OPS-04 source maps
- [ ] DNS custom domain (`app.arkova.io`)
- [ ] SOC 2 evidence collection (CI logs, RLS tests, audit events)
- [ ] Marketing push

---

## 4. Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Migration failure on production | HIGH | LOW | All tested locally; rollback comments in each migration. `supabase db push` is transactional. |
| Bitcoin mainnet key compromise | CRITICAL | LOW | AWS KMS with IAM, no raw keys. Treasury is non-custodial (no user funds). |
| Stripe webhook misconfiguration | HIGH | MEDIUM | Test mode → live mode transition. Verify signatures. Idempotent handlers. |
| AI provider rate limits (Gemini) | MEDIUM | MEDIUM | Circuit breaker (5 failures/60s), CF Workers AI fallback, credit-based throttling. |
| Database performance under load | MEDIUM | LOW | 12 composite indexes (AUDIT-17), RLS performance tested, pgvector HNSW indexes. |
| GDPR compliance gap | HIGH | LOW | PII erasure RPCs tested, audit trail anonymization, data retention cron. |
| Sentry PII leakage | MEDIUM | LOW | beforeSend scrubbing in both frontend + worker. Tested with 30 tests. |

### Residual Items (Non-Blocking)

| Item | Priority | Notes |
|------|----------|-------|
| Frontend `as any` casts (13 in src/) | LOW | Auto-fixed when OPS-01 type regeneration runs |
| Sidebar.tsx TODO (platform_admin flag) | LOW | Cosmetic — current implementation works |
| GEO score 72→80 target | MEDIUM | 5 not-started GEO stories (post-launch) |
| MVP-12 Dark mode toggle | LOW | Post-launch polish |
| MVP-20 LinkedIn badge integration | LOW | Post-launch feature |

---

## 5. Verification Summary

| Check | Result |
|-------|--------|
| TypeScript (`tsc --noEmit`) | PASS |
| ESLint (frontend + worker) | PASS |
| Frontend tests (97 suites, 867 tests) | PASS |
| Worker tests (60 suites, 947 tests) | PASS |
| Copy lint (banned terms) | PASS |
| Security findings (12/12) | ALL FIXED |
| UAT bugs (29/29) | ALL FIXED |
| Audit findings (24/24) | ALL RESOLVED |
| RLS coverage | ALL tables |
| Migration integrity | 67 files, all apply cleanly |

---

**Verdict: READY FOR BETA LAUNCH** pending completion of OPS-01 (migrations) and OPS-02 (seed strip). Mainnet launch additionally requires OPS-05 (KMS) and OPS-06 (treasury funding).
