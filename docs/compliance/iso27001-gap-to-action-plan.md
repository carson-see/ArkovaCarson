# ISO 27001:2022 — Gap-to-Action Plan

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson (CISO, dual-hat)
> **Jira:** SCRUM-965 (TRUST-08) | **Pairs with:** `iso27001-gap-analysis.md`
> **Next action:** engage external ISO-27001 Lead Auditor consultant (~$8-12k)

---

## Purpose

`iso27001-gap-analysis.md` (shipped 2026-04-17) lists every Annex A
control + its current state. This doc is the **next step**: turn each
gap into a ticketed action item with owner + deadline + evidence
artifact, plus identify which controls already satisfy multiple
frameworks (crosswalk wins).

## How to use this document

1. Read Section 3 — the crosswalk — first. Every "already have" row
   from the gap analysis is a free win; don't re-do work that SOC 2
   Type II evidence already covers.
2. Section 4 lists gaps by severity. File the P0 + P1 gaps as new
   Jira stories before engaging the external consultant (SCRUM-966
   TRUST-09).
3. Section 5 is the consultant engagement plan — what we expect from
   them, budget, timeline.
4. Section 6 tracks progress toward certification eligibility.

## 1. Standard + scope

- **Standard:** ISO/IEC 27001:2022 (revised October 2022, 93 Annex A
  controls across 4 themes: Organizational, People, Physical,
  Technological).
- **Scope statement:** Arkova's credential verification platform
  (frontend, API, edge worker, Supabase DB) — all SaaS infrastructure
  involved in processing customer credentials. Excludes: the
  corporate IT environment (email, HR tools), which is covered by
  Google Workspace compliance posture.

## 2. Certification body target

- **Target body:** BSI (UK) or A-LIGN (US) — both ANAB-accredited.
- **Target audit date:** Q3 2027 (after SOC 2 Type II attestation
  lands + 6 months of ISMS operation).

## 3. Framework crosswalk — controls we already have via SOC 2 / CE+ / CSA STAR

The 2022 revision consolidated the Annex A control set from 114 → 93.
Every row below is a control we already operate; ISO 27001 needs us to
document it in the ISMS, not invent it.

| ISO 27001 Annex A | Already covered by | Evidence path |
|-------------------|--------------------|---------------|
| A.5 Information Security Policies | SOC 2 CC5 | `docs/compliance/data-classification.md` et al. |
| A.6 Organization of Information Security | SOC 2 CC1 | `docs/compliance/dpo-designation.md` |
| A.7 Human Resource Security | SOC 2 CC1/CC6 | Security training log, background-check policy |
| A.8 Asset Management | SOC 2 CC6 | Vendor register, asset inventory |
| A.9 Access Control | SOC 2 CC6 | RLS policies + API-key HMAC + access-review log |
| A.10 Cryptography | SOC 2 CC6 + CE+ A.8 | GCP KMS, TLS 1.3, AWS KMS deprecation note |
| A.11 Physical Security | N/A (no offices/DCs) | Cloudflare + GCP + Supabase DC attestations |
| A.12 Operations Security | SOC 2 CC7/CC8 | Change management, monitoring |
| A.13 Communications Security | SOC 2 CC6 | TLS, Cloudflare Tunnel |
| A.14 System Acquisition | SOC 2 CC8 | Vendor evaluation process |
| A.15 Supplier Relationships | SOC 2 CC9 | Vendor register, DPAs |
| A.16 Incident Management | SOC 2 CC7 | `incident-response-plan.md` |
| A.17 Business Continuity | SOC 2 A1 | `disaster-recovery.md` |
| A.18 Compliance | SOC 2 PI1/P1 | 13 regulatory frameworks mapped |

**Net: ~85% of Annex A controls reused from SOC 2 Type II evidence.**

## 4. True gaps — items SOC 2 does NOT give us for free

### P0 (block certification)

- [ ] **Statement of Applicability (SoA)** — ISO-mandated document
  listing every Annex A control + applicability decision + implementation
  status. SOC 2 does not produce one. File new story TRUST-08-SoA.
- [ ] **ISMS manual** — a single "ISMS" document that ties policies,
  risk assessment, Statement of Applicability, internal audit plan,
  management review cadence, and the SoA into one binder. Usually
  30-50 pages. File new story TRUST-08-ISMS-Manual.
- [ ] **Internal audit program** — ISO requires at least one annual
  internal audit by a party independent from the control owners. Our
  SOC 2 audit doesn't satisfy ISO's internal audit (external audit
  ≠ internal audit). File new story TRUST-08-Internal-Audit.
- [ ] **Management review** — quarterly board-level review of the ISMS.
  SOC 2 has no direct equivalent. File new story TRUST-08-Mgmt-Review.

### P1 (required for the management system, not blocking the audit date)

- [ ] **Risk treatment plan** — more structured than SOC 2's risk
  register; must explicitly treat each identified risk with 1 of
  (avoid, transfer, mitigate, accept) and tie treatment to a control.
- [ ] **ISMS objectives** — measurable, time-bound ISMS objectives
  signed off by leadership. SOC 2 is criteria-based; ISO requires
  goal-based.
- [ ] **Nonconformity + corrective action register** — every exception
  must be logged with root cause + corrective action.

### P2 (polish; mostly documentation formatting)

- [ ] **Document control procedures** — versioning + approval workflow
  on every ISMS document. Current practice is git history + PR review;
  ISO wants a more explicit control-of-documented-information policy.
- [ ] **Competency records** — formal evidence that control owners are
  competent (training certs, years of experience).
- [ ] **Measurement, monitoring, analysis, evaluation** — structured
  quarterly KPI review against ISMS objectives.

## 5. External consultant engagement

Engage an **ISO 27001 Lead Auditor** (IRCA or equivalent accreditation)
for a 10-day sprint:

| Day | Outcome |
|-----|---------|
| 1-2 | ISMS scoping workshop + SoA draft |
| 3-4 | Risk treatment plan + risk register reformatting |
| 5-6 | ISMS manual first draft |
| 7 | Internal audit plan + competency register |
| 8 | Management review framework + KPI list |
| 9-10 | Gap-closure punch list + certification readiness report |

Budget: **$8,000 - $12,000** (US mid-market rate ~$150/hr; 10 days = ~$12k).
Funding: Year-1 TRUST budget.

## 6. Readiness tracker

| Milestone | Target date | Status |
|-----------|-------------|--------|
| Consultant engaged | 2026-07-01 | Pending (post-SOC 2 observation window opens) |
| SoA + ISMS manual v1 | 2026-09-01 | Not started |
| Internal audit #1 | 2026-12-01 | Not started |
| Management review #1 | 2027-01-15 | Not started |
| Certification audit application | 2027-04-01 | Not started |
| Stage 1 audit (documentation) | 2027-06-01 | Not started |
| Stage 2 audit (implementation) | 2027-09-01 | Not started |
| Certificate issued | 2027-10-15 | Not started |

## 7. Cross-links

- `iso27001-gap-analysis.md` — original control-by-control gap list.
- `docs/compliance/iso27701-privacy-extension-plan.md` (SCRUM-967) — adds
  privacy extension on top of 27001 certification.
- `docs/compliance/soc2-evidence-cadence.md` — the evidence that gets
  reused.

## 8. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial gap-to-action plan (SCRUM-965 TRUST-08). |
