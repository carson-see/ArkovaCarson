# Vendor Risk Register

> **Version:** 1.0 | **Date:** 2026-03-23 | **Classification:** CONFIDENTIAL
> **SOC 2 Controls:** CC9.2 (Risk Assessment and Management of Third Parties)
> **Owner:** Arkova Security Team
> **Review Cadence:** Annually (full review) + quarterly (risk rating check)

---

## 1. Purpose

This register documents all third-party vendors that process, store, or transmit Arkova data. Each vendor is assessed for risk level, compliance certifications, and contractual safeguards. This supports SOC 2 CC9.2 requirements for managing risks arising from third-party relationships.

---

## 2. Data Classification Reference

| Level | Definition | Examples |
|-------|-----------|----------|
| **CONFIDENTIAL** | Customer data, credentials, financial records | Database contents, auth tokens, Stripe customer IDs |
| **INTERNAL** | Operational data not intended for public release | Logs, metrics, deployment configs, API keys |
| **PUBLIC** | Data intentionally published | Anchor verification results, public API responses, marketing site |

---

## 3. Vendor Risk Rating Criteria

| Rating | Definition |
|--------|-----------|
| **LOW** | Vendor handles PUBLIC data only; no customer PII; limited blast radius |
| **MEDIUM** | Vendor handles INTERNAL data; no direct customer PII access; moderate blast radius |
| **HIGH** | Vendor handles CONFIDENTIAL data; customer PII or financial data; significant blast radius |
| **CRITICAL** | Vendor is essential to core service; handles CONFIDENTIAL data; service cannot operate without them |

---

## 4. Vendor Register

### 4.1 Supabase (Database, Auth, Storage)

| Field | Value |
|-------|-------|
| **Vendor** | Supabase, Inc. |
| **Service** | PostgreSQL database, authentication, Row-Level Security, storage |
| **Data Access Level** | CONFIDENTIAL |
| **Risk Rating** | CRITICAL |
| **Data Processed** | All customer data, user credentials, organization records, anchor metadata, audit logs |
| **Data Residency** | US (AWS us-east-1) |
| **Certifications** | SOC 2 Type II |
| **DPA Status** | Signed (included in Enterprise terms) |
| **SOC 2 Report Available** | Yes (request via Supabase dashboard) |
| **Encryption** | At rest: AES-256; In transit: TLS 1.2+ |
| **Subprocessors** | AWS (infrastructure) |
| **Last Review** | 2026-03-23 |
| **Next Review** | 2026-06-23 |
| **Notes** | RLS enforced on all tables. Service role key restricted to worker only. Database backups managed by Supabase (daily, 7-day retention on Pro). |

### 4.2 Google Cloud Platform (Gemini AI, Cloud Run)

| Field | Value |
|-------|-------|
| **Vendor** | Google LLC |
| **Service** | Cloud Run (worker hosting), Gemini AI (document intelligence), Cloud Logging |
| **Data Access Level** | CONFIDENTIAL |
| **Risk Rating** | CRITICAL |
| **Data Processed** | PII-stripped document metadata (AI extraction), worker runtime data, application logs |
| **Data Residency** | US (configurable per region) |
| **Certifications** | SOC 2 Type II, SOC 3, ISO 27001, ISO 27017, ISO 27018, FedRAMP |
| **DPA Status** | Signed (Google Cloud Data Processing Addendum) |
| **SOC 2 Report Available** | Yes (via Google Cloud Compliance Reports Manager) |
| **Encryption** | At rest: AES-256; In transit: TLS 1.3 |
| **Subprocessors** | Google-owned infrastructure |
| **Last Review** | 2026-03-23 |
| **Next Review** | 2026-06-23 |
| **Notes** | Gemini AI receives only PII-stripped metadata per Constitution 1.6. Raw documents never leave client device. `AI_PROVIDER` flag controls activation. Cloud Run worker handles Stripe webhooks, Bitcoin anchoring, and cron jobs. |

### 4.3 Vercel (Frontend Hosting)

