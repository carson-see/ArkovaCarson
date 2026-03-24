# Security Awareness Training Program

> **Version:** 2026-03-23
> **Classification:** CONFIDENTIAL
> **SOC 2 Control:** CC1.4 (Security Awareness and Training)
> **Owner:** Engineering Lead / CISO
> **Review Cadence:** Annual (next review: 2027-03-23)

---

## 1. Purpose

This document defines Arkova's security awareness training program to ensure all personnel understand their responsibilities for protecting customer data, platform integrity, and cryptographic proof chains. Training is mandatory for all employees, contractors, and third-party personnel with access to Arkova systems.

---

## 2. Annual Training Requirement

### 2.1 Scope

All personnel with access to any of the following must complete annual security training:

- Arkova source code repositories
- Supabase database (any environment)
- Cloud infrastructure (Vercel, Cloud Run, Cloudflare, AWS)
- Stripe payment systems
- Bitcoin treasury or anchoring systems
- Customer data (even anonymized/aggregated)

### 2.2 Schedule

| Activity | Frequency | Window |
|----------|-----------|--------|
| Full security training | Annual | Q1 (January-March) |
| Quarterly security updates | Quarterly | First week of each quarter |
| New hire onboarding training | Within first 5 business days | N/A |
| Role change supplemental training | Within 10 business days of role change | N/A |

### 2.3 Completion Requirements

- Training must be completed within 30 calendar days of assignment.
- Personnel who do not complete training within the window will have repository and infrastructure access suspended until completion.
- Completion records are maintained for a minimum of 3 years for audit purposes.

---

## 3. Training Curriculum

### 3.1 Core Security Topics (All Personnel)

#### OWASP Top 10 Web Application Risks
- Injection attacks (SQL injection, XSS, command injection)
- Broken authentication and session management
- Sensitive data exposure
- Security misconfiguration
- Insecure deserialization
- Using components with known vulnerabilities
- Insufficient logging and monitoring

#### Phishing and Social Engineering
- Identifying phishing emails and messages
- Reporting procedures for suspected phishing
- Verification protocols for requests involving credentials or access changes
- Simulated phishing exercises (quarterly)

#### Secure Coding Practices
- Input validation with Zod schemas on all write paths
- Row-Level Security (RLS) enforcement on every Supabase table
- `FORCE ROW LEVEL SECURITY` requirement
- SECURITY DEFINER functions must include `SET search_path = public`
- Never hardcode secrets, API keys, or credentials in source code
- HMAC-SHA256 for API key storage (raw keys never persisted after creation)
- Stripe webhook signature verification via `stripe.webhooks.constructEvent()`
- Service role key restricted to worker processes (never in browser code)

#### Credential and Secret Management
- All secrets stored in environment variables, never committed to source control
- Treasury WIF keys: server-side only, never logged
- CI/CD secret scanning (TruffleHog + Gitleaks) enforced on every commit
- Rotation procedures for compromised credentials

### 3.2 PII Handling (Constitution 1.6 Compliance)

This section addresses Arkova's foundational privacy guarantee: **documents never leave the user's device.**

#### Client-Side Processing Boundary
- `generateFingerprint` executes exclusively in the browser -- never imported in `services/worker/`
- Client-side OCR (PDF.js + Tesseract.js) extracts text on-device
- Client-side PII stripping removes all personally identifiable information before any data leaves the browser
- Only PII-stripped structured metadata and fingerprints may flow to server
- Gated by `ENABLE_AI_EXTRACTION` flag (default: `false`) with no raw-mode bypass

#### PII Categories and Handling Rules

| PII Category | Client | Server | Logs/Sentry |
|-------------|--------|--------|-------------|
| Document content (full text) | Processed locally | NEVER transmitted | NEVER logged |
| Personal names in documents | Stripped client-side | NEVER received | NEVER logged |
| Social Security / ID numbers | Stripped client-side | NEVER received | NEVER logged |
| Document fingerprint (SHA-256) | Generated locally | Stored (non-reversible) | May appear in structured logs |
| User email (account) | Entered by user | Stored in auth | Scrubbed in Sentry events |
| Organization name | Entered by user | Stored | Scrubbed in Sentry events |

#### Sentry Observability Rules
- No user emails in Sentry events
- No document fingerprints in Sentry events
- No API keys in Sentry events
- PII scrubbing middleware is mandatory on all Sentry integrations

