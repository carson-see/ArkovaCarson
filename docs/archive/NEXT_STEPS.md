# Arkova — 3-Phase Execution Plan
_Last updated: 2026-03-12 | Author: Audit Deliverable 7_

## Overview

This plan takes Arkova from current state (~63% story completion) to production launch and beyond. Three phases, ordered by dependency and risk.

---

## Phase 1: Production Launch (Target: 1–2 weeks)

**Goal:** Ship the credentialing MVP on mainnet with real payments.

### 1A — Worker Deployment (MVP-01) — CRITICAL PATH

| Task | Detail | Estimate |
|------|--------|----------|
| Create Dockerfile for `services/worker/` | Multi-stage Node.js build, expose port 3001 | 2h |
| Deploy to Railway/Fly.io/Render | Pick provider, configure env vars, health check | 4h |
| CI/CD pipeline (`.github/workflows/deploy-worker.yml`) | Auto-deploy on main push, env secrets | 2h |
| Verify worker ↔ Supabase connectivity | Service role key, RLS bypass confirmed | 1h |
| Verify worker ↔ Stripe webhook delivery | Endpoint URL in Stripe dashboard, signature validation | 1h |

**Blocker:** Nothing else works in production without this. Stripe webhooks, anchor processing, cron jobs all depend on the worker.

### 1B — Bitcoin Mainnet (CRIT-2 Operational)

| Task | Detail | Estimate |
|------|--------|----------|
| Provision AWS KMS asymmetric key | Follow `docs/confluence/14_kms_operations.md` | 2h |
| Configure KMS IAM policy for worker | Least-privilege: `kms:Sign`, `kms:GetPublicKey` only | 1h |
| Fund mainnet treasury wallet | Transfer BTC, verify balance via `check-signet-balance.ts` (adapted for mainnet) | 1h |
| Set `BITCOIN_NETWORK=mainnet` + `ENABLE_PROD_NETWORK_ANCHORING=true` | Feature flag flip | 15m |
| Smoke test: anchor one document end-to-end on mainnet | Full flow from UI to on-chain confirmation | 1h |

### 1C — Stripe Completion (CRIT-3 Remaining)

| Task | Detail | Estimate |
|------|--------|----------|
| Plan change handler (`customer.subscription.updated`) | `services/worker/src/stripe/handlers.ts` | 3h |
| Plan downgrade/cancel handler (`customer.subscription.deleted`) | Graceful degradation, keep existing records | 2h |
| `useBilling` plan change mutations | Frontend hooks for upgrade/downgrade UI | 2h |
| Settings page plan management UI | Show current plan, upgrade/downgrade buttons | 3h |

### 1D — Legal & Compliance (MVP-03)

| Task | Detail | Estimate |
|------|--------|----------|
| Create `PrivacyPage.tsx`, `TermsPage.tsx`, `ContactPage.tsx` | Static content pages | 3h |
| Add routes to `routes.ts` and `App.tsx` | Public routes, no auth required | 30m |
| Wire footer links in `MarketingPage.tsx` | Currently point to `/privacy`, `/terms`, `/contact` | 15m |

### 1E — Production Infrastructure

| Task | Detail | Estimate |
|------|--------|----------|
| Supabase production project | Provision Pro-tier, configure RLS, run migrations | 2h |
| Custom domain (`app.arkova.io`) | DNS + Vercel config | 1h |
| Strip seed/demo data | Remove demo users from production | 30m |
| Environment variable audit | Ensure all env vars set, no dev values leaked | 1h |
| Favicon + OG meta tags (BUG-AUDIT-03) | Brand assets in `public/`, `<meta>` tags in `index.html` | 1h |

**Phase 1 Total Estimate: ~30–35 hours of focused engineering**

---

## Phase 2: Polish & Hardening (Target: 2–4 weeks after launch)

**Goal:** Production stability, user experience improvements, security hardening.

### 2A — UX Critical Fixes

| Task | Story | Estimate |
|------|-------|----------|
| Toast notification system (BUG-AUDIT-01) | MVP-09 | 3h |
| Error boundary + 404 page | MVP-05 | 2h |
| Onboarding progress stepper | MVP-08 | 3h |
| Loading skeleton states | MVP-06 | 4h |
| Empty state illustrations (records, org, dashboard) | MVP-07 | 3h |
| Mobile responsive pass | MVP-12 | 6h |

### 2B — Deferred Hardening (DH stories)

| Task | Story | Priority |
|------|-------|----------|
| Feature flag hot-reload | DH-01 | Medium |
| Advisory lock for `bulk_create_anchors` | DH-02 | High |
| Webhook circuit breaker | DH-04 | Medium |
| Chain index cache TTL | DH-05 | Low |
| `MempoolFeeEstimator` request timeout | DH-07 | Medium |
| Rate limiting for `check_anchor_quota` | DH-08 | High |
| `UtxoProvider` retry logic | DH-09 | Medium |
| `useEntitlements` realtime subscription | DH-10 | Low |
| Worker RPC structured logging | DH-11 | Medium |
| Webhook dead letter queue | DH-12 | Low |

