# International Regulatory Compliance — Story Documentation
_Created: 2026-04-09 | Status: NOT STARTED (0/28 stories)_
_Epic: REG (Regulatory Compliance)_
_Jira Epic: SCRUM-551_
_Release: R-REG-01 — International Compliance v1 (Jira version 10054)_

---

## Overview

This epic addresses regulatory compliance gaps identified via the Compliance Dashboard (FERPA and HIPAA shown as "not yet evidenced") and expands Arkova's compliance footprint to key international markets: Kenya, Australia, South Africa, and Nigeria.

Arkova currently evidences 4/6 frameworks (SOC 2, GDPR, ISO 27001, eIDAS). This epic closes the remaining 2 gaps and adds 4 new jurisdictions, bringing total framework coverage to 10.

Several requirements overlap across jurisdictions and can be implemented once:
- **Data Subject Rights Workflow** — serves GDPR, Kenya, Australia, South Africa, Nigeria
- **Standard Contractual Clauses Template** — adapt per jurisdiction
- **Breach Notification Procedure** — core procedure with jurisdiction-specific timelines
- **Jurisdiction-Specific Privacy Notices** — templated approach

**Target personas:**
- University registrars (FERPA)
- Healthcare credentialing organizations (HIPAA)
- Kenyan, Australian, South African, Nigerian institutions
- SOC 2 / compliance auditors
- Enterprise procurement teams evaluating Arkova

---

## WORKSTREAM 1: FERPA SECTION 99.31 (P0)

_Legal basis: 20 U.S.C. Section 1232g; 34 CFR Part 99 (Sections 99.31-99.37)_

### REG-01: FERPA Disclosure Log (SCRUM-561)
**Priority:** P0 | **Effort:** Medium | **Type:** Code + Migration
**Jira:** SCRUM-561 | **Depends on:** None

**As a** university registrar,
**I want** every disclosure of education records to be logged with FERPA-required fields,
**so that** we can produce auditable records proving compliance with Section 99.32.

Section 99.32 requires maintaining a record of each disclosure including: requesting party identity, their legitimate interest, and linked to the education record. Must be retained as long as the education record exists.

#### Acceptance Criteria
- [ ] New `ferpa_disclosure_log` table (or `audit_events` extension) with fields: `requesting_party_name`, `requesting_party_type` (school_official | employer | government | accreditor | other), `legitimate_interest`, `education_record_ids[]`, `student_opt_out_checked`, `disclosure_exception` (which Section 99.31(a) subsection)
- [ ] Migration with RLS: org-scoped, read-only for ORG_ADMIN
- [ ] Verification API automatically logs disclosures for education credential types
- [ ] Exportable FERPA disclosure report (CSV/PDF) for institutional compliance audits
- [ ] Retention policy: retained as long as the credential record exists (no automatic purge)
- [ ] All text in `src/lib/copy.ts`, no banned terminology

#### Definition of Done
- Migration + RLS + types regenerated
- Tests written first (TDD), all green
- Confluence `02_data_model.md` + `04_audit_events.md` updated

---

### REG-02: Directory Information Opt-Out (SCRUM-562)
**Priority:** P0 | **Effort:** Medium | **Type:** Code + Migration
**Jira:** SCRUM-562 | **Depends on:** None

**As a** student whose education records are on Arkova,
**I want** to opt out of directory information disclosure,
**so that** my name, degree, and dates of attendance are not shared without my consent per Section 99.37.

#### Acceptance Criteria
- [ ] `directory_info_opt_out` boolean flag on credential/anchor records (per student, per institution)
- [ ] When opt-out is true, verification API responses suppress directory-level fields (name, degree type, dates)
- [ ] Institution-configurable: which metadata fields are "directory information" vs. education records
- [ ] Opt-out UI for recipients in their credential inbox
- [ ] Opt-out status checked and logged in disclosure log (REG-01)
- [ ] Bulk opt-out import for institutions (CSV with student IDs + opt-out status)

