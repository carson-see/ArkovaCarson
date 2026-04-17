# ISO 27001:2022 + 27701 Gap Analysis (TRUST-06/TRUST-07)

**Organization:** Arkova, Inc.  
**Date:** 2026-04-17  
**Status:** GAP ANALYSIS  
**Target:** ISO 27001 + ISO 27701 certification (Q3-Q4 2026)  
**Estimated Cost:** $50-100K (combined)  
**Estimated Timeline:** 9-15 months  

## SOC 2 Overlap Assessment

Approximately 60-70% of ISO 27001 controls overlap with existing SOC 2 readiness work. Key overlaps:

| SOC 2 Criterion | ISO 27001 Control | Overlap |
|-----------------|-------------------|---------|
| CC6.1 (Access) | A.8.3 (Access restriction) | Full |
| CC6.7 (Data integrity) | A.8.24 (Cryptography) | Full |
| CC7.2 (Incident detection) | A.5.24 (Incident planning) | Full |
| CC8.1 (Change management) | A.8.32 (Change management) | Full |
| CC3.2 (Risk assessment) | A.5.3-5.6 (Risk management) | Partial |
| CC5.2 (Technology controls) | A.8.1-8.12 (Technology) | Partial |

---

## Annex A Controls Assessment (ISO 27001:2022)

### A.5 — Organizational Controls

| # | Control | Current State | Gap | Action Required |
|---|---------|--------------|-----|-----------------|
| A.5.1 | Policies for information security | Partial — CLAUDE.md Constitution exists | Need formal ISMS policy document | Draft ISMS policy |
| A.5.2 | Information security roles | Defined in code (admin/platform_admin) | Need formal role documentation | Document roles |
| A.5.3 | Segregation of duties | RLS enforces separation | Compliant | None |
| A.5.4 | Management responsibilities | Defined but informal | Need formal management commitment | Board resolution |
| A.5.5 | Contact with authorities | Incident response plan references regulators | Compliant | None |
| A.5.7 | Threat intelligence | Sentry monitoring, pen test results | Partial | Formalize threat intel process |
| A.5.8 | Information security in project management | Part of CLAUDE.md task execution | Partial | Integrate into formal SDLC |
| A.5.23 | Information security for cloud services | Supabase/Vercel/GCP assessments needed | Gap | Obtain cloud provider attestations |
| A.5.24 | Incident management planning | `incident-response-plan.md` exists | Compliant | Review annually |
| A.5.25 | Assessment of security events | Sentry alerting, audit logs | Compliant | None |
| A.5.26 | Response to security incidents | Plan documented, tabletop exercised | Compliant | None |
| A.5.29 | Information security during disruption | `disaster-recovery.md` exists | Compliant | None |
| A.5.30 | ICT readiness for business continuity | DR plan + test results | Compliant | None |
| A.5.36 | Conformance with policies | Self-audit, CLAUDE.md enforcement | Partial | Add formal compliance checks |

### A.6 — People Controls

| # | Control | Current State | Gap | Action Required |
|---|---------|--------------|-----|-----------------|
| A.6.1 | Screening | N/A (startup stage, <10 employees) | Low risk | Implement for growth |
| A.6.2 | Terms and conditions of employment | Standard employment agreements | Partial | Add security clauses |
| A.6.3 | Information security awareness | `security-training.md` exists | Compliant | Annual refresh |
| A.6.4 | Disciplinary process | Standard HR process | Compliant | None |
| A.6.5 | Responsibilities after termination | Access revocation process | Compliant | Document formally |
| A.6.7 | Remote working | Cloudflare zero trust | Compliant | None |
| A.6.8 | Information security event reporting | Sentry + incident plan | Compliant | None |

### A.7 — Physical Controls

| # | Control | Current State | Gap | Action Required |
|---|---------|--------------|-----|-----------------|
| A.7.1-7.14 | Physical security | N/A (cloud-only, no offices with servers) | Inherited | Rely on cloud provider attestations |

