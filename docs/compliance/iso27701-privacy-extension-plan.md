# ISO 27701 — Privacy Information Management Extension Plan

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson (CISO) + future DPO
> **Jira:** SCRUM-967 (TRUST-10) | **Depends on:** SCRUM-966 (ISO 27001 certified first)
> **Target certificate:** 2028-Q1 (~6 months after ISO 27001 issuance)

---

## Purpose

ISO 27701 is NOT a standalone standard — it's a **privacy
information management system (PIMS) extension** layered on top of
an existing ISO 27001 certification. The standard adds ~150 new
controls on top of ISO 27001's Annex A, specifically for
personally-identifiable-information (PII) processing.

Why do it: enterprise privacy teams in the EU + APAC treat 27701 as
the gold-standard evidence that an organisation's privacy posture is
independently audited. Combined with GDPR + DPF (SCRUM-963), it
closes almost every privacy-oriented procurement question.

## How to use this document

1. Don't start 27701 work until 27001 is certified (SCRUM-966).
   Running them in parallel doubles the consultant load without
   proportional benefit.
2. Read Section 3 (scope + role) first — the controller/processor
   distinction decides which control family dominates.
3. Section 4 lists the PIMS-specific gap against our current state.
4. Section 5 is the procurement/budget.

## 1. Relationship to 27001

- ISO 27001: Information Security Management System (ISMS).
- ISO 27701: Privacy Information Management System (PIMS) that
  **extends** the ISMS. Not a replacement.
- A 27701 certificate is issued **alongside** the 27001 certificate;
  both come from the same audit body in a single surveillance cycle.
- The PIMS audit reuses most ISO 27001 evidence but adds ~65 new
  controls specifically for PII (Annex A + B of 27701:2019).

## 2. Relationship to GDPR + DPF + Kenya DPA + POPIA

ISO 27701 is the **system** that demonstrates compliance posture.
Specific regulatory regimes (GDPR, DPF, Kenya DPA, POPIA, APPI, etc.)
are the **legal frameworks** that the system must address. A well-run
PIMS produces the artifacts (RoPA, DPIA, breach-notification procedures,
DSR workflows) each regulation demands.

Mapping overview:

| Regulation | What 27701 gives you |
|-----------|----------------------|
| GDPR | Records of Processing Activity (Article 30) + DPIA template (Art. 35) |
| EU-US DPF | Self-certification evidence package |
| Kenya DPA | Registration + DPIA (SCRUM-577) |
| South Africa POPIA | Section 72 documentation |
| Japan APPI | Processing policy + retention schedule |
| India DPDP | Consent + purpose-limitation log |
| Nigeria NDPR | Annual data audit return |

## 3. Scope + role decision

ISO 27701 requires us to declare whether we operate as:

- **PII Controller** (we decide purposes + means of processing)
- **PII Processor** (we process on behalf of a controller)
- **Both** (depending on data flow)

**Arkova's position:**
- For Arkova-owned accounts + users: we are a **controller** (we
  decide purposes + means — e.g. billing emails, support outreach).
- For customer-anchored documents + their metadata: we are a
  **processor** (the customer / org is the controller; we process
  on their behalf per MSA Data Processing Addendum).
- Scope decision: **declare both roles**. The audit produces a
  per-role applicability statement.

## 4. Gap analysis — 27701-specific controls

ISO 27001 covers ~85% of 27701's overlap. The gaps are privacy-specific
controls we have NOT yet built. Filing each as a future story.

### For controller role (Annex A of 27701)

| Control | Status | Gap |
|---------|--------|-----|
| A.7.2.1 Identify + document purpose | Partial | Privacy notice lists purposes; no per-record log |
| A.7.2.2 Identify lawful basis | Partial | MSA says "legitimate interest + consent"; no per-processing record |
| A.7.3 PII principals obligations | Done | DSR workflow (SCRUM-REG-11 follow-up) |
| A.7.4.1 PII minimisation | Done | Client-side-only architecture (Constitution 1.6) |
| A.7.4.5 PII deletion + return | Partial | Retention policy lives; enforcement on anchor metadata is manual |
| A.7.5 Records of PII processing | **Missing** | No RoPA yet; file TRUST-10-RoPA |

### For processor role (Annex B of 27701)

| Control | Status | Gap |
|---------|--------|-----|
| B.8.2.1 Customer instructions | Done | MSA + DPA template |
| B.8.2.2 Sub-processor disclosure | Partial | Vendor register exists; customer-facing list at `arkova.ai/subprocessors` not live yet |
| B.8.2.3 PII disclosure to sub-processors | Done | DPAs on file |
| B.8.5 PII transfer | Done | DPF for EU transfers, SCCs for Swiss + gaps |
| B.8.6 Temporary files | **Missing** | No formal temp-file lifecycle doc for Cloud Run |

### Universal gaps (apply to both roles)

- [ ] Records of Processing Activity (GDPR Art 30 / ISO 27701 A.7.5).
  ~5-10 page document enumerating every processing activity, lawful
  basis, retention, recipients.
- [ ] PII-incident notification playbook (distinct from generic
  incident-response). Covers GDPR's 72-hour rule, Kenya ODPC's
  equivalent, POPIA's Section 22.
- [ ] Annual PII-risk assessment (DPIA refresh).
- [ ] Sub-processor public disclosure page at
  `arkova.ai/subprocessors` with change-notification mechanism.

## 5. Consultant engagement

Reuse the ISO 27001 Lead Auditor consultant (SCRUM-965). Add a
privacy-specialist (DPO-profile consultant) for the 27701-specific
gap-closure work. Separate engagement:

| Item | Budget |
|------|--------|
| Privacy consultant — 27701 gap closure (Q3 2027) | $6,000 - $10,000 |
| PIMS audit add-on (with 27001 certification body) | $8,000 - $12,000 |
| Annual surveillance add-on | $3,000/yr |
| **Year-1 incremental over 27001** | **~$15,000** |

## 6. Timeline (~6 months after 27001 cert)

| Milestone | Target | Status |
|-----------|--------|--------|
| 27001 certified | 2027-10-15 | Gated on SCRUM-966 |
| 27701 gap-closure consultant engaged | 2027-11-15 | Not started |
| RoPA v1 published | 2027-12-15 | Not started |
| DPIA refreshed | 2027-12-31 | Partial (Kenya DPIA shipped; needs refresh) |
| Sub-processors public page live | 2028-01-01 | Not started |
| 27701 Stage 1 audit (documentation) | 2028-01-15 | Not started |
| 27701 Stage 2 audit (implementation) | 2028-02-15 | Not started |
| Certificate issued | 2028-03-01 | Not started |

## 7. Cross-links

- `iso27001-implementation-roadmap.md` — the prerequisite.
- `iso27001-gap-to-action-plan.md` — the ISO 27001 scope.
- `docs/compliance/kenya/dpia.md` — existing DPIA that refreshes
  under 27701.
- `docs/compliance/eu-us-dpf-certification-runbook.md` (SCRUM-963) —
  DPF mechanism for the processor/controller EU transfer piece.

## 8. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial extension plan (SCRUM-967 TRUST-10). |