#### Definition of Done
- Migration + RLS + types regenerated
- Verification API conditionally suppresses fields
- Tests written first (TDD), all green

---

### REG-03: FERPA Data Use Agreement (SCRUM-563) Template
**Priority:** P0 | **Effort:** Small | **Type:** Documentation + Process
**Jira:** SCRUM-563 | **Depends on:** None

**As a** university compliance officer,
**I want** a FERPA-compliant Data Use Agreement,
**so that** our legal team can approve Arkova as a school official under Section 99.31(a)(1).

#### Acceptance Criteria
- [ ] DUA template covering: purpose limitation, re-disclosure prohibition (Section 99.33), data destruction timeline, audit access rights, legitimate educational interest definition
- [ ] Template reviewed against Section 99.31(a)(1) four-part test: (a) institutional function, (b) direct control, (c) PII purpose limitation, (d) annual notification criteria
- [ ] Re-disclosure notice included in verification API responses
- [ ] DUA acceptance integrated into onboarding for education-type organizations
- [ ] Template stored in `docs/compliance/ferpa-dua-template.md`

#### Definition of Done
- Template created and reviewed
- Onboarding flow updated (or flagged for future integration)

---

### REG-04: FERPA Requester Identity (SCRUM-568) Verification
**Priority:** P1 | **Effort:** Medium | **Type:** Code + Process
**Jira:** SCRUM-568 | **Depends on:** REG-01

**As a** platform operator,
**I want** to verify that API consumers have a legitimate educational interest or fall under a Section 99.31 exception,
**so that** we meet Section 99.31(c) identity authentication requirements.

#### Acceptance Criteria
- [ ] During API key provisioning, requester must declare their Section 99.31 exception category
- [ ] Institution type + purpose captured and stored with API key record
- [ ] Verification API logs the declared exception with each disclosure
- [ ] Rate limiting / bulk access detection to prevent harvesting
- [ ] Admin dashboard shows requester verification status

#### Definition of Done
- API key provisioning updated
- Tests written first (TDD), all green

---

## WORKSTREAM 2: HIPAA SECTION 164.312 (P0)

_Legal basis: 45 CFR Part 164, Subpart C (Security Rule), Section 164.312; Section 164.504(e) (BAA)_

### REG-05: HIPAA MFA Enforcement (SCRUM-564) for Healthcare Credentials
**Priority:** P0 | **Effort:** Medium | **Type:** Code
**Jira:** SCRUM-564 | **Depends on:** None

**As a** platform operator handling healthcare credentials,
**I want** MFA enforced when accessing credentials of healthcare-related types,
**so that** we meet Section 164.312(d) person/entity authentication requirements.

#### Acceptance Criteria
- [ ] MFA enforcement for credential types: INSURANCE, MEDICAL_LICENSE, IMMUNIZATION, or any credential from healthcare-classified organizations
- [ ] Supabase Auth TOTP (already supported) enforced conditionally
- [ ] User prompted to enable MFA on first healthcare credential access
- [ ] MFA bypass for non-healthcare credential types (no friction for education-only users)
- [ ] Audit event logged for MFA challenges and outcomes

#### Definition of Done
- MFA gate implemented
- Tests written first (TDD), all green

---

### REG-06: HIPAA Session Timeout (SCRUM-565)
**Priority:** P0 | **Effort:** Small | **Type:** Code
**Jira:** SCRUM-565 | **Depends on:** None

**As a** user accessing healthcare credentials,
**I want** my session to automatically terminate after inactivity,
**so that** unattended sessions cannot expose ePHI per Section 164.312(a)(2)(iii).

#### Acceptance Criteria
- [ ] Configurable inactivity timeout (default: 15 minutes for HIPAA contexts)
- [ ] Client-side idle detection (mouse/keyboard activity tracking)
- [ ] Session terminated with redirect to login on timeout
- [ ] Timeout value configurable per organization (admin setting)
- [ ] Audit event logged for session timeouts

