# Data Classification Policy
_Last updated: 2026-03-17 | Story: AUDIT-16_

## Overview

This document defines Arkova's data classification scheme, handling requirements, and retention policies. Aligned with SOC 2 Trust Service Criteria (CC6.1, CC6.5, CC6.7) and Constitution Section 1.4 (Security) and 1.6 (Client-Side Processing Boundary).

## Data Classification Levels

| Level | Label | Description | Examples |
|-------|-------|-------------|----------|
| **L4** | **Restricted** | Highly sensitive. Breach causes severe harm. | Treasury signing keys, service role keys, HMAC secrets, Stripe secrets |
| **L3** | **Confidential** | Sensitive user/org data. Breach causes significant harm. | User emails, org membership, billing details, raw API keys (pre-hash), document fingerprints (linked to user) |
| **L2** | **Internal** | Business data not for public consumption. | Anchor metadata, credential templates, AI extraction results, audit events, usage metrics |
| **L1** | **Public** | Designed for public access. | Public verification results, public issuer registry, OpenAPI spec, marketing site content |

## Data Inventory

### L4 — Restricted

| Data Element | Storage | Access | Encryption | Retention |
|-------------|---------|--------|------------|-----------|
| `BITCOIN_TREASURY_WIF` | GCP Secret Manager | Worker service account only | AES-256 (GCP-managed) | Until key rotation |
| `SUPABASE_SERVICE_ROLE_KEY` | GCP Secret Manager | Worker service account only | AES-256 (GCP-managed) | Until rotation |
| `STRIPE_SECRET_KEY` | GCP Secret Manager | Worker service account only | AES-256 (GCP-managed) | Until rotation |
| `STRIPE_WEBHOOK_SECRET` | GCP Secret Manager | Worker service account only | AES-256 (GCP-managed) | Until rotation |
| `API_KEY_HMAC_SECRET` | GCP Secret Manager | Worker service account only | AES-256 (GCP-managed) | Until rotation |
| `CRON_SECRET` | GCP Secret Manager + Cloud Scheduler | Worker + scheduler | AES-256 (GCP-managed) | Until rotation |
| AWS KMS private keys | AWS KMS | KMS API only (never exported) | HSM-backed | Per key policy |

### L3 — Confidential

| Data Element | Storage | Access | Protection | Retention |
|-------------|---------|--------|------------|-----------|
| `profiles.email` | Supabase (auth.users) | RLS: own profile only | TLS in transit, AES at rest (Supabase) | Account lifetime + 30 days post-deletion |
| `profiles.full_name` | Supabase | RLS: own profile or org admin | TLS + AES | Account lifetime + 30 days |
| `memberships` | Supabase | RLS: org members only | TLS + AES | Org lifetime |
| `api_keys.secret_hash` | Supabase | RLS: org admin only | HMAC-SHA256 hashed (raw never stored) | Until revocation + 90 days |
| `billing_accounts` | Supabase | RLS: org admin only | TLS + AES | Account lifetime + 7 years (tax) |
| Stripe customer data | Stripe (external) | Stripe API only | PCI DSS Level 1 | Per Stripe policy |
| `anchor_recipients.email_hash` | Supabase | RLS: org + recipient | SHA-256 hashed (raw never stored) | Anchor lifetime |

### L2 — Internal

| Data Element | Storage | Access | Protection | Retention |
|-------------|---------|--------|------------|-----------|
| `anchors` (metadata) | Supabase | RLS: org members | TLS + AES | Indefinite (legal hold capable) |
| `credential_templates` | Supabase | RLS: org members (read), org admin (write) | TLS + AES | Org lifetime |
| `audit_events` | Supabase | RLS: append-only, admin read | TLS + AES, immutable | 7 years minimum |
| `ai_usage_events` | Supabase | RLS: org members | TLS + AES | 2 years |
| `ai_integrity_scores` | Supabase | RLS: org members | TLS + AES | Anchor lifetime |
| `verification_events` | Supabase | SECURITY DEFINER insert, no direct read | TLS + AES | 2 years |
| `credential_embeddings` | Supabase (pgvector) | RLS: org-scoped | TLS + AES | Anchor lifetime |
| Worker logs | GCP Cloud Logging | GCP IAM | TLS + AES | 30 days |
| Sentry events | Sentry (external) | Sentry project access | PII scrubbed | 90 days |

### L1 — Public