### 3.3 Platform-Specific Security (Engineering Personnel)

#### Database Security
- RLS policies must be written and tested before any new table is used by the application
- RLS test helpers: `withUser()` / `withAuth()` in `src/tests/rls/helpers.ts`
- Never use mock data or `useState` arrays for data that exists in Supabase
- Schema changes require migration, rollback comment, type regeneration, seed update, and documentation update

#### Bitcoin Anchoring Security
- `anchor.status = 'SECURED'` is writable only by the worker process via `service_role`
- Client code must never set anchor status to SECURED
- Treasury keys are never exposed to browser or logged
- Only `public_id` and derived fields may be exposed in public API responses

#### API Security
- Verification API schema is frozen once published (no breaking changes without v2+ and 12-month deprecation)
- Rate limits enforced: anonymous 100 req/min/IP, API key 1,000 req/min, batch 10 req/min
- CORS configuration restricted to allowed origins

---

## 4. New Hire Onboarding Security Checklist

All new personnel must complete the following within their first 5 business days:

- [ ] Complete full security awareness training module
- [ ] Read and acknowledge CLAUDE.md Constitution (Sections 1.1-1.10)
- [ ] Read data classification policy (`docs/compliance/data-classification.md`)
- [ ] Read disaster recovery plan (`docs/compliance/disaster-recovery.md`)
- [ ] Set up multi-factor authentication (MFA) on all platform accounts:
  - [ ] GitHub (repository access)
  - [ ] Supabase (database access)
  - [ ] Vercel (deployment access)
  - [ ] Cloudflare (edge/DNS access)
  - [ ] Stripe (payment access, if applicable)
  - [ ] AWS (KMS access, if applicable)
- [ ] Verify workstation disk encryption is enabled
- [ ] Install and configure approved password manager
- [ ] Review and sign acceptable use policy
- [ ] Complete simulated phishing identification exercise
- [ ] Review incident response procedures
- [ ] Acknowledge understanding of client-side processing boundary (Constitution 1.6)
- [ ] Demonstrate ability to run security-related CI checks locally:
  - `npx tsc --noEmit` (typecheck)
  - `npm run lint` (ESLint)
  - `npm run lint:copy` (banned terminology check)
  - `npm run test` (full test suite including RLS tests)

**Sign-off required from:** Engineering Lead and direct manager.

---

## 5. Quarterly Security Newsletter/Updates

### 5.1 Content

Each quarterly update covers:

- New or updated security policies
- Recent vulnerability disclosures relevant to the tech stack (React, Node.js, Supabase, Vite)
- Lessons learned from any security incidents or near-misses
- Updates to OWASP guidance or compliance requirements
- Penetration testing summary findings (redacted as appropriate)
- Dependency audit results and remediation status
- Reminder of key policies (PII handling, secret management)

### 5.2 Distribution

- Delivered via internal communication channel (email or Slack)
- Archived in `docs/compliance/newsletters/` for audit trail
- Read receipt or acknowledgment required from all personnel

### 5.3 Schedule

| Quarter | Delivery Window |
|---------|----------------|
| Q1 | First week of January |
| Q2 | First week of April |
| Q3 | First week of July |
| Q4 | First week of October |

---

## 6. Training Completion Tracking

### 6.1 Records Maintained

| Field | Description |
|-------|-------------|
| Personnel name | Full name of trainee |
| Role | Engineering, Operations, Executive, Contractor |
| Training module | Core, PII Handling, Platform-Specific, Onboarding |
| Completion date | Date training was completed |
| Assessment score | Pass/fail (minimum 80% required to pass) |
| Acknowledgment | Signed confirmation of policy understanding |
| Next due date | Date of next required training |

### 6.2 Audit Evidence

Training records are available for SOC 2 auditors upon request. Records include:

- Individual completion certificates
- Aggregate completion reports by quarter
- Exception reports (overdue or incomplete training)
- Phishing simulation results (pass/fail rates)

### 6.3 Non-Compliance Escalation

| Days Overdue | Action |
|-------------|--------|
| 1-14 | Automated reminder sent |
| 15-29 | Manager notified |
| 30+ | Repository and infrastructure access suspended |

---

## 7. Revision History

| Date | Version | Change | Author |
|------|---------|--------|--------|
| 2026-03-23 | 1.0 | Initial document creation | Engineering |