#### Definition of Done
- Idle detection + session termination implemented
- Tests written first (TDD), all green

---

### REG-07: HIPAA Audit Report (SCRUM-566) Generator
**Priority:** P0 | **Effort:** Medium | **Type:** Code
**Jira:** SCRUM-566 | **Depends on:** None

**As a** HIPAA compliance officer,
**I want** an exportable audit report of all access to healthcare credentials,
**so that** we meet Section 164.312(b) audit control requirements.

#### Acceptance Criteria
- [ ] Audit report filterable by: date range, credential type (healthcare only), user, action type
- [ ] Report includes: who accessed what, when, from where (IP), what action (view/verify/export)
- [ ] Read access logged (not just mutations) for healthcare credential types
- [ ] Exportable as CSV and PDF
- [ ] Accessible to ORG_ADMIN and PLATFORM_ADMIN roles only
- [ ] Integrates with existing `audit_events` table (no separate logging system)

#### Definition of Done
- Report generator + read access logging implemented
- Tests written first (TDD), all green

---

### REG-08: HIPAA BAA Template (SCRUM-567)
**Priority:** P0 | **Effort:** Small | **Type:** Documentation
**Jira:** SCRUM-567 | **Depends on:** None

**As a** healthcare organization evaluating Arkova,
**I want** a HIPAA-compliant Business Associate Agreement,
**so that** our legal team can approve Arkova as a Business Associate under Section 164.504(e).

#### Acceptance Criteria
- [ ] BAA template covering all 11 Section 164.504(e) required provisions: permitted uses, safeguards commitment, breach reporting, subcontractor restrictions, individual access rights, amendment rights, accounting of disclosures, HHS access, PHI return/destruction, termination provisions
- [ ] 60-day breach notification timeline (BA to CE) documented
- [ ] BAA acceptance integrated into onboarding for healthcare-type organizations
- [ ] Template stored in `docs/compliance/hipaa-baa-template.md`

#### Definition of Done
- Template created covering all 11 required provisions

---

### REG-09: HIPAA Breach Notification (SCRUM-570) Procedure
**Priority:** P1 | **Effort:** Small | **Type:** Documentation + Process
**Jira:** SCRUM-570 | **Depends on:** None

**As a** platform operator,
**I want** a documented breach notification procedure for HIPAA,
**so that** we can meet the 60-day BA notification timeline under Section 164.410.

#### Acceptance Criteria
- [ ] Breach notification procedure documented in `docs/confluence/15_operational_runbook.md`
- [ ] 60-day timeline from discovery to covered entity notification
- [ ] Template notification letter identifying: affected individuals, information types, recommended actions
- [ ] Integration with Sentry alerting for breach detection
- [ ] Tabletop exercise scheduled (quarterly)

#### Definition of Done
- Procedure documented and reviewed

---

### REG-10: HIPAA Emergency Access (SCRUM-571) Procedure
**Priority:** P1 | **Effort:** Small | **Type:** Code + Documentation
**Jira:** SCRUM-571 | **Depends on:** None

**As a** platform operator,
**I want** a break-glass procedure for emergency ePHI access,
**so that** we meet Section 164.312(a)(2)(ii) emergency access requirements.

#### Acceptance Criteria
- [ ] Break-glass access mechanism: time-limited, dual-control approved, fully logged
- [ ] Emergency access logged with: who, what, why, duration, approver
- [ ] Automatic access revocation after time limit (e.g., 4 hours)
- [ ] Procedure documented in operational runbook

#### Definition of Done
- Break-glass mechanism implemented
- Tests written first (TDD), all green

---

## WORKSTREAM 3: SHARED INFRASTRUCTURE (P1)

### REG-11: Data Subject Rights (SCRUM-572) Workflow (Access + Portability)
**Priority:** P1 | **Effort:** Medium | **Type:** Code
**Jira:** SCRUM-572 | **Depends on:** None