| Field | Value |
|-------|-------|
| **Vendor** | Vercel, Inc. |
| **Service** | Frontend hosting, CDN, preview deployments, serverless edge |
| **Data Access Level** | INTERNAL |
| **Risk Rating** | HIGH |
| **Data Processed** | Static frontend assets, build logs, deployment metadata. No direct customer data (SPA connects to Supabase directly). |
| **Data Residency** | Global CDN (origin: US) |
| **Certifications** | SOC 2 Type II |
| **DPA Status** | Signed (Vercel DPA) |
| **SOC 2 Report Available** | Yes (request via Vercel support) |
| **Encryption** | In transit: TLS 1.2+; At rest: encrypted storage |
| **Subprocessors** | AWS, Cloudflare (CDN edge) |
| **Last Review** | 2026-03-23 |
| **Next Review** | 2026-06-23 |
| **Notes** | Auto-deploys from `main` branch. Immutable deployments with rollback capability. No customer data stored in Vercel; frontend is a static SPA. Environment variables (Supabase anon key, Sentry DSN) are build-time only. |

### 4.4 Cloudflare (Edge, Tunnel, WAF)

| Field | Value |
|-------|-------|
| **Vendor** | Cloudflare, Inc. |
| **Service** | CDN, WAF, DDoS protection, Cloudflare Tunnel (Zero Trust ingress), Workers (edge compute), Queues, R2 |
| **Data Access Level** | INTERNAL |
| **Risk Rating** | HIGH |
| **Data Processed** | HTTP request/response metadata, WAF logs, tunnel traffic (encrypted passthrough), edge worker execution data |
| **Data Residency** | Global edge network |
| **Certifications** | SOC 2 Type II, ISO 27001, ISO 27018, PCI DSS |
| **DPA Status** | Signed (Cloudflare DPA) |
| **SOC 2 Report Available** | Yes (via Cloudflare Trust Hub) |
| **Encryption** | In transit: TLS 1.3; Tunnel: encrypted end-to-end |
| **Subprocessors** | Cloudflare-owned infrastructure |
| **Last Review** | 2026-03-23 |
| **Next Review** | 2026-06-23 |
| **Notes** | Zero Trust Tunnel means no public ports exposed. WAF rules protect against OWASP Top 10. Edge Workers handle peripheral compute only (not core business logic per Constitution). Rate limiting enforced at edge. |

### 4.5 Stripe (Payments)

| Field | Value |
|-------|-------|
| **Vendor** | Stripe, Inc. |
| **Service** | Payment processing, subscription management, invoicing, webhooks |
| **Data Access Level** | CONFIDENTIAL |
| **Risk Rating** | CRITICAL |
| **Data Processed** | Customer billing information, subscription status, payment method tokens (Stripe manages card data directly) |
| **Data Residency** | US (Stripe infrastructure) |
| **Certifications** | PCI DSS Level 1, SOC 2 Type II |
| **DPA Status** | Signed (Stripe DPA) |
| **SOC 2 Report Available** | Yes (via Stripe compliance page) |
| **Encryption** | At rest: AES-256; In transit: TLS 1.2+ |
| **Subprocessors** | AWS (infrastructure), payment network partners |
| **Last Review** | 2026-03-23 |
| **Next Review** | 2026-06-23 |
| **Notes** | Arkova never handles raw card numbers. Stripe.js tokenizes on client side. Webhooks verified via `stripe.webhooks.constructEvent()` per Constitution 1.4. Worker-only access; never browser-side. |

### 4.6 Resend (Transactional Email)

| Field | Value |
|-------|-------|
| **Vendor** | Resend, Inc. |
| **Service** | Transactional email delivery (verification confirmations, notifications, alerts) |
| **Data Access Level** | CONFIDENTIAL |
| **Risk Rating** | MEDIUM |
| **Data Processed** | Recipient email addresses, email content (verification notifications, system alerts) |
| **Data Residency** | US |
| **Certifications** | SOC 2 Type II |
| **DPA Status** | Signed (Resend DPA) |
| **SOC 2 Report Available** | Yes (request via Resend support) |
| **Encryption** | In transit: TLS 1.2+ |
| **Subprocessors** | AWS SES (delivery infrastructure) |
| **Last Review** | 2026-03-23 |
| **Next Review** | 2026-06-23 |
| **Notes** | Email content limited to transactional notifications. No document content or fingerprints included in emails. PII limited to recipient address and name. |

