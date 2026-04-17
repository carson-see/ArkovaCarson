# Thailand SCC Annex — PDPA-aligned Standard Contractual Clauses

> **Version:** 1.0 | **Date:** 2026-04-17 | **Classification:** CONFIDENTIAL
> **Legal basis:** PDPA §28–§29; PDPC Notification on the Criteria for the Protection of Personal Data Sent or Transferred to a Foreign Country (2022, updated 2024)
> **Pairs with:** `docs/compliance/scc/base-template.md` (Arkova base SCC template)
> **Jira:** SCRUM-725 (INTL-05) | **Owner:** Arkova Legal

This annex supplements the Arkova base Standard Contractual Clauses (SCCs) for transfers from a data exporter in Thailand to Arkova Inc. (United States) acting as processor. It is intended to be signed together with the base SCC template and the customer DPA.

When used alongside ASEAN Model Contractual Clauses (MCC), treat this annex as "additional safeguards" referenced in MCC Clause 5. When used alongside GDPR SCCs (EU Commission Decision 2021/914), treat this annex as the controller/processor-specific supplement aligning clauses to Thai PDPA terminology.

---

## 1. Parties

| Party | Role | Establishment |
|-------|------|----------------|
| Data exporter | Customer (the "Institution") | Thailand |
| Data importer | Arkova Inc. | United States (Delaware) |
| Data subjects | End-users of the Institution + verifiers | Located in Thailand |

---

## 2. Description of transfer (Annex I under PDPC Notification)

### Categories of data subjects
- Credential holders (employees, students, professionals)
- Verifying parties (third-party employers, licensing boards, auditors)

### Categories of personal data
- Contact identifiers (name, email, organisation)
- Credential metadata (type, issuer, dates, numbers)
- Cryptographic fingerprints (SHA-256 hashes; not reversible)
- Verification audit events (who, when, which credential, from which org)

### Sensitive personal data (PDPA §26)
- Health credentials (if institution enables healthcare module) — processed only with explicit consent
- Biometric-derived data — **none** (Arkova does not process biometrics)

### Frequency / nature
- Continuous; real-time API traffic during business hours + nightly batch anchoring

### Purpose
- Credential verification, anti-fraud detection, audit-trail generation

### Retention
- While subscription active + 7 years audit-trail retention; earlier deletion on valid §33 request

---

## 3. Importer obligations (PDPA equivalence)

The importer agrees to apply standards substantially similar to PDPA Sections 37 and 40, specifically:

| PDPA obligation | Importer control |
|-----------------|------------------|
| §37(1) Appropriate security measures | AES-256 at rest + TLS 1.2+ in transit; SOC 2 Type II underway; see `docs/compliance/soc2-evidence.md` |
| §37(2) Notify breach within 72 hours | Incident runbook targets 72-hour notification; see `docs/compliance/incident-response-plan.md` |
| §37(3) Data quality / accuracy | Extraction validated against authoritative sources; edit/rectification API exposed for data subject requests |
| §37(4) DPO / representative | Shared group DPO (`dpo@arkova.ai`); local representative appointed under §37(5) |
| §40 Processor obligations | Processes only on documented customer instructions; sub-processor list maintained at `docs/compliance/vendor-register.md` |

---

## 4. Sub-processors (Annex III)

The importer may engage the following sub-processors:

| Sub-processor | Purpose | Location |
|---------------|---------|----------|
| Supabase, Inc. | Database + authentication | US |
| Google LLC | Cloud Run hosting + Vertex AI (metadata extraction) | US |
| Cloudflare, Inc. | Edge network + Zero Trust access | US (global network) |
| Vercel, Inc. | Frontend hosting | US |
| Stripe, Inc. | Payment processing | US |
| Resend | Transactional email | US |
| AWS | KMS signing | US |

Any material change to the sub-processor list is notified to the exporter with **30 days' notice**; the exporter may object and terminate without penalty.

---

## 5. Data subject rights

Data subjects located in Thailand may exercise PDPA §30–§37 rights directly against the importer at `privacy@arkova.ai`. The importer commits to responding within **30 days** of a valid request and to notifying the exporter within **5 business days** of any right request it receives.

---

## 6. Onward transfer

Transfers outside the United States are limited to the sub-processors listed in §4. No onward transfer to a third country outside that list is permitted without prior written authorisation from the exporter and, if required, an updated adequacy assessment.

---

## 7. Government access requests

The importer will not disclose personal data in response to a governmental authority's request unless:

- Legally compelled under United States law;
- The request is narrowly targeted and proportionate (challenged if not);
- The exporter is notified unless such notice is prohibited by law.

A transparency report is published annually summarising the total volume of such requests.

---

## 8. Liability + indemnity

Aligned with the base SCC template Clause 12 (controller-to-processor) and the customer DPA. Importer liability is capped at 12 months of fees unless arising from a material breach of §3 of this annex, in which case liability is uncapped.

---

## 9. Governing law + dispute resolution

- Governing law: Thailand (for data subject rights + supervisory authority interactions).
- Dispute resolution: arbitration in Singapore under SIAC rules; PDPC retains exclusive jurisdiction for public-law enforcement.

---

## 10. Effect + termination

This annex takes effect on signature and remains in force for as long as the importer processes personal data under the customer DPA. Termination rights mirror the base DPA — plus the exporter's right to terminate within 30 days if the United States is added to a PDPC "inadequate jurisdictions" list without compensating safeguards.

---

## 11. Signatories

| Role | Name | Title | Date |
|------|------|-------|------|
| Data exporter | _[Customer name]_ | _[Title]_ | _[Date]_ |
| Data importer | Arkova Inc. | _[Signatory]_ | _[Date]_ |