**As a** data subject in any jurisdiction,
**I want** to request access to and export all my personal data,
**so that** I can exercise my rights under GDPR Art. 15, Kenya DPA Section 31, Australia APP 12, South Africa POPIA Section 23, and Nigeria NDPA.

Arkova already has GDPR erasure (anonymization). This story adds the remaining data subject rights.

#### Acceptance Criteria
- [ ] Self-service "Download My Data" button in Settings
- [ ] Export includes: profile, credentials, verification events, audit trail (user-scoped)
- [ ] Export format: JSON (machine-readable for portability) + human-readable summary
- [ ] Response within 30 days (automated = instant for self-service)
- [ ] Rate limited to prevent abuse (1 export per 24 hours)
- [ ] Data correction request form (for fields user can't self-edit)

#### Definition of Done
- Export endpoint + UI implemented
- Tests written first (TDD), all green

---

### REG-12: Standard Contractual Clauses (SCRUM-573) Framework
**Priority:** P1 | **Effort:** Medium | **Type:** Documentation + Legal
**Jira:** SCRUM-573 | **Depends on:** None

**As a** legal/compliance team,
**I want** a reusable SCC framework for cross-border data transfers,
**so that** we can serve Kenya, South Africa, Nigeria, and Australia without separate legal work per jurisdiction.

#### Acceptance Criteria
- [ ] Base SCC template covering: purpose limitation, data security obligations, sub-processor restrictions, data subject rights, breach notification, data return/destruction
- [ ] Jurisdiction-specific annexes for: Kenya (ODPC requirements), South Africa (Section 72), Nigeria (NDPC requirements), Australia (APP 8 obligations)
- [ ] SCC acceptance integrated into institutional customer onboarding
- [ ] Templates stored in `docs/compliance/scc/`

#### Definition of Done
- Base template + 4 annexes created

---

### REG-13: Unified Breach Notification (SCRUM-574) Procedure
**Priority:** P1 | **Effort:** Small | **Type:** Documentation
**Jira:** SCRUM-574 | **Depends on:** REG-09

**As a** platform operator,
**I want** a single breach notification procedure covering all jurisdictions,
**so that** we don't miss jurisdiction-specific timelines during an incident.

#### Acceptance Criteria
- [ ] Unified incident response procedure in `docs/confluence/15_operational_runbook.md`
- [ ] Jurisdiction-specific timelines documented:
  - HIPAA BA: 60 calendar days
  - Kenya ODPC: 72 hours (processor to controller: 48 hours)
  - Australia OAIC: 30-day assessment window
  - South Africa Information Regulator: as soon as reasonably possible
  - Nigeria NDPC: 72 hours
  - GDPR DPA: 72 hours (existing)
- [ ] Notification templates per regulator
- [ ] Decision tree: which regulators to notify based on affected data subjects' jurisdictions

#### Definition of Done
- Procedure documented with all timelines and templates

---

### REG-14: Jurisdiction-Specific Privacy (SCRUM-575) Notices
**Priority:** P1 | **Effort:** Small | **Type:** Code + Documentation
**Jira:** SCRUM-575 | **Depends on:** None

**As a** data subject,
**I want** to see a privacy notice referencing my jurisdiction's law,
**so that** I know my rights under my local data protection regime.

#### Acceptance Criteria
- [ ] Privacy page includes jurisdiction-specific sections for: FERPA, HIPAA, Kenya DPA 2019, Australia Privacy Act 1988, South Africa POPIA, Nigeria NDPA 2023
- [ ] Each section references: applicable law, regulator, data subject rights, cross-border transfer basis, breach notification procedure
- [ ] Auto-detect jurisdiction from organization's country setting (not geolocation)
- [ ] All text in `src/lib/copy.ts`

#### Definition of Done
- Privacy page updated
- Tests written first (TDD), all green

---

## WORKSTREAM 4: KENYA DPA 2019 (P1)

_Legal basis: Data Protection Act, No. 24 of 2019 (Kenya); Sections 25, 31-38, 41, 48, 56-57_

### REG-15: ODPC Registration (SCRUM-576) (Kenya)
**Priority:** P1 | **Effort:** Small | **Type:** Process
**Jira:** SCRUM-576 | **Depends on:** None

**As a** platform operator processing Kenyan education/healthcare credentials,
**I want** to register with the Office of the Data Protection Commissioner,
**so that** we comply with Kenya DPA Sections 56-57.

#### Acceptance Criteria
- [ ] Registration application submitted to ODPC
- [ ] Registration number obtained and displayed in Kenya privacy notice
- [ ] Annual renewal calendar reminder set
- [ ] Registration documentation stored in `docs/compliance/kenya/`

---

### REG-16: Kenya Data Protection (SCRUM-577) Impact Assessment
**Priority:** P1 | **Effort:** Medium | **Type:** Documentation
**Jira:** SCRUM-577 | **Depends on:** REG-15

**As a** compliance officer,
**I want** a DPIA for processing Kenyan education/healthcare credentials,
**so that** we can demonstrate compliance to the ODPC and identify risks.

#### Acceptance Criteria
- [ ] DPIA covering: processing activities, lawful basis (Section 25), cross-border transfer assessment (Section 48), security measures (Section 41), data subject rights implementation
- [ ] Risk assessment for sensitive personal data categories
- [ ] Submitted to ODPC if high-risk processing identified
- [ ] Stored in `docs/compliance/kenya/dpia.md`

---

## WORKSTREAM 5: AUSTRALIA PRIVACY ACT (P1)

_Legal basis: Privacy Act 1988 (Cth); Schedule 1 APPs; Part IIIC NDB scheme; Privacy and Other Legislation Amendment Act 2024_

### REG-17: APP 8 Cross-Border (SCRUM-578) Disclosure Assessment
**Priority:** P1 | **Effort:** Medium | **Type:** Documentation + Legal
**Jira:** SCRUM-578 | **Depends on:** REG-12

**As a** compliance officer,
**I want** a documented APP 8 assessment for Australian data processed in the US,
**so that** we can demonstrate reasonable steps to ensure overseas recipients comply with APPs.

Under Section 16C, Arkova remains **legally liable** for how overseas recipients handle Australian data.

#### Acceptance Criteria
- [ ] APP 8 assessment document covering: information sensitivity, recipient safeguards, potential harms, monitoring obligations
- [ ] Contractual provisions for Australian institutional customers (builds on REG-12 SCC framework)
- [ ] Ongoing monitoring obligations documented
- [ ] Penalties awareness documented (up to AUD 50 million or 30% turnover)
- [ ] Stored in `docs/compliance/australia/app8-assessment.md`

---

### REG-18: Australia Notifiable (SCRUM-579) Data Breach Procedure
**Priority:** P1 | **Effort:** Small | **Type:** Documentation
**Jira:** SCRUM-579 | **Depends on:** REG-13

**As a** platform operator,
**I want** an Australia-specific NDB procedure,
**so that** we can meet the 30-day assessment and OAIC notification requirements.

#### Acceptance Criteria
- [ ] 30-day assessment procedure documented
- [ ] OAIC notification template (online form reference)
- [ ] Individual notification template with required content: breach description, information types, recommended steps, contact details
- [ ] Integrated into unified breach procedure (REG-13)

---

### REG-19: Data Correction (SCRUM-580) Workflow (APP 13)
**Priority:** P2 | **Effort:** Small | **Type:** Code
**Jira:** SCRUM-580 | **Depends on:** REG-11

**As an** Australian data subject,
**I want** to request correction of my personal information,
**so that** I can exercise my rights under APP 13.

#### Acceptance Criteria
- [ ] Data correction request form in Settings
- [ ] 30-day response timeline tracked
- [ ] Correction applied or refusal with reasons provided
- [ ] Audit event logged for correction requests and outcomes
- [ ] Builds on REG-11 data subject rights workflow

---

## WORKSTREAM 6: SOUTH AFRICA POPIA (P2)

_Legal basis: Protection of Personal Information Act 4 of 2013; Sections 19-22, 72, 55-58_

### REG-20: Information Regulator (SCRUM-581) Registration (South Africa)
**Priority:** P2 | **Effort:** Small | **Type:** Process
**Jira:** SCRUM-581 | **Depends on:** None

**As a** platform operator processing South African data,
**I want** to register with the Information Regulator and designate an Information Officer,
**so that** we comply with POPIA registration requirements.

#### Acceptance Criteria
- [ ] Information Officer designated (can be same person as Kenya DPO)
- [ ] Registration submitted to Information Regulator
- [ ] Registration number displayed in South Africa privacy notice
- [ ] Documentation stored in `docs/compliance/south-africa/`

---

### REG-21: POPIA Section 72 (SCRUM-582) Cross-Border Assessment
**Priority:** P2 | **Effort:** Medium | **Type:** Documentation + Legal
**Jira:** SCRUM-582 | **Depends on:** REG-12

**As a** compliance officer,
**I want** a Section 72 adequacy assessment for US data processing,
**so that** we can demonstrate lawful cross-border transfer of South African personal information.

#### Acceptance Criteria
- [ ] Section 72 assessment: does the US provide "adequate protection" substantially similar to POPIA?
- [ ] If not adequate: binding agreement (SCC) covering POPIA requirements
- [ ] Special personal information handling documented (health information = heightened protection)
- [ ] Penalties awareness: ZAR 10 million fine or 10 years imprisonment
- [ ] Builds on REG-12 SCC framework with South Africa annex

---

### REG-22: South Africa Privacy (SCRUM-583) Notice
**Priority:** P2 | **Effort:** Small | **Type:** Documentation
**Jira:** SCRUM-583 | **Depends on:** REG-14

**As a** South African data subject,
**I want** a POPIA-compliant privacy notice,
**so that** I know my rights under South African law.

#### Acceptance Criteria
- [ ] Privacy notice section referencing POPIA, Information Regulator, data subject rights
- [ ] Information Officer contact details included
- [ ] Integrated into jurisdiction-specific privacy notices (REG-14)

---

## WORKSTREAM 7: NIGERIA NDPA (P2)

_Legal basis: Nigeria Data Protection Act 2023; General Application and Implementation Directive 2025_

### REG-23: NDPC Registration (SCRUM-584) (Nigeria)
**Priority:** P2 | **Effort:** Small | **Type:** Process
**Jira:** SCRUM-584 | **Depends on:** None

**As a** platform operator processing Nigerian data subjects,
**I want** to register with the Nigeria Data Protection Commission,
**so that** we comply with NDPA registration requirements.

#### Acceptance Criteria
- [ ] Determine if Arkova meets "data controller of major importance" threshold (200+ data subjects in 6 months)
- [ ] If yes: register with NDPC, appoint DPO with local expertise
- [ ] Registration documentation stored in `docs/compliance/nigeria/`

---

### REG-24: Nigeria Cross-Border (SCRUM-585) Transfer SCCs
**Priority:** P2 | **Effort:** Small | **Type:** Documentation
**Jira:** SCRUM-585 | **Depends on:** REG-12

**As a** compliance officer,
**I want** NDPA-compliant SCCs for Nigerian data transfers,
**so that** we can lawfully process Nigerian personal data in the US.

US does NOT have NDPC adequacy status. SCCs are required.

#### Acceptance Criteria
- [ ] Nigeria annex added to SCC framework (REG-12)
- [ ] Covers NDPA cross-border transfer requirements
- [ ] Reuses base SCC template with Nigeria-specific provisions

---

### REG-25: Nigeria Privacy (SCRUM-586) Notice
**Priority:** P2 | **Effort:** Small | **Type:** Documentation
**Jira:** SCRUM-586 | **Depends on:** REG-14

**As a** Nigerian data subject,
**I want** an NDPA-compliant privacy notice,
**so that** I know my rights under Nigerian law.

#### Acceptance Criteria
- [ ] Privacy notice section referencing NDPA 2023, NDPC, data subject rights
- [ ] Integrated into jurisdiction-specific privacy notices (REG-14)

---

## WORKSTREAM 8: COMPLIANCE DASHBOARD UPDATE (P1)

### REG-26: Update Compliance (SCRUM-587) Mapping for FERPA + HIPAA
**Priority:** P1 | **Effort:** Medium | **Type:** Code
**Jira:** SCRUM-587 | **Depends on:** REG-01, REG-05

**As a** user viewing the Compliance Dashboard,
**I want** FERPA and HIPAA to show as "evidenced" once their controls are implemented,
**so that** I can see 6/6 frameworks covered instead of 4/6.

#### Acceptance Criteria
- [ ] `complianceMapping.ts` updated: FERPA Section 99.31 control mapped to disclosure log + opt-out
- [ ] `complianceMapping.ts` updated: HIPAA Section 164.312 control mapped to MFA + audit + session timeout
- [ ] Compliance Dashboard shows 6/6 (or more with international frameworks)
- [ ] New compliance badges for Kenya DPA, Australia Privacy Act, POPIA, NDPA (greyed out until evidenced)
- [ ] Control evidence links point to relevant audit reports

#### Definition of Done
- Compliance mapping updated
- Tests written first (TDD), all green
- Dashboard shows updated coverage

---

### REG-27: International Framework (SCRUM-588) Badges
**Priority:** P2 | **Effort:** Small | **Type:** Code
**Jira:** SCRUM-588 | **Depends on:** REG-26

**As a** user viewing the Compliance Dashboard,
**I want** to see international framework badges (Kenya DPA, APP, POPIA, NDPA),
**so that** I can demonstrate multi-jurisdiction compliance to auditors.

#### Acceptance Criteria
- [ ] New framework entries in compliance mapping: Kenya DPA 2019, Australia Privacy Act 1988, South Africa POPIA, Nigeria NDPA 2023
- [ ] Each framework shows: badge, control count, evidenced status
- [ ] Badges activate as corresponding REG stories are completed
- [ ] ComplianceBadge component supports new framework types

---

### REG-28: DPO/Information Officer (SCRUM-589) Designation
**Priority:** P2 | **Effort:** Small | **Type:** Process
**Jira:** SCRUM-589 | **Depends on:** None

**As a** platform operator serving multiple African jurisdictions,
**I want** a single DPO/Information Officer covering Kenya, South Africa, and Nigeria requirements,
**so that** we have a named responsible person for all data protection inquiries.

#### Acceptance Criteria
- [ ] DPO designated (single person or role)
- [ ] Contact details published in all jurisdiction-specific privacy notices
- [ ] DPO responsibilities documented covering: Kenya ODPC liaison, SA Information Regulator liaison, Nigeria NDPC liaison
- [ ] Annual training requirement documented

---

## Release Plan: R-REG-01 — International Compliance v1

### Sprint 1 — Close Dashboard Gaps (P0: FERPA + HIPAA)
_Target: 2 weeks_

| Story | Effort | Type | Jurisdiction |
|-------|--------|------|-------------|
| REG-01: FERPA Disclosure Log | Medium | Code + Migration | US |
| REG-02: Directory Info Opt-Out | Medium | Code + Migration | US |
| REG-03: FERPA DUA Template | Small | Documentation | US |
| REG-05: HIPAA MFA Enforcement | Medium | Code | US |
| REG-06: HIPAA Session Timeout | Small | Code | US |
| REG-07: HIPAA Audit Report | Medium | Code | US |
| REG-08: HIPAA BAA Template | Small | Documentation | US |

**Sprint goal:** FERPA and HIPAA show as "evidenced" on the Compliance Dashboard. 6/6 US frameworks covered.

### Sprint 2 — Shared Infrastructure + Kenya + Australia (P1)
_Target: 2 weeks_

| Story | Effort | Type | Jurisdiction |
|-------|--------|------|-------------|
| REG-04: FERPA Requester Verification | Medium | Code + Process | US |
| REG-09: HIPAA Breach Notification | Small | Documentation | US |
| REG-10: HIPAA Emergency Access | Small | Code + Documentation | US |
| REG-11: Data Subject Rights Workflow | Medium | Code | All |
| REG-12: SCC Framework | Medium | Documentation + Legal | All |
| REG-13: Unified Breach Procedure | Small | Documentation | All |
| REG-14: Jurisdiction Privacy Notices | Small | Code + Documentation | All |
| REG-15: Kenya ODPC Registration | Small | Process | Kenya |
| REG-16: Kenya DPIA | Medium | Documentation | Kenya |
| REG-17: Australia APP 8 Assessment | Medium | Documentation | Australia |
| REG-18: Australia NDB Procedure | Small | Documentation | Australia |
| REG-26: Compliance Dashboard Update | Medium | Code | All |

**Sprint goal:** Shared compliance infrastructure complete. Kenya and Australia legally ready.

### Sprint 3 — South Africa + Nigeria + Polish (P2)
_Target: 1 week_

| Story | Effort | Type | Jurisdiction |
|-------|--------|------|-------------|
| REG-19: Data Correction Workflow | Small | Code | Australia |
| REG-20: SA Information Regulator Registration | Small | Process | South Africa |
| REG-21: POPIA Section 72 Assessment | Medium | Documentation | South Africa |
| REG-22: South Africa Privacy Notice | Small | Documentation | South Africa |
| REG-23: Nigeria NDPC Registration | Small | Process | Nigeria |
| REG-24: Nigeria SCCs | Small | Documentation | Nigeria |
| REG-25: Nigeria Privacy Notice | Small | Documentation | Nigeria |
| REG-27: International Framework Badges | Small | Code | All |
| REG-28: DPO Designation | Small | Process | All |

**Sprint goal:** All 6 international jurisdictions covered. Compliance Dashboard shows 10/10 frameworks.

---

## Regulatory Quick Reference

| Jurisdiction | Law | Regulator | Breach Timeline | Penalties | Cross-Border |
|-------------|-----|-----------|-----------------|-----------|-------------|
| US (Education) | FERPA 34 CFR 99 | US Dept of Education | N/A (funding withdrawal) | Loss of federal funding | N/A |
| US (Healthcare) | HIPAA 45 CFR 164 | HHS OCR | 60 days (BA to CE) | $100-$50K per violation, $1.5M annual cap | BAA required |
| Kenya | DPA 2019 | ODPC | 72 hours | KES 5M (~$39K) or 1% turnover | SCCs required (no US adequacy) |
| Australia | Privacy Act 1988 | OAIC | 30-day assessment | AUD 50M or 30% turnover | APP 8 assessment + contract |
| South Africa | POPIA 2013 | Information Regulator | ASAP (reasonable) | ZAR 10M (~$550K) or 10 years prison | Section 72 adequacy or binding agreement |
| Nigeria | NDPA 2023 | NDPC | 72 hours | NGN 10M or 2% revenue | SCCs required (no US adequacy) |

---

## Related Documentation

- [34 CFR Section 99.31 — FERPA Consent Exceptions](https://www.law.cornell.edu/cfr/text/34/99.31)
- [45 CFR Section 164.312 — HIPAA Technical Safeguards](https://www.law.cornell.edu/cfr/text/45/164.312)
- `docs/compliance/` — Compliance templates and assessments
- `docs/confluence/15_operational_runbook.md` — Incident response procedures
- `src/lib/complianceMapping.ts` — Framework control mappings

---

## Change Log

| Date | Change |
|------|--------|
| 2026-04-09 | Initial creation — 28 stories across 8 workstreams, 3-sprint release plan, 6 jurisdictions |