### A.8 — Technological Controls

| # | Control | Current State | Gap | Action Required |
|---|---------|--------------|-----|-----------------|
| A.8.1 | User endpoint devices | `endpoint-security.md` exists | Compliant | None |
| A.8.2 | Privileged access rights | Platform admin role, service role key | Compliant | None |
| A.8.3 | Information access restriction | RLS on all tables | Compliant | None |
| A.8.5 | Secure authentication | Supabase Auth, MFA available | Compliant | None |
| A.8.7 | Protection against malware | Client-side only — no file storage | N/A | None |
| A.8.8 | Management of technical vulnerabilities | Dependabot, pen testing | Partial | Formalize patching SLA |
| A.8.9 | Configuration management | Infrastructure as code, env vars | Compliant | None |
| A.8.12 | Data leakage prevention | Client-side processing (documents never leave device) | Compliant | Architecture uniquely strong |
| A.8.15 | Logging | `audit_events` table, Sentry | Compliant | None |
| A.8.16 | Monitoring activities | Sentry, health checks | Compliant | None |
| A.8.24 | Use of cryptography | SHA-256 fingerprinting, TLS 1.3, HMAC-SHA256 | Compliant | None |
| A.8.25 | Secure development lifecycle | CLAUDE.md TDD mandate, CI/CD, code review | Compliant | None |
| A.8.26 | Application security requirements | Zod validation, RLS, input sanitization | Compliant | None |
| A.8.28 | Secure coding | OWASP top 10 awareness, security mandate | Compliant | None |
| A.8.31 | Separation of development/test/production | Supabase local, staging, production | Compliant | None |
| A.8.32 | Change management | `change-management.md`, GitHub PRs | Compliant | None |

---

## ISO 27701 Privacy Extension

ISO 27701 extends ISO 27001 with privacy-specific controls. Arkova's client-side processing boundary simplifies many requirements.

| Area | Current State | Gap |
|------|--------------|-----|
| PII inventory | `data-classification.md` + GDPR Art. 30 records | Compliant |
| Purpose limitation | Defined in privacy policy | Compliant |
| Data minimization | Only fingerprints stored server-side | Compliant (architecture advantage) |
| Data subject rights | `/privacy` page, DPO designation | Compliant |
| Cross-border transfers | DPF, SCCs for Brazil/Singapore/Mexico | Compliant |
| Breach notification | Per-jurisdiction timelines documented | Compliant |
| Privacy by design | Client-side processing is privacy by design | Compliant (architecture advantage) |

---

## Cyber Essentials Plus Alignment (TRUST-07)

For UK market entry. CE+ requirements vs. current Arkova state:

| CE+ Requirement | Current State | Gap |
|-----------------|--------------|-----|
| Firewalls | Cloudflare Tunnel + WAF | Compliant |
| Secure configuration | Documented in CLAUDE.md | Compliant |
| User access control | Supabase Auth + RLS | Compliant |
| Malware protection | N/A (no file storage server-side) | N/A |
| Patch management | Dependabot, dependency updates | Partial — formalize SLA |

**Estimated CE+ cost:** $2-6.5K  
**Timeline:** 2-4 weeks after ISO 27001 gap remediation

---

## Implementation Roadmap

| Phase | Activities | Timeline | Cost |
|-------|-----------|----------|------|
| 1. Gap remediation | Formal ISMS policy, role documentation, management commitment | Months 1-3 | $5-10K |
| 2. ISMS implementation | Policies, procedures, risk treatment plan, internal audit | Months 3-6 | $15-25K |
| 3. Stage 1 audit | Documentation review | Month 7 | $10-15K |
| 4. Stage 1 remediation | Address findings | Months 7-9 | $5-10K |
| 5. Stage 2 audit | Effectiveness evaluation | Month 10-12 | $15-25K |
| 6. ISO 27701 extension | Privacy controls overlay (50% overlap with 27001) | Months 12-15 | $10-20K |

**Total estimated: $60-105K** (including ISO 27701 extension)