### 4.7 Mempool.space (Blockchain Explorer)

| Field | Value |
|-------|-------|
| **Vendor** | Mempool.space (open source / community operated) |
| **Service** | Bitcoin network transaction lookup, fee estimation, broadcast status |
| **Data Access Level** | PUBLIC |
| **Risk Rating** | LOW |
| **Data Processed** | Bitcoin transaction IDs (public blockchain data), fee rate queries |
| **Data Residency** | N/A (public API, globally distributed) |
| **Certifications** | None (public open-source service) |
| **DPA Status** | Not required (public data only) |
| **SOC 2 Report Available** | N/A |
| **Encryption** | In transit: TLS |
| **Subprocessors** | N/A |
| **Last Review** | 2026-03-23 |
| **Next Review** | 2026-06-23 |
| **Notes** | Used for fee estimation and transaction confirmation lookups. All data queried is already public on the Bitcoin blockchain. No customer PII transmitted. Fallback: self-hosted Bitcoin node (future). |

### 4.8 GitHub (Source Code, CI/CD)

| Field | Value |
|-------|-------|
| **Vendor** | GitHub, Inc. (Microsoft) |
| **Service** | Source code hosting, CI/CD (GitHub Actions), branch protection, secret scanning |
| **Data Access Level** | INTERNAL |
| **Risk Rating** | HIGH |
| **Data Processed** | Source code, CI/CD logs, environment variable references (not values), PR reviews, issue tracking |
| **Data Residency** | US |
| **Certifications** | SOC 2 Type II, ISO 27001, FedRAMP |
| **DPA Status** | Signed (GitHub DPA via Microsoft) |
| **SOC 2 Report Available** | Yes (via GitHub Enterprise compliance) |
| **Encryption** | At rest: AES-256; In transit: TLS 1.2+ |
| **Subprocessors** | Microsoft Azure (infrastructure) |
| **Last Review** | 2026-03-23 |
| **Next Review** | 2026-06-23 |
| **Notes** | Private repository. Branch protection on `main` (required reviews, status checks, no force push). Secret scanning enabled (TruffleHog + Gitleaks in CI). No customer data in repository. Secrets stored in GitHub Actions encrypted secrets, never committed. |

---

## 5. Vendor Review Summary

| Vendor | Risk Rating | DPA | SOC 2 | Last Review | Next Review | Status |
|--------|------------|-----|-------|-------------|-------------|--------|
| Supabase | CRITICAL | Signed | Type II | 2026-03-23 | 2026-06-23 | Current |
| Google Cloud | CRITICAL | Signed | Type II | 2026-03-23 | 2026-06-23 | Current |
| Vercel | HIGH | Signed | Type II | 2026-03-23 | 2026-06-23 | Current |
| Cloudflare | HIGH | Signed | Type II | 2026-03-23 | 2026-06-23 | Current |
| Stripe | CRITICAL | Signed | Type II | 2026-03-23 | 2026-06-23 | Current |
| Resend | MEDIUM | Signed | Type II | 2026-03-23 | 2026-06-23 | Current |
| Mempool.space | LOW | N/A | N/A | 2026-03-23 | 2026-06-23 | Current |
| GitHub | HIGH | Signed | Type II | 2026-03-23 | 2026-06-23 | Current |

---

## 6. Vendor Onboarding / Offboarding Procedure

### 6.1 New Vendor Onboarding

1. Security assessment questionnaire completed
2. Certifications and SOC 2 report reviewed
3. Data Processing Agreement (DPA) executed if vendor handles CONFIDENTIAL or INTERNAL data
4. Vendor added to this register with full details
5. Access provisioned with least-privilege principle
6. Annual review date scheduled

### 6.2 Vendor Offboarding

1. All credentials and API keys rotated/revoked
2. Data deletion confirmation requested from vendor
3. Vendor marked as INACTIVE in this register
4. Access removed from all systems
5. DPA termination provisions executed if applicable

---

## 7. Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-23 | Arkova Security Team | Initial release |
| 1.1 | 2026-04-12 | Carson (SCRUM-520) | Added Sentry + Upstash; SOC 2 report review; annual cadence formalized |

---