### 2C — Verification Widget (P6-TS-03)

| Task | Detail | Estimate |
|------|--------|----------|
| Bundle `VerificationWidget.tsx` as standalone embed | Separate Vite build target, output `arkova-verify.js` | 4h |
| Embed documentation page | Integration guide for third-party sites | 2h |

### 2D — Monitoring & Observability

| Task | Detail | Estimate |
|------|--------|----------|
| Sentry integration (frontend + worker) | Error tracking, source maps | 3h |
| Uptime monitoring (worker health endpoint) | External ping service | 1h |
| Anchor processing latency dashboard | Supabase or Grafana metrics | 3h |
| Stripe webhook delivery monitoring | Alert on repeated failures | 2h |

**Phase 2 Total Estimate: ~45–55 hours**

---

## Phase 3: Growth & API (Target: 1–2 months after launch)

**Goal:** Revenue expansion via Verification API, enterprise features.

### 3A — Verification API (P4.5 — 13 stories)

Build order follows dependency chain in CLAUDE.md Section 10:

1. Feature flag middleware (`P4.5-TS-12`)
2. API keys table + HMAC + rate limiting (`P4.5-TS-03`)
3. `GET /api/v1/verify/:publicId` (`P4.5-TS-01`)
4. `GET /api/v1/jobs/:jobId` (`P4.5-TS-06`)
5. `POST /api/v1/verify/batch` (`P4.5-TS-02`)
6. Key CRUD endpoints (`P4.5-TS-07`)
7. Free tier enforcement 10K/month (`P4.5-TS-05`)
8. `GET /api/v1/usage` (`P4.5-TS-08`)
9. OpenAPI docs at `/api/docs` (`P4.5-TS-04`)
10. API Key Management UI (`P4.5-TS-09`)
11. API Usage Dashboard Widget (`P4.5-TS-10`)
12. API Key Scope Display (`P4.5-TS-11`)
13. Rate limit load tests (`P4.5-TS-13`)

### 3B — Enterprise Features

| Feature | Detail |
|---------|--------|
| SSO / SAML | Supabase Auth enterprise tier |
| Custom branding for verification pages | Per-org theming |
| Audit log export (CSV/JSON) | Compliance requirement for enterprise |
| Multi-org support | Users belonging to multiple organizations |
| Advanced analytics dashboard | Verification trends, usage patterns |

### 3C — SOC 2 Evidence Collection

| Evidence | Source |
|----------|--------|
| Access control | RLS policies + test results |
| Audit trail | `audit_events` table + append-only trigger |
| Change management | Git history + PR reviews + CI logs |
| Encryption | Client-side SHA-256, TLS in transit, Supabase encryption at rest |
| Incident response | Monitoring alerts + runbooks (to be created) |

---

## Dependency Graph (Critical Path)

```
MVP-01 (Worker Deploy) ─────┐
                             ├──► Mainnet Anchoring ──► Production Launch
CRIT-2 (KMS + Fund) ────────┘          │
                                        │
CRIT-3 (Plan Change) ──────────────────►│
                                        │
MVP-03 (Legal Pages) ──────────────────►│
                                        │
Production Infra ──────────────────────►│
                                        ▼
                                  Phase 1 DONE
                                        │
                              ┌─────────┼─────────┐
                              ▼         ▼         ▼
                          UX Polish  Hardening  Monitoring
                              │         │         │
                              └─────────┼─────────┘
                                        ▼
                                  Phase 2 DONE
                                        │
                              ┌─────────┼─────────┐
                              ▼         ▼         ▼
                          API Build  Enterprise  SOC 2
                              │         │         │
                              └─────────┼─────────┘
                                        ▼
                                  Phase 3 DONE
```

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| AWS KMS key provisioning delays | Blocks mainnet launch | Can soft-launch on Signet while KMS is provisioned |
| Stripe webhook reliability | Missed payment events | Worker retry logic + dead letter queue (DH-12) |
| Bitcoin fee spikes | Anchoring costs increase | `MempoolFeeEstimator` with configurable cap |
| Single worker instance | SPOF for anchor processing | Phase 2: add horizontal scaling + health checks |
| No error monitoring at launch | Silent failures | Phase 1: basic health endpoint; Phase 2: Sentry |

## Quick Reference — What to Do First

1. **Deploy the worker** (MVP-01) — nothing else works without it
2. **Provision KMS key** — follow `docs/confluence/14_kms_operations.md`
3. **Fund mainnet treasury** — minimum 0.001 BTC for initial anchors
4. **Finish Stripe plan change handlers** — CRIT-3 remaining work
5. **Create legal pages** — privacy, terms, contact
6. **Provision Supabase production** — run all 49 migrations
7. **Go live**