| Data Element | Storage | Access | Protection |
|-------------|---------|--------|------------|
| `get_public_anchor` RPC results | Supabase RPC | Unauthenticated | TLS only (no PII returned) |
| Public issuer registry | Supabase RPC | Unauthenticated | TLS only |
| Verification API responses | Worker API | API key or unauthenticated (single verify) | TLS, rate limited |
| OpenAPI spec | Worker `/api/docs` | Unauthenticated | TLS only |
| Bitcoin anchor data | Bitcoin network | Public blockchain | Immutable, no PII |

## Handling Requirements by Level

| Requirement | L4 Restricted | L3 Confidential | L2 Internal | L1 Public |
|------------|---------------|------------------|-------------|-----------|
| Encryption at rest | Required (HSM/KMS) | Required (AES-256) | Required (AES-256) | Optional |
| Encryption in transit | Required (TLS 1.2+) | Required (TLS 1.2+) | Required (TLS 1.2+) | Required (TLS) |
| Access logging | Required (every access) | Required (mutations) | Required (mutations) | Not required |
| RLS enforcement | N/A (env vars) | Required | Required | N/A (public RPCs) |
| Backup | GCP Secret Manager versioning | Supabase daily backup | Supabase daily backup | N/A |
| Log/display in Sentry | **NEVER** | **NEVER** (PII scrubbed) | Redacted only | Allowed |
| Include in error messages | **NEVER** | **NEVER** | Metadata only | Allowed |
| Retention after deletion | Immediate destroy | 30 days soft delete | Per retention policy | N/A |

## Client-Side Processing Boundary (Constitution 1.6)

The following data **MUST** remain client-side and **NEVER** reach any server:

| Data | Reason | Enforcement |
|------|--------|-------------|
| Document bytes (PDF, images) | Privacy guarantee | `generateFingerprint` is browser-only; no upload endpoint exists |
| Raw OCR text | Contains PII pre-stripping | `ocrWorker.ts` runs in Web Worker; output goes to `piiStripper.ts` before any network call |
| Pre-stripped text with PII | SSN, DOB, names present | `stripPII()` must be called before `aiExtraction.ts` sends to server |
| File fingerprint computation | Core privacy contract | `fileHasher.ts` uses Web Crypto API; import blocked in `services/worker/` |

## PII Scrubbing Rules

Per Constitution 1.4 and Sentry integration (INFRA-07):

1. **Sentry `beforeSend`** strips: user emails, document fingerprints, API keys, authorization headers
2. **Worker logger** never logs: request bodies containing PII, API key values, auth tokens
3. **Audit events** store: user_id (UUID), action type, resource type — never email or name directly
4. **AI extraction** receives: PII-stripped text only (enforced by client-side `stripPII()`)
5. **Verification API** returns: hashed recipient identifier — never raw email or name

## Retention Schedule

| Data Category | Retention Period | Legal Basis | Deletion Method |
|--------------|-----------------|-------------|-----------------|
| User accounts | Active + 30 days post-deletion | Contractual | `gdpr_erase_user_data()` RPC (migration 0061) |
| Audit events | 7 years minimum | Regulatory (SOC 2 CC7.1) | No deletion (legal hold capable) |
| Anchors (SECURED) | Indefinite | Core service (on-chain record is permanent) | Metadata soft-delete; chain data immutable |
| Anchors (PENDING/FAILED) | 1 year | Operational cleanup | Hard delete via maintenance job |
| API keys (revoked) | 90 days post-revocation | Security audit trail | Hard delete |
| Verification events | 2 years | Analytics | Batch delete via maintenance job |
| AI usage events | 2 years | Billing/analytics | Batch delete via maintenance job |
| Worker logs (GCP) | 30 days | Operational | GCP auto-expiry |
| Sentry events | 90 days | Debugging | Sentry auto-expiry |
| R2 reports | 1 year | Operational | R2 lifecycle policy |

## SOC 2 Mapping

| TSC | Criteria | How Arkova Addresses |
|-----|----------|---------------------|
| CC6.1 | Logical access security over information assets | RLS on all tables, API key auth, RBAC (ORG_ADMIN/MEMBER/INDIVIDUAL) |
| CC6.5 | Restrict access to confidential information | Data classification levels, PII scrubbing, client-side processing boundary |
| CC6.7 | Restrict data transmission to authorized channels | TLS everywhere, Constitution 1.6, no raw PII in API responses |
| CC8.1 | Change management | Migration procedure (CLAUDE.md Section 7), PR review, CI gates |
| A1.2 | Recovery objectives | Supabase point-in-time recovery, GCP Secret Manager versioning |

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-17 | AUDIT-16 | Initial creation |
