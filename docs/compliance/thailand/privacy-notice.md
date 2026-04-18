# Thailand Privacy Notice — Personal Data Protection Act 2019 (PDPA)

> **Version:** 1.0 | **Date:** 2026-04-17 | **Classification:** PUBLIC
> **Legal basis:** Personal Data Protection Act B.E. 2562 (2019); PDPC subordinate regulations 2022–2025
> **Regulator:** Personal Data Protection Committee (PDPC) — https://www.pdpc.or.th/
> **Jira:** SCRUM-725 (INTL-05) | **Owner:** Arkova Legal
> **Status:** DRAFT — awaiting Thai counsel review

---

## 1. Scope

This notice applies to data subjects in Thailand whose personal data is processed by Arkova Inc. in connection with credential verification services. Arkova acts as **Data Controller** when processing on its own account, and as **Data Processor** when acting under the instructions of an institutional customer.

Thailand's PDPA applies extraterritorially under Section 5(2) when the processing relates to the offer of goods/services to data subjects in Thailand or the monitoring of their behaviour in Thailand.

---

## 2. Personal data we process

| Category | Examples | Legal basis (PDPA §24) |
|----------|----------|------------------------|
| General personal data | Name, email, organisation, credential type/issuer/dates, identifiers | Contract performance (§24(3)) or consent (§19) |
| Cryptographic fingerprints | SHA-256 hashes of user documents | Legitimate interest (§24(5)) — fraud prevention |
| Verification events | Who verified a credential, when, from which organisation | Contract performance (§24(3)) |
| Sensitive personal data | Medical / health credentials, disability attestations | **Explicit consent** (§26) |

Documents themselves never leave the data subject's device — only fingerprints and metadata are transmitted. See Arkova Constitution §1.6.

---

## 3. Purposes

- Credential verification for the data subject's employer / institution
- Anti-fraud detection on the credential ecosystem
- Compliance reporting to institutional customers
- Platform security and service delivery

---

## 4. Rights (PDPA §30–§37)

Data subjects in Thailand may exercise the following rights by emailing `privacy@arkova.ai`:

- **Access** a copy of their personal data (§30)
- **Receive** their data in a portable format (§31)
- **Object** to processing (§32)
- **Request deletion** / anonymisation (§33)
- **Request restriction** of processing (§34)
- **Rectify** inaccurate or incomplete data (§35)
- **Withdraw consent** (§19) at any time without retroactive effect
- **Lodge a complaint** with the PDPC

Arkova responds within **30 days** of a valid request (PDPC notification on response timelines, 2022).

---

## 5. Cross-border transfers

Arkova processes data in the United States. PDPA §28–§29 require one of:

- The destination country has adequate protection (PDPC adequacy decision — US is **not** currently on Thailand's adequacy list);
- Standard Contractual Clauses aligned with **ASEAN Model Contractual Clauses** or **GDPR SCCs referencing Thai law** (PDPC Notification 2022);
- Binding Corporate Rules approved by the PDPC;
- Explicit consent of the data subject with full disclosure of the risks.

**Arkova's basis:** SCCs executed per customer DPA, using the GDPR-SCC 2021 module referencing Thai PDPA, plus explicit consent during onboarding for sensitive categories. The SCC annex for Thailand is at `docs/compliance/thailand/scc-annex.md`.

---

## 6. Security

| Safeguard | Detail |
|-----------|--------|
| Encryption in transit | TLS 1.2+ |
| Encryption at rest | AES-256 (Supabase Postgres) |
| Access control | Row-level security (multi-tenant isolation) + MFA required on all admin access |
| Logging | Audit-trail with append-only semantics (immutable RLS) |
| Client-side processing | Documents stay on the device — only hashes + metadata leave |
| Incident response | Breach notification runbook targeting PDPA 72-hour window |

---

## 7. Retention

Credential metadata is retained while the underlying organisation subscription is active + 7 years thereafter to satisfy audit-trail requirements. Data subjects may request earlier deletion when there is no legal obligation to retain.

---

## 8. Breach notification

Arkova notifies the PDPC of a personal data breach within **72 hours** of becoming aware (PDPA §37(4) + PDPC Notification 2022).

Affected data subjects are notified in the same timeframe when the breach is likely to result in high risk to their rights and freedoms.

---

## 9. Data Protection Officer

PDPA §41 requires a DPO when the controller's core activities involve large-scale or systematic processing of personal data. Arkova meets this threshold for customers in Thailand.

| Field | Value |
|-------|-------|
| DPO name | Shared group DPO (to be designated — see REG-28) |
| DPO email | `dpo@arkova.ai` |
| Local representative (Thailand) | To be appointed via Thai counsel (PDPA §37(5)) |

---

## 10. Contact

| Purpose | Contact |
|---------|---------|
| Data protection queries / rights requests | `privacy@arkova.ai` |
| DPO | `dpo@arkova.ai` |
| PDPC (regulator) | https://www.pdpc.or.th/ · +66 2-141-6993 |

---

## 11. Changes to this notice

Material changes are communicated via in-app notice + email at least 30 days before taking effect. The effective date at the top of this notice is always updated.