## 8. Additional Vendors (Added 2026-04-12)

### 8.1 Sentry (Error Tracking & Observability)

| Field | Value |
|-------|-------|
| **Vendor** | Sentry (Functional Software, Inc.) |
| **Service** | Error tracking, performance monitoring, release health |
| **Data Access Level** | INTERNAL |
| **Risk Rating** | MEDIUM |
| **Data Processed** | Error stack traces, performance metrics, release metadata. PII scrubbed per Constitution (no user emails, API keys, or document fingerprints). |
| **Data Residency** | US |
| **Certifications** | SOC 2 Type II, GDPR compliant |
| **DPA Status** | Signed (Sentry DPA) |
| **SOC 2 Report Available** | Yes (request via Sentry security page) |
| **Encryption** | At rest: AES-256; In transit: TLS 1.2+ |
| **Subprocessors** | Google Cloud (infrastructure) |
| **Last Review** | 2026-04-12 |
| **Next Review** | 2026-07-12 |
| **Notes** | PII scrubbing configured per CLAUDE.md Constitution 1.4. Sample rate configurable via `SENTRY_SAMPLE_RATE`. No user emails, document fingerprints, or API keys in events. |

### 8.2 Upstash (Redis Rate Limiting)

| Field | Value |
|-------|-------|
| **Vendor** | Upstash, Inc. |
| **Service** | Serverless Redis (REST API) for rate limiting and idempotency |
| **Data Access Level** | INTERNAL |
| **Risk Rating** | LOW |
| **Data Processed** | Rate limit counters (IP hashes, API key prefixes), idempotency keys. No customer PII. |
| **Data Residency** | US |
| **Certifications** | SOC 2 Type II |
| **DPA Status** | Signed (Upstash DPA) |
| **SOC 2 Report Available** | Yes (request via Upstash) |
| **Encryption** | At rest: encrypted; In transit: TLS 1.2+ (REST API) |
| **Subprocessors** | AWS (infrastructure) |
| **Last Review** | 2026-04-12 |
| **Next Review** | 2026-07-12 |
| **Notes** | Stores only ephemeral rate-limiting data (counters, TTL keys). No customer PII. Optional dependency — system degrades gracefully to in-memory rate limiting if unavailable. |

---

## 9. Annual Review Cadence (Formalized 2026-04-12, SCRUM-520)

### Review Schedule

| Quarter | Review Type | Scope | Owner |
|---------|------------|-------|-------|
| Q1 (Jan) | **Full Annual Review** | All vendors: re-request SOC 2 reports, verify DPAs, update risk ratings | Security Team |
| Q2 (Apr) | Quarterly Check | Risk rating verification, new vendor additions, incident review | Security Team |
| Q3 (Jul) | Quarterly Check | Risk rating verification, certification expiry check | Security Team |
| Q4 (Oct) | Quarterly Check | Risk rating verification, budget planning for next year | Security Team |

### SOC 2 Report Collection Status (2026-04-12)

| Vendor | SOC 2 Type II | Report Obtained | Report Period | Notes |
|--------|---------------|----------------|---------------|-------|
| Supabase | Yes | Available on request | Annual | Request via dashboard |
| Google Cloud | Yes | Publicly available | Annual | Compliance Reports Manager |
| Vercel | Yes | Available on request | Annual | Request via support |
| Cloudflare | Yes | Publicly available | Annual | Trust Hub |
| Stripe | Yes | Available on request | Annual | Compliance page |
| Resend | Yes | Available on request | Annual | Request via support |
| GitHub | Yes | Available on request | Annual | Enterprise compliance |
| Sentry | Yes | Available on request | Annual | Security page |
| Upstash | Yes | Available on request | Annual | Request via support |
| Mempool.space | N/A | N/A | N/A | Open source, public data only |

**Action:** Request and file SOC 2 Type II reports from all CRITICAL and HIGH vendors before SOC 2 observation period begins (target: 2026-06-01). Store in `docs/compliance/vendor-soc2-reports/` (gitignored — confidential).

### Calendar Reminders

- **2027-01-15:** Full annual vendor review
- **Quarterly (Apr/Jul/Oct):** Risk rating check
- **Per vendor:** Next review dates listed in individual vendor sections above
