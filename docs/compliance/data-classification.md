# Arkova Data Classification Matrix

> **Version:** 2026-03-23 | **Classification:** CONFIDENTIAL
> **Story:** DB-AUDIT DR-6 — Data classification policy for SOC 2 / GDPR

---

## Classification Levels

| Level | Definition | Access | Examples |
|-------|-----------|--------|----------|
| **PUBLIC** | Non-sensitive, publicly accessible | Anyone | Plans, feature flags, public verification data |
| **INTERNAL** | Business data, not PII | Authenticated users (scoped by RLS) | Anchors, organizations, attestations |
| **CONFIDENTIAL** | PII or sensitive business data | Owner + org admin only | Profiles, email, API keys, billing |
| **RESTRICTED** | Secrets, cryptographic keys | Infrastructure only (never in DB) | Treasury WIF, service role key, HMAC secrets |

---

## Table Classification

| Table | Classification | PII Fields | RLS Policy | Encryption |
|-------|---------------|-----------|------------|-----------|
| **profiles** | CONFIDENTIAL | email, full_name | Owner read/update only | At rest (Supabase) |
| **organizations** | INTERNAL | legal_name (optional) | Org members only | At rest |
| **anchors** | INTERNAL | metadata.recipient (hashed in API) | Owner + org admin | At rest |
| **anchor_chain_index** | INTERNAL | None | Read: all authenticated | At rest |
| **audit_events** | CONFIDENTIAL | actor_id (no email since 0061) | Append-only, org-scoped read | At rest |
| **attestations** | INTERNAL | metadata.claims | Owner + org admin | At rest |
| **subscriptions** | CONFIDENTIAL | user_id, stripe_subscription_id | Owner only | At rest |
| **entitlements** | CONFIDENTIAL | user_id/org_id | Owner only | At rest |
| **billing_events** | CONFIDENTIAL | payload (Stripe data) | Owner only | At rest |
| **plans** | PUBLIC | None | All authenticated read | At rest |
| **switchboard_flags** | PUBLIC | None | Authenticated read, service_role write | At rest |
| **switchboard_flag_history** | INTERNAL | changed_by | Service role only | At rest |
| **api_keys** | CONFIDENTIAL | key_hash (HMAC-SHA256) | Org admin only | HMAC hashed |
| **webhooks** | CONFIDENTIAL | url, secret | Org admin only | At rest |
| **webhook_delivery_logs** | INTERNAL | None | Org admin only | At rest |
| **verification_events** | INTERNAL | verifier_ip (hashed) | Service role only | At rest |
| **public_records** | PUBLIC | None (public data) | Authenticated read | At rest |
| **institution_ground_truth** | PUBLIC | None | Authenticated read | At rest |
| **ai_usage_events** | INTERNAL | fingerprint (hash) | Org-scoped | At rest |
| **integrity_scores** | INTERNAL | None | Org-scoped | At rest |
| **review_queue** | INTERNAL | None | Org admin | At rest |
| **ai_reports** | INTERNAL | None | Org-scoped | At rest |
| **extraction_feedback** | INTERNAL | None | Org-scoped | At rest |
| **org_members** | CONFIDENTIAL | user_id | Org admin | At rest |
| **org_invites** | CONFIDENTIAL | email | Org admin | At rest |
| **audit_events_archive** | CONFIDENTIAL | actor_id | Service role only | At rest |

---

## Environment Variables Classification

| Variable | Classification | Location | Notes |
|----------|---------------|----------|-------|
| `SUPABASE_SERVICE_ROLE_KEY` | RESTRICTED | Cloud Run env | Never in browser, never logged |
| `BITCOIN_TREASURY_WIF` | RESTRICTED | Cloud Run env | Never logged, never in DB |
| `STRIPE_SECRET_KEY` | RESTRICTED | Cloud Run env | Worker-only |
| `STRIPE_WEBHOOK_SECRET` | RESTRICTED | Cloud Run env | Webhook verification |
| `API_KEY_HMAC_SECRET` | RESTRICTED | Cloud Run env | Key hashing |
| `CRON_SECRET` | RESTRICTED | Cloud Run + Vercel | Cron authentication |
| `GEMINI_API_KEY` | RESTRICTED | Cloud Run env | AI provider |
| `VITE_SUPABASE_URL` | PUBLIC | Vercel env | Browser-safe |
| `VITE_SUPABASE_ANON_KEY` | PUBLIC | Vercel env | Browser-safe (RLS enforced) |
| `SENTRY_DSN` | INTERNAL | Both | Error tracking |

---

## RLS-to-Classification Mapping

| Classification | RLS Enforcement | Additional Controls |
|---------------|----------------|-------------------|
| PUBLIC | Authenticated read, service_role write | — |
| INTERNAL | Scoped by user_id/org_id, org admin sees org scope | Audit logging |
| CONFIDENTIAL | Owner-only or org admin with trigger protection | PII scrubbing, HMAC hashing, audit trail |
| RESTRICTED | Never in database | Environment variables only, never logged |

---

## Data Retention

| Data Type | Retention | Mechanism | Reference |
|-----------|----------|-----------|-----------|
| Active user data | Indefinite (while account active) | — | — |
| Deleted user data | 30 days soft-delete, then hard-delete | `cleanup_expired_data()` cron | Migration 0062 |
| Audit events (hot) | 90 days | `archive_old_audit_events()` | Migration 0097 |
| Audit events (archive) | 7 years | Archive table | SOC 2 CC7.4 |
| Billing events | 7 years | Stripe + local | Tax compliance |
| Bitcoin anchors | Permanent | Blockchain immutability | — |
| AI usage events | 1 year | Retention cron | Analytics lifecycle |

---

## Compliance Mapping

| Requirement | Standard | How Arkova Addresses |
|------------|----------|---------------------|
| Data classification | SOC 2 CC6.1 | This document |
| Access control | SOC 2 CC6.3 | RLS on all tables, role-based access |
| Encryption at rest | SOC 2 CC6.7 | Supabase (AES-256), HMAC for API keys |
| Encryption in transit | SOC 2 CC6.7 | TLS 1.3 everywhere |
| Data minimization | GDPR Art. 5(1)(c) | Client-side processing, no PII on server |
| Right to erasure | GDPR Art. 17 | `delete_own_account()` + `anonymize_user_data()` |
| Audit trail | SOC 2 CC7.2 | Append-only audit_events |
| PII handling | GDPR Art. 25 | PII null trigger on audit events (0061) |
