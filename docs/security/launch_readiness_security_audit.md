# Arkova Launch Readiness Security Audit

_Audit date: 2026-03-16 | Auditor: CISO security review (automated + manual)_
_Codebase: ArkovaCarson, branch `fix/p8-code-review-bugs` | 60 migrations | 1,586+ tests_

---

## Executive Summary

**VERDICT: CONDITIONAL PASS — 4 CRITICAL, 8 HIGH, 14 MEDIUM findings must be resolved before production launch.**

| Severity | Count |
|----------|-------|
| CRITICAL | 4 |
| HIGH | 8 |
| MEDIUM | 14 |
| LOW | 10 |
| INFO | 3 |
| **Total** | **39** |

The codebase demonstrates strong foundational security: 100% RLS coverage with FORCE on all 32 tables, proper cryptographic implementations (SHA-256 via Web Crypto, HMAC-SHA256 for API keys, ECDSA via bitcoinjs-lib/KMS), comprehensive Sentry PII scrubbing, and zero known dependency vulnerabilities. However, critical gaps exist in GDPR erasure compliance, production credential management, unauthenticated internal endpoints, and PostgREST injection.

---

## Table of Contents

1. [Secrets Scan](#1-secrets-scan)
2. [Injection Attacks](#2-injection-attacks)
3. [RLS Policy Audit](#3-rls-policy-audit)
4. [Auth & Access Control](#4-auth--access-control)
5. [PII & Data Protection](#5-pii--data-protection)
6. [Cryptographic Controls](#6-cryptographic-controls)
7. [Dependency Audit](#7-dependency-audit)
8. [Compliance Gap Analysis](#8-compliance-gap-analysis)
9. [Consolidated Findings Table](#9-consolidated-findings-table)
10. [Remediation Priority](#10-remediation-priority)

---

## 1. Secrets Scan

### Result: PASS (1 HIGH pre-launch action required)

**No hardcoded secrets found in source code or git history.** Comprehensive scan of all `.ts`, `.tsx`, `.sql`, `.json`, `.toml`, `.yml` files plus full `git log -p -S` search for `sk_live`, `sk_test`, `BITCOIN_TREASURY_WIF`, and production Supabase JWTs.

| Category | Result |
|----------|--------|
| Stripe secret keys (`sk_live_*`) | Clean — none found |
| Supabase service role keys | Clean — only env var references |
| Bitcoin WIF private keys | Clean — loaded from `process.env` only |
| Sentry DSNs | Clean — placeholder in `.env.example` only |
| Gemini/Replicate API tokens | Clean — env var references only |
| AWS/GCP credentials | Clean — none found |
| `.env` files committed | Clean — all gitignored |
| Git history leaks | Clean — no real secrets in any commit |

**Findings:**

| ID | Severity | Finding | File | Fix |
|----|----------|---------|------|-----|
| SEC-01 | **HIGH** | Demo seed credentials (`Demo1234!`) loaded to production Supabase. Publicly documented in repo (`seed.sql`, `README.md`, `CLAUDE.md`). Anyone reading the repo can authenticate as admin. | `supabase/seed.sql:29-32` | Strip seed accounts from production DB before launch. |
| SEC-02 | **MEDIUM** | `.env.production` NOT covered by `.gitignore`. Pattern `.env*.local` catches `.env.production.local` but not `.env.production` itself. | `.gitignore` | Add `.env.production` and `.env.staging` to `.gitignore`. |
| SEC-03 | LOW | Production Supabase URL, Cloud Run URL, GCP project name documented in committed files (`MEMORY.md`, `CLAUDE.md`). Not secrets individually but aids reconnaissance. | Multiple docs | Move infrastructure identifiers to non-committed operations wiki. |

---

## 2. Injection Attacks

### Result: 1 HIGH, 2 MEDIUM, 1 LOW

**Zero `dangerouslySetInnerHTML`, zero `innerHTML`, zero `child_process`/`exec`/`spawn` usage in server code. All Supabase `.rpc()` calls use parameterized objects. All API endpoints validate inputs via Zod `safeParse()`. SECURITY DEFINER functions all have `SET search_path = public`.**

| ID | Severity | Type | Finding | File:Line | Fix |
|----|----------|------|---------|-----------|-----|
| INJ-01 | **HIGH** | SQL Injection (PostgREST) | `handleSearchCredentials` interpolates user search query directly into PostgREST filter URL. `encodeURIComponent` does not prevent PostgREST operator injection (`or()` clause manipulation). | `services/edge/src/mcp-tools.ts:188` | Replace URL construction with Supabase JS client using `.ilike()`, or use a SECURITY DEFINER RPC with bound parameters. |
| INJ-02 | **MEDIUM** | SSRF | Webhook delivery `fetch(endpoint.url)` uses user-registered URLs with no private IP validation. HTTPS-only enforced by DB constraint, but cloud metadata IPs (`169.254.169.254`, `metadata.google.internal`) are not blocked. | `services/worker/src/webhooks/delivery.ts:161` | Add DNS resolution + private IP range blocklist before delivery. Block `169.254.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, cloud metadata hostnames. |
| INJ-03 | **MEDIUM** | SSRF (DNS rebinding) | Crawler `isValidDomain` blocks direct IPs but domain could resolve to private IP at fetch time. Mitigated by Cloudflare Workers runtime restrictions. | `services/edge/src/cloudflare-crawler.ts:153` | Add post-resolution IP validation. |
| INJ-04 | LOW | XSS (defense-in-depth) | CSP in `vercel.json` includes `'unsafe-inline' 'unsafe-eval'` in `script-src`, weakening XSS protection. Required by Vite dev but should be tightened for production. | `vercel.json:12` | Use nonce-based CSP or hash-based CSP for production. Remove `'unsafe-eval'` at minimum. |

**Confirmed clean areas:**
- Path traversal: `buildR2Key()` sanitizes with `replace(/[^a-zA-Z0-9_-]/g, '_')`. No filesystem path construction from user input.
- Command injection: No shell execution in worker code.
- XSS: No `dangerouslySetInnerHTML` usage. `MetadataDisplay` validates URLs via `new URL()` with protocol allowlist.

---

## 3. RLS Policy Audit

### Result: 100% RLS + FORCE coverage. 2 HIGH, 3 MEDIUM, 2 LOW policy issues.

**All 32 tables have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.** All 29 SECURITY DEFINER functions have `SET search_path = public`. Append-only `audit_events` has trigger-level tamper protection blocking UPDATE/DELETE even for table owner.

| ID | Severity | Finding | Tables Affected | Fix |
|----|----------|---------|-----------------|-----|
| RLS-01 | **HIGH** | 13 tables missing `GRANT SELECT/INSERT/UPDATE/DELETE TO authenticated`. RLS policies exist but are unreachable without table-level GRANT. App works through SECURITY DEFINER RPCs but direct Supabase client queries silently fail. | `credential_templates`, `memberships`, `verification_events`, `institution_ground_truth`, `anchor_recipients`, `credits`, `credit_transactions`, `api_keys`, `api_key_usage`, `ai_credits`, `ai_usage_events`, `credential_embeddings`, `invitations` | Create compensating migration. Audit which tables need direct client access vs. RPC-only. Add GRANTs for client-accessed tables; document RPC-only tables as intentional defense-in-depth. |
| RLS-02 | **HIGH** | `api_keys` and `api_key_usage` SELECT policy allows non-admin org members to read API key metadata (prefix, name, scopes, usage). Violates least-privilege. | `api_keys`, `api_key_usage` | Add `AND is_org_admin()` to SELECT policies. |
| RLS-03 | **MEDIUM** | `audit_events` INSERT policy allows `actor_id IS NULL`, enabling users to inject fake "system" audit events. | `audit_events` | Remove `actor_id IS NULL OR` from INSERT policy. System events should use service_role. |
| RLS-04 | **MEDIUM** | `anchor_proofs` SELECT policy uses `org_id = get_user_org_id()` without `is_org_admin()`, inconsistent with `anchors` table which requires admin for org-scoped access. | `anchor_proofs` | Add `AND is_org_admin()` to org branch. |
| RLS-05 | **MEDIUM** | `search_public_credential_embeddings` SECURITY DEFINER function searches across ALL orgs. Intended for agentic verification but EXECUTE may be granted to `authenticated`/`anon` directly. | `credential_embeddings` (via function) | Verify EXECUTE grants; restrict to service_role if only used server-side. |
| RLS-06 | LOW | `switchboard_flag_history` readable by all authenticated users (USING true). Exposes operational decisions. | `switchboard_flag_history` | Restrict to admin or service_role. |
| RLS-07 | LOW | `reports` and `report_artifacts` readable by non-admin org members. | `reports`, `report_artifacts` | Add `is_org_admin()` to org branch. |

---

## 4. Auth & Access Control

### Result: 1 HIGH, 4 MEDIUM, 3 LOW

**JWT verification is robust** — uses `jose` library with explicit `HS256` algorithm pinning (prevents `alg:none` attacks). **Stripe webhook verification uses `constructEvent()`** with raw body. **API key auth uses HMAC-SHA256 hash-then-lookup** pattern (immune to timing attacks). **Feature gating fails closed.**

| ID | Severity | Finding | File:Line | Fix |
|----|----------|---------|-----------|-----|
| AUTH-01 | **HIGH** | `POST /jobs/process-anchors` has zero auth, zero rate limiting, no feature gate. Any network-reachable caller can trigger anchor processing, causing Bitcoin fee burn and race conditions. | `services/worker/src/index.ts:338` | Remove the route, gate behind `NODE_ENV !== 'production'`, or require `X-Cron-Secret` header matching an env var. |
| AUTH-02 | **MEDIUM** | Empty HMAC secret fallback: `config.apiKeyHmacSecret ?? ''`. If `API_KEY_HMAC_SECRET` not set, all keys hash with empty string — publicly reproducible, complete auth bypass. | `services/worker/src/api/v1/router.ts:68` | Fail fast: `if (!hmacSecret && config.enableVerificationApi) throw new Error('API_KEY_HMAC_SECRET required')`. |
| AUTH-03 | **MEDIUM** | Missing `trust proxy` on Express. Behind Cloudflare Tunnel + Cloud Run, `req.ip` returns proxy IP, collapsing all per-IP rate limiting into a single bucket. | `services/worker/src/index.ts` (absent) | Add `app.set('trust proxy', 2);` after line 31. |
| AUTH-04 | **MEDIUM** | Wildcard CORS default (`*`) on `/api/v1/*` when `CORS_ALLOWED_ORIGINS` unset. Allows any website to make authenticated cross-origin API requests. | `services/worker/src/api/v1/router.ts:42-44` | Set `CORS_ALLOWED_ORIGINS` in production. Consider restricting authenticated endpoints (`/keys`, `/ai/*`) to frontend origin only. |
| AUTH-05 | **MEDIUM** | In-memory rate limiting (`Map`). Each Cloud Run instance has independent counters. With auto-scaling, effective rate limit = N * configured limit. | `services/worker/src/utils/rateLimit.ts` | Migrate to Redis-backed or Supabase RPC-backed rate limiting. Set `--max-instances=1` as interim fix. |
| AUTH-06 | LOW | No role-based auth on API key management. Any org member (not just admin) can create, revoke, delete API keys. | `services/worker/src/api/v1/keys.ts` | Add `ORG_ADMIN` role check in key management handlers. |
| AUTH-07 | LOW | API key scopes not enforced. `scopes` stored but never checked — a `['verify']`-scoped key can access batch, usage, and jobs endpoints. | `services/worker/src/api/v1/router.ts` | Create `requireScope(scope)` middleware; apply per route. |
| AUTH-08 | LOW | `X-RateLimit-Reset` header uses milliseconds instead of seconds. API consumers miscalculate wait times by 1000x. | `services/worker/src/utils/rateLimit.ts` | Use `Math.floor(entry.resetAt / 1000)`. |

---

## 5. PII & Data Protection

### Result: 2 CRITICAL, 1 HIGH, 4 MEDIUM, 3 LOW

**Sentry PII scrubbing is thorough** — `beforeSend` scrubs emails, fingerprints, SSNs, API keys, JWTs; `sendDefaultPii: false`; request bodies stripped entirely; sensitive headers filtered. **Recipient identifiers hashed with SHA-256 in public views.** **No raw PII in logger output.** **PII stripper is client-enforced and cannot be bypassed in extraction pipeline.**

| ID | Severity | Finding | File:Line | Regulatory Impact | Fix |
|----|----------|---------|-----------|-------------------|-----|
| PII-01 | **CRITICAL** | `actor_email` stored in plaintext in append-only `audit_events`. Table blocks all UPDATE/DELETE via trigger. **Impossible to erase per GDPR Art. 17.** | `src/lib/auditLog.ts:45`, migration `0006` | GDPR Art. 17, Art. 5(1)(c) | Stop storing `actor_email`. Use `actor_id` UUID only; join for display. Create SECURITY DEFINER anonymization RPC for existing data. |
| PII-02 | **CRITICAL** | No right-to-erasure mechanism. No account deletion flow. No anonymization RPC. `reject_audit_modification` trigger has no bypass for GDPR erasure. | Not implemented | GDPR Art. 17 | Build `anonymize_user_data(user_id)` SECURITY DEFINER RPC. Build self-service "Delete My Account" flow. |
| PII-03 | **HIGH** | No data retention/cleanup policy. `audit_events`, `ai_usage_events`, `verification_events`, `webhook_delivery_logs` grow unbounded with no documented retention period. | No migration/cron | GDPR Art. 5(1)(e) | Implement retention cron job. Suggested: 2yr audit_events, 90d delivery logs, 1yr AI usage. Document policy. |
| PII-04 | **MEDIUM** | `get_public_anchor` returns full `metadata` JSONB (minus `recipient` key). User-entered custom fields may contain PII (addresses, parent names, student IDs). Served to anonymous users. | migration `0054:100` | GDPR Art. 5(1)(c), FERPA 34 CFR 99.3 | Implement metadata allowlist based on credential template schema. Only expose defined template fields. |
| PII-05 | **MEDIUM** | AI semantic search endpoint returns `metadata` without stripping `recipient` key or sanitizing custom fields. Org-scoped (limited blast radius). | `services/worker/src/api/v1/ai-search.ts:120` | GDPR Art. 5(1)(c) | Apply same `- 'recipient'` stripping + metadata allowlist. |
| PII-06 | **MEDIUM** | PII stripper misses international phone formats (EU: `+44 20 7946 0958`, etc.). Only US patterns detected. | `src/lib/piiStripper.ts:39` | GDPR Art. 5(1)(c) | Add international phone regex. |
| PII-07 | **MEDIUM** | PII stripper misses physical addresses. Home addresses in OCR'd credentials flow to server. | `src/lib/piiStripper.ts` | GDPR Art. 5(1)(c), FERPA | Add basic address pattern detection. |
| PII-08 | LOW | Sentry `scrubString()` misses phone numbers and IP addresses embedded in exception messages. `event.user.ip_address` is deleted but IPs in strings pass through. | `services/worker/src/utils/sentry.ts:50-57` | GDPR Art. 5(1)(c) | Add phone and IP regex to `scrubString()`. |
| PII-09 | LOW | Sentry `event.tags` not scrubbed. PII set via `Sentry.setTag()` would be sent unfiltered. | `src/lib/sentry.ts:66-122` | GDPR Art. 5(1)(c) | Add tags scrub pass. |
| PII-10 | LOW | `ai_usage_events` stores `fingerprint` + `user_id` together, creating correlation risk. | migration `0059:40` | GDPR Art. 5(1)(c) | Consider removing `fingerprint` column; use `anchor_id` FK instead. |

---

## 6. Cryptographic Controls

### Result: PASS — All clean

| Area | Status | Implementation |
|------|--------|---------------|
| SHA-256 fingerprinting | PASS | Web Crypto API (`crypto.subtle.digest`), not a polyfill |
| Constitution 1.6 boundary | PASS | Zero imports of `fileHasher`/`generateFingerprint` in worker |
| HMAC-SHA256 API keys | PASS | `crypto.createHmac('sha256')`, env-loaded secret, hash-then-lookup |
| Bitcoin WIF handling | PASS | Env-only loading, never logged, generic error messages |
| AWS KMS delegation | PASS | Proper DER-to-compact conversion, key ID never logged |
| GCP KMS delegation | PASS | Same pattern as AWS, PEM parsing correct |
| HSTS (frontend) | PASS | 2-year max-age, includeSubDomains, preload via `vercel.json` |
| HSTS (worker) | PASS | Handled by Cloudflare Tunnel edge |
| Randomness | PASS | `crypto.randomBytes(32)` for security; `Math.random()` only in tests/mocks/UI |
| Hash algorithm strength | PASS | No MD5 or SHA-1. SHA-256+ throughout |

---

## 7. Dependency Audit

### Result: PASS — Zero known vulnerabilities

```
Root package:  0 vulnerabilities (208 prod, 616 dev, 138 optional = 878 total)
Worker package: 0 vulnerabilities (321 prod, 253 dev, 65 optional = 586 total)
```

| Package | Role | Status |
|---------|------|--------|
| `bitcoinjs-lib` | Bitcoin signing | Clean |
| `@supabase/supabase-js` | Database client | Clean |
| `express` | Worker HTTP | Clean |
| `stripe` | Payments | Clean |
| `@sentry/node` | Observability | Clean |
| `jose` | JWT verification | Clean |
| `@google-ai/generativelanguage` | AI extraction | Clean |

---

## 8. Compliance Gap Analysis

### SOC 2 Type II (Trust Services Criteria)

| Control | TSC | Current Status | Gap | Priority |
|---------|-----|---------------|-----|----------|
| Access control enforcement | CC6.1 | RLS on all tables, JWT + API key auth | 13 tables missing GRANT (RLS-01); no role check on key mgmt (AUTH-06) | HIGH |
| Logical access monitoring | CC6.2 | `audit_events` append-only, `verification_events` logging | No log retention policy; `actor_email` is PII (PII-01) | CRITICAL |
| Change management | CC8.1 | Git history, CI pipeline, PR reviews | No formal change advisory board process documented | MEDIUM |
| System monitoring | CC7.2 | Sentry error tracking, health endpoint | Sentry DSN not configured in production (INFRA-07) | MEDIUM |
| Incident response | CC7.3 | Not documented | No incident response playbook | HIGH |
| Encryption in transit | CC6.7 | HSTS preload (frontend), Cloudflare Tunnel (worker) | Worker lacks security headers for Swagger UI | MEDIUM |
| Encryption at rest | CC6.1 | Supabase (Postgres) encrypted at rest | Not explicitly documented | LOW |
| Vendor management | CC9.2 | Supabase, Stripe, Cloudflare, GCP | No vendor security review documentation | MEDIUM |
| Availability | A1.2 | Cloud Run auto-scaling, health checks | In-memory rate limiting breaks with auto-scaling (AUTH-05) | MEDIUM |

### GDPR (Articles 5, 6, 17, 25, 28, 32, 35)

| Control | Article | Current Status | Gap | Priority |
|---------|---------|---------------|-----|----------|
| Right to erasure | Art. 17 | No mechanism | `audit_events` stores PII in tamper-proof table; no deletion flow | **CRITICAL** |
| Data minimization | Art. 5(1)(c) | Partial | `actor_email` in audit logs; metadata may contain PII; PII stripper gaps | **CRITICAL** |
| Storage limitation | Art. 5(1)(e) | Missing | No retention policy on any table | **HIGH** |
| Data portability | Art. 20 | Missing | No data export endpoint | MEDIUM |
| Consent recording | Art. 6, 7 | Missing | No consent management system | MEDIUM |
| Data protection by design | Art. 25 | Strong | Client-side hashing, recipient hashing, Sentry scrubbing | OK |
| DPA with processors | Art. 28 | Unknown | Supabase, Stripe, GCP DPAs not documented | MEDIUM |
| DPIA | Art. 35 | Missing | No Data Protection Impact Assessment documented | MEDIUM |
| Breach notification | Art. 33, 34 | Missing | No breach notification procedure | HIGH |

### FERPA (34 CFR Part 99)

| Control | Section | Current Status | Gap | Priority |
|---------|---------|---------------|-----|----------|
| Education records protection | 99.3 | Partial | Credential metadata unclassified — FERPA-protected fields not tagged | MEDIUM |
| Directory information opt-out | 99.37 | Missing | No opt-out mechanism per credential/recipient | MEDIUM |
| Institutional consent tracking | 99.30 | Missing | No data-sharing agreement tracking | MEDIUM |
| Access logging | 99.32 | Complete | `audit_events` + `verification_events` track all access | OK |
| Recipient hashing | 99.31 | Complete | SHA-256 hashing prevents student identity exposure | OK |

### ESIGN / UETA

| Control | Required By | Current Status | Gap | Priority |
|---------|-----------|---------------|-----|----------|
| Intent to sign | ESIGN §101 | N/A | Arkova anchors evidence, not signatures. Clear in privacy policy. | OK |
| Record retention | ESIGN §101 | Partial | `retention_until` column exists but `canDeleteAnchor()` not implemented in code | LOW |
| Consent to e-records | ESIGN §101 | Missing | No explicit consent recorded for electronic record processing | MEDIUM |

### eIDAS (EU Electronic Identification)

| Control | Article | Current Status | Gap | Priority |
|---------|---------|---------------|-----|----------|
| Qualified Trust Service (QeTS) | Art. 42 | Not applicable yet | Arkova is not a QeTS. Would require conformity assessment if operating in EU. | INFO |
| Electronic seal requirements | Art. 35-36 | Not applicable | Bitcoin anchoring is not an electronic seal under eIDAS | INFO |
| Cross-border recognition | Art. 14 | Not applicable | Pre-launch; no cross-border claims made | INFO |

### Australia Privacy Act 1988 (APPs)

| Control | APP | Current Status | Gap | Priority |
|---------|-----|---------------|-----|----------|
| Open and transparent management | APP 1 | Partial | Privacy page exists but no Australian-specific disclosures | MEDIUM |
| Collection notification | APP 5 | Missing | No notification at point of collection for Australian users | MEDIUM |
| Cross-border disclosure | APP 8 | Missing | Data stored in US (Supabase); no disclosure of cross-border transfer | MEDIUM |
| Access and correction | APP 12, 13 | Missing | No self-service data access/correction mechanism | MEDIUM |

### EU AI Act

| Control | Article | Current Status | Gap | Priority |
|---------|---------|---------------|-----|----------|
| Human oversight | Art. 14 | Partial | AI extraction has accept/reject UI but no mandatory human review step | MEDIUM |
| Risk classification | Art. 6 | Not assessed | AI credential extraction may fall under "high-risk" if used for access to education | HIGH |
| Technical documentation | Art. 11 | Missing | No AI system documentation per Annex IV | MEDIUM |
| Transparency | Art. 13 | Partial | AI suggestions show confidence scores but no model identification to user | LOW |

---

## 9. Consolidated Findings Table

| ID | Severity | Category | Finding | Regulatory Impact | Fix |
|----|----------|----------|---------|-------------------|-----|
| **PII-01** | **CRITICAL** | PII | `actor_email` in append-only `audit_events` | GDPR Art. 17, 5(1)(c) | Stop storing; anonymization RPC |
| **PII-02** | **CRITICAL** | PII | No right-to-erasure mechanism | GDPR Art. 17 | Build anonymization RPC + account deletion |
| **PII-03** | **HIGH** | PII | No data retention policy | GDPR Art. 5(1)(e) | Implement retention cron + policy |
| **SEC-01** | **HIGH** | Secrets | Demo credentials in production DB | SOC 2 CC6.1 | Strip seed accounts |
| **INJ-01** | **HIGH** | Injection | PostgREST filter injection in MCP tools | OWASP A03:2021 | Use parameterized queries |
| **RLS-01** | **HIGH** | RLS | 13 tables missing GRANT to authenticated | SOC 2 CC6.1 | Compensating migration |
| **RLS-02** | **HIGH** | RLS | api_keys readable by non-admin org members | SOC 2 CC6.1 | Add `is_org_admin()` |
| **AUTH-01** | **HIGH** | Auth | Unauthenticated `/jobs/process-anchors` | OWASP A01:2021 | Gate or remove endpoint |
| **AUTH-02** | **MEDIUM** | Auth | Empty HMAC secret fallback to `''` | OWASP A02:2021 | Fail fast when unset |
| **AUTH-03** | **MEDIUM** | Auth | Missing `trust proxy` — rate limiting ineffective | SOC 2 A1.2 | Add `app.set('trust proxy', 2)` |
| **AUTH-04** | **MEDIUM** | Auth | Wildcard CORS default on API v1 | OWASP A05:2021 | Set `CORS_ALLOWED_ORIGINS` in prod |
| **AUTH-05** | **MEDIUM** | Auth | In-memory rate limiting not distributed | SOC 2 A1.2 | Redis-backed limiter or `max-instances=1` |
| **SEC-02** | **MEDIUM** | Secrets | `.env.production` not in `.gitignore` | SOC 2 CC6.1 | Add to `.gitignore` |
| **INJ-02** | **MEDIUM** | Injection | Webhook SSRF — no private IP validation | OWASP A10:2021 | Private IP blocklist |
| **INJ-03** | **MEDIUM** | Injection | Crawler DNS rebinding risk | OWASP A10:2021 | Post-resolution IP check |
| **INJ-04** | **MEDIUM** | Injection | CSP `unsafe-inline` + `unsafe-eval` | OWASP A03:2021 | Nonce-based CSP for production |
| **RLS-03** | **MEDIUM** | RLS | audit_events INSERT allows NULL actor_id | SOC 2 CC6.2 | Remove NULL allowance |
| **RLS-04** | **MEDIUM** | RLS | anchor_proofs org scope inconsistent | SOC 2 CC6.1 | Add `is_org_admin()` |
| **RLS-05** | **MEDIUM** | RLS | Cross-org embedding search function | OWASP A01:2021 | Restrict EXECUTE grants |
| **PII-04** | **MEDIUM** | PII | Metadata JSONB exposed publicly | GDPR Art. 5(1)(c), FERPA 99.3 | Implement allowlist |
| **PII-05** | **MEDIUM** | PII | AI search returns unsanitized metadata | GDPR Art. 5(1)(c) | Strip recipient + allowlist |
| **PII-06** | **MEDIUM** | PII | PII stripper misses intl phone formats | GDPR Art. 5(1)(c) | Add intl phone regex |
| **PII-07** | **MEDIUM** | PII | PII stripper misses physical addresses | GDPR Art. 5(1)(c), FERPA | Add address detection |
| **SEC-03** | LOW | Secrets | Infrastructure IDs in committed docs | Reconnaissance aid | Move to private wiki |
| **AUTH-06** | LOW | Auth | No role check on API key management | SOC 2 CC6.1 | Require ORG_ADMIN role |
| **AUTH-07** | LOW | Auth | API key scopes not enforced | SOC 2 CC6.1 | `requireScope()` middleware |
| **AUTH-08** | LOW | Auth | Rate limit reset header uses milliseconds | Interoperability | Use seconds |
| **RLS-06** | LOW | RLS | Flag history visible to all users | SOC 2 CC6.1 | Restrict to admin |
| **RLS-07** | LOW | RLS | Reports visible to non-admin org members | SOC 2 CC6.1 | Add `is_org_admin()` |
| **PII-08** | LOW | PII | Sentry misses phone/IP in strings | GDPR Art. 5(1)(c) | Add regex patterns |
| **PII-09** | LOW | PII | Sentry event.tags not scrubbed | GDPR Art. 5(1)(c) | Add tags scrub pass |
| **PII-10** | LOW | PII | `ai_usage_events` fingerprint+user_id correlation | GDPR Art. 5(1)(c) | Use anchor_id FK |
| **COMP-01** | INFO | Compliance | No incident response playbook | SOC 2 CC7.3 | Document procedure |
| **COMP-02** | INFO | Compliance | No DPIA documented | GDPR Art. 35 | Conduct DPIA |
| **COMP-03** | INFO | Compliance | EU AI Act risk classification not assessed | EU AI Act Art. 6 | Assess classification |

---

## 10. Remediation Priority

### Before Production Launch (P0)

1. **PII-01 + PII-02**: Stop storing `actor_email`; build anonymization RPC; build account deletion flow
2. **SEC-01**: Strip demo seed accounts from production Supabase
3. **AUTH-01**: Secure or remove `/jobs/process-anchors` endpoint
4. **INJ-01**: Fix PostgREST filter injection in MCP tools
5. **AUTH-02**: Fail fast on empty HMAC secret
6. **RLS-01**: Compensating migration for missing GRANTs
7. **SEC-02**: Add `.env.production` to `.gitignore`

### Before GA / Public API Launch (P1)

8. **PII-03**: Implement data retention policy + cron
9. **RLS-02**: Restrict `api_keys` SELECT to org admins
10. **AUTH-03**: Add `trust proxy` configuration
11. **AUTH-04**: Set production CORS origins
12. **AUTH-05**: Migrate to distributed rate limiting
13. **INJ-02**: Add webhook SSRF private IP blocklist
14. **PII-04 + PII-05**: Implement metadata allowlist for public responses
15. **PII-06 + PII-07**: Extend PII stripper (intl phones, addresses)

### Post-GA Hardening (P2)

16. All remaining MEDIUM and LOW findings
17. SOC 2 evidence collection
18. DPIA documentation
19. EU AI Act assessment
20. Vendor DPA documentation

---

## Positive Security Posture

Despite the findings above, the codebase demonstrates mature security practices:

- **100% RLS + FORCE** on all 32 tables — no exceptions
- **29/29 SECURITY DEFINER functions** have `SET search_path = public`
- **Zero known CVEs** across 1,464 dependencies
- **Comprehensive Sentry scrubbing** — emails, fingerprints, SSNs, API keys, JWTs, request bodies
- **Constitution 1.6 enforced** — `generateFingerprint` never imported in worker
- **Strong cryptographic choices** — SHA-256, HMAC-SHA256, ECDSA-secp256k1, `crypto.randomBytes`, `jose` with algorithm pinning
- **Append-only audit trail** with trigger-level tamper protection
- **Feature flags fail closed** — all disabled by default
- **No `dangerouslySetInnerHTML`**, no command injection vectors, no MD5/SHA-1

---

_Generated by CISO security audit | 2026-03-16_
_SECURITY AUDIT: 4 critical, 8 high, 14 medium — CONDITIONAL PASS for launch_
