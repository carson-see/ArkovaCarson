# SOC 2 Type II Evidence Matrix

**Organization:** Arkova, Inc.  
**Target Audit Period:** 6 months (Q3-Q4 2026)  
**Criteria:** Trust Services Criteria (TSC) — Security, Availability, Processing Integrity  
**Status:** PREPARATION  

## Overview

This matrix maps SOC 2 Trust Services Criteria to Arkova's existing controls, evidence locations, and collection frequencies. Cross-references `soc2-evidence.md` for current evidence inventory.

Arkova's client-side processing boundary materially reduces audit scope: no PII or document content is stored server-side, eliminating entire categories of data handling controls.

---

## Common Criteria (CC)

### CC1 — Control Environment

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| CC1.1 | Entity demonstrates commitment to integrity | Code of conduct, CLAUDE.md Constitution | `CLAUDE.md`, HR docs | CEO | Annual |
| CC1.2 | Board exercises oversight | Board minutes, risk register | Board docs | CEO | Quarterly |
| CC1.3 | Management establishes structure | Org chart, role definitions | HR docs | CEO | Annual |
| CC1.4 | Commitment to competence | Job descriptions, training records | `security-training.md` | Engineering | Annual |
| CC1.5 | Accountability enforced | Performance reviews, access reviews | `access-review-log.md` | Engineering | Quarterly |

### CC2 — Communication & Information

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| CC2.1 | Internal communication | Engineering docs, Jira, Confluence | Jira project, Confluence space | Engineering | Continuous |
| CC2.2 | External communication | Privacy policy, terms of service | `/privacy`, `/terms` pages | Legal | As changed |
| CC2.3 | Communication with third parties | Vendor register, DPAs | `vendor-register.md` | Engineering | Annual |

### CC3 — Risk Assessment

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| CC3.1 | Objectives specified | Product roadmap, security objectives | `docs/BACKLOG.md` | CEO | Quarterly |
| CC3.2 | Risks identified and assessed | Risk register, DPIA | `trust-framework-roadmap.md`, Kenya `dpia.md` | Engineering | Semi-annual |
| CC3.3 | Fraud risk considered | Fraud detection (Nessie), abuse monitoring | `fraud-audit.ts`, `complianceMapping.ts` | Engineering | Continuous |
| CC3.4 | Changes identified | Change management process | `change-management.md` | Engineering | Continuous |

### CC4 — Monitoring Activities

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| CC4.1 | Ongoing monitoring | Sentry alerts, health checks | Sentry dashboard, `/api/health` | Engineering | Continuous |
| CC4.2 | Deficiencies communicated | Bug tracker, incident reports | Bug tracker spreadsheet | Engineering | As found |

### CC5 — Control Activities

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| CC5.1 | Controls selected and developed | RLS policies, Zod validation, HMAC keys | Migration files, `validators.ts` | Engineering | Per change |
| CC5.2 | Technology controls deployed | Branch protection, CI/CD, automated tests | GitHub settings, `vitest.config.ts` | Engineering | Continuous |
| CC5.3 | Controls through policies | CLAUDE.md Constitution (immutable rules) | `CLAUDE.md` Section 1 | Engineering | Per session |

### CC6 — Logical & Physical Access

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| CC6.1 | Logical access controls | Supabase Auth + RLS on all tables | RLS test suite (42 tests) | Engineering | Per migration |
| CC6.2 | Prior to access, identity verified | Email verification, MFA (HIPAA) | Supabase Auth config | Engineering | Continuous |
| CC6.3 | Access provisioned/modified | Role-based access (user/admin/platform_admin) | `auth.ts`, RLS policies | Engineering | Per change |
| CC6.4 | Physical access restricted | N/A (cloud-hosted, no on-premise) | Supabase/GCP/Vercel SOC 2 reports | Engineering | Inherited |
| CC6.5 | Access is removed when no longer needed | Account deletion, session expiry | `data-retention-policy.md` | Engineering | Per request |
| CC6.6 | External threats mitigated | Cloudflare Tunnel, WAF, rate limiting | `endpoint-security.md` | Engineering | Continuous |
| CC6.7 | Data integrity in transmission/storage | SHA-256 fingerprinting, TLS 1.3, Bitcoin anchoring | `fileHasher.ts`, anchor lifecycle | Engineering | Continuous |
| CC6.8 | Unauthorized changes detected | Append-only audit log, content hashing | `audit_events` table | Engineering | Continuous |

### CC7 — System Operations

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| CC7.1 | Infrastructure changes detected | Deployment logs, Sentry releases | Vercel/GCP logs | Engineering | Continuous |
| CC7.2 | Incidents detected and reported | Sentry alerting, incident response plan | `incident-response-plan.md` | Engineering | Continuous |
| CC7.3 | Incidents resolved | Incident post-mortems | `tabletop-exercise-2026-04-12.md` | Engineering | Per incident |
| CC7.4 | Recovery procedures | Disaster recovery plan, backups | `disaster-recovery.md`, `dr-test-results/` | Engineering | Semi-annual |

### CC8 — Change Management

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| CC8.1 | Changes authorized, tested, approved | GitHub PRs, branch protection, CI checks | GitHub PR history | Engineering | Per change |

### CC9 — Risk Mitigation

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| CC9.1 | Vendor risk managed | Vendor register, DPAs | `vendor-register.md` | Engineering | Annual |
| CC9.2 | Vendor compliance monitored | SOC 2 reports from sub-processors | Supabase/GCP/Vercel SOC 2 reports | Engineering | Annual |

---

## Availability (A1)

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| A1.1 | Availability objectives maintained | 99.9% uptime target, Vercel edge | Vercel analytics | Engineering | Monthly |
| A1.2 | Environmental protections | N/A (cloud-hosted) | Inherited from cloud providers | Engineering | Inherited |
| A1.3 | Recovery from incidents | DR plan, backup restoration | `disaster-recovery.md` | Engineering | Semi-annual |

## Processing Integrity (PI1)

| # | Criterion | Control | Evidence Location | Responsible | Frequency |
|---|-----------|---------|-------------------|-------------|-----------|
| PI1.1 | Processing complete and accurate | Zod validation, content hash verification | `validators.ts`, anchor lifecycle | Engineering | Per transaction |
| PI1.2 | Inputs validated | Zod schemas on all write paths | Source code | Engineering | Per change |
| PI1.3 | Processing errors detected | Error logging, failed anchor monitoring | Sentry, `pipeline-health.ts` | Engineering | Continuous |

---

## Observation Period Tracking

| Month | Start Date | End Date | Evidence Collected | Issues Found | Status |
|-------|-----------|---------|-------------------|-------------|--------|
| 1 | TBD | TBD | | | Not started |
| 2 | TBD | TBD | | | Not started |
| 3 | TBD | TBD | | | Not started |
| 4 | TBD | TBD | | | Not started |
| 5 | TBD | TBD | | | Not started |
| 6 | TBD | TBD | | | Not started |

---

## Auditor Selection Criteria

| Firm | Specialization | Estimated Cost | SOC 3 Bundle | Notes |
|------|---------------|---------------|-------------|-------|
| Johanson Berenson | SaaS, startup-friendly | $35-45K | Yes | Good for first-time SOC 2 |
| Prescient Assurance | Cloud security | $40-50K | Yes | Technology-focused |
| A-LIGN | Compliance automation | $45-55K | Yes | Integrates with Vanta/Drata |
| Schellman | Comprehensive audits | $50-60K | Yes | Premium, deep technical |
