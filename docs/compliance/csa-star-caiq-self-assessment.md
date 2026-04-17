# CSA STAR Level 1 — CAIQ Self-Assessment

**Organization:** Arkova, Inc.  
**Assessment Date:** 2026-04-17  
**CAIQ Version:** 4.0.3  
**Assessor:** Internal (engineering team)  
**Status:** DRAFT — pending CSA STAR Registry submission

## Overview

This self-assessment covers Arkova's credential verification platform against the Cloud Security Alliance (CSA) Consensus Assessments Initiative Questionnaire (CAIQ). Arkova's client-side processing architecture — where documents never leave the user's device — materially reduces the scope of many cloud security controls.

## Architecture Summary

- **Processing Model:** Client-side only (SHA-256 fingerprinting in browser)
- **Infrastructure:** Supabase (Postgres), Vercel (frontend), GCP Cloud Run (worker)
- **Ingress:** Cloudflare Tunnel (zero trust, no public ports)
- **Data at Rest:** Only cryptographic fingerprints + metadata stored server-side
- **Auth:** Supabase Auth (JWT) + RLS on all tables
- **Observability:** Sentry (PII scrubbed)

---

## CAIQ Assessment by CCM Domain

### A&A — Audit Assurance & Compliance

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| A&A-01 | Do you conduct independent audits? | Yes | `soc2-evidence.md`, annual pen test |
| A&A-02 | Are audit results shared with stakeholders? | Yes | SOC 3 report planned (TRUST-04) |
| A&A-03 | Is there an information security management program? | Yes | `incident-response-plan.md`, `security-training.md` |
| A&A-04 | Are compliance obligations identified? | Yes | `complianceMapping.ts`, 13 regulatory frameworks |
| A&A-05 | Are audit logs maintained? | Yes | Append-only `audit_events` table, 90-day retention |

### AIS — Application & Interface Security

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| AIS-01 | Are applications designed with secure development practices? | Yes | Zod validation, RLS, `SECURITY DEFINER` functions |
| AIS-02 | Is input validation performed? | Yes | Zod schemas on all write paths |
| AIS-03 | Is data integrity protected during transmission? | Yes | TLS 1.3, SHA-256 content hashing |
| AIS-04 | Is there an application security testing program? | Yes | Vitest (4,127 tests), Playwright E2E |

### BCR — Business Continuity & Operational Resilience

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| BCR-01 | Is there a business continuity plan? | Yes | `disaster-recovery.md` |
| BCR-02 | Are recovery objectives defined? | Yes | RPO/RTO documented |
| BCR-03 | Are backups performed? | Yes | Supabase automated backups |
| BCR-04 | Is the plan tested? | Yes | `dr-test-results/` |

### CCC — Change Control & Configuration

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| CCC-01 | Is there a change management process? | Yes | `change-management.md`, GitHub PRs |
| CCC-02 | Are changes tested before production? | Yes | CI/CD pipeline, staging environment |
| CCC-03 | Are unauthorized changes detected? | Yes | Branch protection, audit logs |

### DSP — Data Security & Privacy

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| DSP-01 | Is data classified? | Yes | `data-classification.md` |
| DSP-02 | Is data encrypted at rest? | Yes | Supabase encryption, AES-256 |
| DSP-03 | Is data encrypted in transit? | Yes | TLS 1.3 everywhere |
| DSP-04 | Are privacy notices provided? | Yes | `/privacy` page, `JurisdictionPrivacyNotices` (10 jurisdictions) |
| DSP-05 | Is PII handling documented? | Yes | GDPR Art. 30 records, `data-retention-policy.md` |
| DSP-07 | Is data retained per policy? | Yes | `/privacy/data-retention` |
| DSP-17 | Is client-side processing used? | Yes | Documents never leave device — core architecture |

### GRC — Governance, Risk & Compliance

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| GRC-01 | Is there an information security policy? | Yes | CLAUDE.md Constitution, `soc2-evidence.md` |
| GRC-02 | Are risks assessed? | Yes | `trust-framework-roadmap.md` |
| GRC-03 | Is there a risk treatment plan? | Yes | `incident-response-plan.md` |

### HRS — Human Resources Security

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| HRS-01 | Are security responsibilities defined? | Yes | DPO designation, `dpo-designation.md` |
| HRS-02 | Is security awareness training provided? | Yes | `security-training.md` |
| HRS-03 | Are background checks conducted? | N/A | Startup-stage team |

### IAM — Identity & Access Management

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| IAM-01 | Is access controlled? | Yes | Supabase Auth + RLS on all tables |
| IAM-02 | Is MFA available? | Yes | Supabase MFA (HIPAA §164.312(d)) |
| IAM-03 | Are service accounts secured? | Yes | Service role key server-only, never in browser |
| IAM-04 | Is access reviewed? | Yes | `access-review-log.md` |
| IAM-06 | Are API keys managed securely? | Yes | HMAC-SHA256, raw keys never persisted |

### IVS — Infrastructure & Virtualization Security

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| IVS-01 | Is network segmentation implemented? | Yes | Cloudflare Tunnel, no public ports |
| IVS-02 | Are firewalls/WAF configured? | Yes | Cloudflare WAF + rate limiting |
| IVS-03 | Is infrastructure monitored? | Yes | Sentry, `database-monitoring.md` |

### LOG — Logging & Monitoring

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| LOG-01 | Are security events logged? | Yes | `audit_events` table, Sentry |
| LOG-02 | Are logs protected from tampering? | Yes | Append-only table, RLS |
| LOG-03 | Are logs reviewed? | Yes | Admin dashboard, `database-monitoring.md` |

### SEF — Security Incident Management

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| SEF-01 | Is there an incident response plan? | Yes | `incident-response-plan.md` |
| SEF-02 | Are incidents investigated? | Yes | `tabletop-exercise-2026-04-12.md` |
| SEF-03 | Are breach notifications sent? | Yes | Per jurisdiction requirements (72hr GDPR/Kenya/Nigeria) |

### STA — Supply Chain, Transparency & Accountability

| ID | Question | Answer | Evidence |
|----|----------|--------|----------|
| STA-01 | Is there a vendor risk program? | Yes | `vendor-register.md` |
| STA-02 | Are dependencies tracked? | Yes | `license-audit.md`, SBOM generation planned |
| STA-03 | Are SLAs defined? | Yes | Enterprise SLA terms |

---

## Next Steps

1. Complete remaining CAIQ questions (full 261-question assessment)
2. Submit to CSA STAR Registry at https://cloudsecurityalliance.org/star/registry
3. Add CSA STAR badge to `/enterprise` page
4. Schedule annual reassessment

## References

- CSA STAR Registry: https://cloudsecurityalliance.org/star
- CAIQ v4.0.3: https://cloudsecurityalliance.org/artifacts/consensus-assessments-initiative-questionnaire-v4-0-3
