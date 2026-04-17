# Malaysia — Transfer Impact Assessment (TIA) Template

> **Version:** 1.0 | **Date:** 2026-04-17 | **Classification:** CONFIDENTIAL
> **Legal basis:** PDPA 2010 §129 as amended by Personal Data Protection (Amendment) Act 2024 (commenced April 2025); PDP Commissioner Guidance on Cross-Border Transfers 2025
> **Jira:** SCRUM-726 (INTL-06) | **Owner:** Arkova Legal

The Malaysian PDPA 2024 Amendment replaced the pre-2025 whitelist regime with a risk-based framework. This document is the standing Transfer Impact Assessment for transfers of personal data from Arkova's Malaysian institutional customers (exporter) to Arkova Inc. in the United States (importer).

It is intended to be re-reviewed annually and re-executed whenever there is a material change to the destination country's legal framework, the importer's security posture, or the scope of data transferred.

---

## 1. Transfer inventory

| Element | Value |
|---------|-------|
| Exporter | Malaysian institutional customer (the "Data User") |
| Importer | Arkova Inc. (Delaware, United States) |
| Importer role | Data Processor (per customer DPA) |
| Data subjects | Employees, students, credential holders, verifying parties |
| Categories of personal data | Contact identifiers; credential metadata; cryptographic fingerprints; verification audit events |
| Sensitive categories | Medical / health credentials (processed only on explicit consent of the data subject); biometric data: NONE |
| Volume | ≤ 100K records / customer / year (typical) |
| Frequency | Continuous (real-time API) |
| Retention | Active subscription + 7 years |
| Onward transfers | Sub-processors per `docs/compliance/vendor-register.md` (all US-based) |

---

## 2. Risk assessment (destination country — United States)

| Factor | Assessment | Mitigation / Rating |
|--------|-----------|---------------------|
| Sectoral privacy laws | FERPA (education), HIPAA (healthcare), CCPA/CPRA (CA consumers); no omnibus federal privacy law | Medium |
| Government surveillance | CLOUD Act + FISA §702 allow US government access to data held by US companies | Medium-High (primary residual risk) |
| Judicial redress for non-US persons | Limited historically; Executive Order 14086 (2022) established the Data Protection Review Court — untested in Malaysian context | Medium |
| Contractual enforceability | US courts enforce standard commercial contracts including SCCs; established DPA jurisprudence under CCPA | Low |
| Importer track record | No regulator actions; SOC 2 Type II underway; 24/24 audit findings resolved + 9 pentest findings resolved | Low |
| Incident response maturity | 72-hour runbook aligned with PDPA 2025 Breach Regulations; tested in annual tabletop exercise | Low |

**Composite residual risk:** Medium-Low, concentrated in government-access risk. All other factors are mitigated by Arkova's architecture + contractual safeguards.

---

## 3. Technical safeguards

| Safeguard | Detail | Addresses |
|-----------|--------|-----------|
| Client-side processing | Documents never leave the user's device | Reduces volume of data exposed to US jurisdiction |
| Cryptographic fingerprints | SHA-256 one-way hashes; not reversible | Downgrades attack surface — fingerprints alone cannot identify individuals without corroborating data |
| RLS multi-tenant isolation | Database-level enforcement of org boundary | Prevents cross-tenant government-compelled disclosure from affecting unrelated exporters |
| Encryption at rest + in transit | AES-256 / TLS 1.2+ | Mitigates bulk collection risk |
| Hardware-backed key management | AWS KMS + GCP KMS for signing keys | Compels lawful process to reach discrete keys rather than bulk key material |
| MFA on admin access | FIDO2 hardware keys required | Mitigates account takeover |
| Append-only audit log | Immutable RLS-protected events | Enables reconstruction of any disclosure |

---

## 4. Contractual safeguards

| Safeguard | Reference |
|-----------|-----------|
| Customer DPA | `docs/contracts/dpa-template.md` |
| Malaysian annex to SCCs | _(this doc + `scc/base-template.md`)_ |
| Sub-processor notification | 30-day notice before onboarding any new sub-processor |
| Government access pushback | Arkova challenges any overbroad request and notifies the exporter unless legally prohibited |
| Transparency report | Published annually (total government request volume, categories, outcomes) |
| Audit right | Exporter may audit importer's compliance once per calendar year + upon any material incident |

---

## 5. Organisational safeguards

- Privacy team reporting to General Counsel
- DPO designated + registered with PDP Commissioner
- Annual privacy training for all engineers + support staff
- Quarterly access review (see `docs/compliance/access-review-log.md`)
- Incident response runbook tested annually (see `docs/compliance/tabletop-exercise-*.md`)
- Sub-processor onboarding due diligence checklist

---

## 6. Residual risk decision

After applying the safeguards in Sections 3–5, the residual risk is assessed as **acceptable** for the categories of data described in Section 1, subject to:

- No transfer of biometric data;
- Sensitive health credentials only with explicit data subject consent;
- Review triggered by any:
  - Material change to US surveillance law;
  - Material incident at the importer or a sub-processor;
  - Change to the importer's security controls documented in this assessment;
  - PDP Commissioner guidance update.

---

## 7. Annual review

| Review date | Reviewer | Decision | Changes |
|-------------|----------|----------|---------|
| 2026-04-17 | Arkova Legal (initial) | Acceptable | Initial assessment |
| 2027-04-17 | _pending_ | _pending_ | _pending_ |

---

## 8. Sign-off

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Data User DPO (Malaysia) | _[Customer DPO]_ | _[Signature]_ | _[Date]_ |
| Arkova DPO | _[DPO name]_ | _[Signature]_ | _[Date]_ |
| Arkova General Counsel | _[GC name]_ | _[Signature]_ | _[Date]_ |
