# Cross-Border Standard Contractual Clauses — Nigeria

_Story: REG-24 (SCRUM-585) — Nigeria Cross-Border SCCs_
_Legal basis: Nigeria Data Protection Act 2023 (NDPA), Section 43; General Application and Implementation Directive 2025_
_Status: NOT STARTED — SCC annex drafted, execution pending_

---

## Overview

NDPA Section 43 restricts the transfer of personal data of Nigerian data subjects to countries that do not provide an adequate level of data protection. Since the US does not have NDPC adequacy status, Arkova must implement appropriate safeguards for all cross-border transfers involving Nigerian data subjects. This document outlines the transfer framework, SCC requirements, and alternative mechanisms.

---

## NDPA Section 43 requirements

### Transfer conditions

Personal data may only be transferred to a foreign country if **at least one** of the following applies:

| Condition | NDPA reference | Applicability to Arkova |
|-----------|---------------|------------------------|
| Adequate protection in recipient country | Section 43(1)(a) | **Not available** — US has no NDPC adequacy determination |
| Binding contractual clauses (SCCs) | Section 43(1)(b) | **Primary mechanism** — SCCs executed with Nigerian institutional customers |
| Binding corporate rules (BCRs) | Section 43(1)(c) | Alternative — not currently used |
| Consent of data subject | Section 43(1)(d) | Supplementary only — not primary basis |
| Contract performance | Section 43(1)(e) | Applicable for direct credential holders |
| Important public interest | Section 43(1)(f) | Not applicable |
| Legal claims | Section 43(1)(g) | Not applicable |
| Vital interests | Section 43(1)(h) | Not applicable |

### NDPC approval

Section 43(2) provides that the NDPC may require **prior approval** for specific cross-border transfers. Monitor NDPC guidance for any approval requirements that may apply to Arkova's processing categories.

---

## Adequacy determination process

### How NDPC assesses adequacy

The NDPC evaluates whether a foreign country provides adequate protection by considering:

1. **Rule of law** — respect for human rights and fundamental freedoms
2. **Data protection legislation** — existence and effectiveness of data protection laws
3. **Supervisory authority** — existence of an independent data protection authority with enforcement powers
4. **International commitments** — treaties, conventions, and multilateral agreements relating to data protection

### Current adequacy list

As of 2026-04-14, NDPC has **not published a formal adequacy list**. This means all cross-border transfers require alternative safeguards (SCCs, BCRs, or other Section 43 conditions).

### Monitoring

- Check https://ndpc.gov.ng periodically for adequacy determinations
- If US receives adequacy status, SCCs remain valid but may be simplified

---

## Standard Contractual Clauses

### SCC annex for Nigeria

The Nigeria-specific SCC annex is at: `../scc/annex-nigeria.md`

This annex supplements the base SCC template at `../scc/base-template.md` with NDPA-specific requirements.

### Required SCC provisions

The binding contractual clauses must include:

**1. Processing instructions**
- Personal data processed only in accordance with documented instructions from the data controller (Nigerian institution)
- No processing beyond what is necessary for the specified purposes

**2. Confidentiality**
- All persons authorized to process data are under confidentiality obligations
- Access limited to personnel who need it for their duties

**3. Security measures**
- Appropriate technical and organizational measures including:
  - TLS 1.3 encryption in transit
  - AES-256 encryption at rest
  - Row-Level Security on all database tables
  - Zero Trust network ingress (Cloudflare Tunnel)
  - AWS/GCP KMS for cryptographic key management
  - MFA on administrative access
  - Annual penetration testing

**4. Sub-processing**
- No sub-processing without prior written authorization
- Sub-processors bound by equivalent data protection obligations
- Current sub-processors:

| Sub-processor | Location | Purpose | Safeguard |
|--------------|----------|---------|-----------|
| Supabase | EU | Database + Auth | SCCs + DPA |
| Google Cloud | US | Worker (Cloud Run) | SCCs + DPA |
| Cloudflare | US/Global | Tunnel + Edge | SCCs + DPA |
| Stripe | US | Billing | SCCs + DPA |
| Resend | US | Transactional email | SCCs + DPA |
| Sentry | US | Error tracking (PII-scrubbed) | SCCs + DPA |

**5. Data subject rights**
- Assist controller in responding to data subject requests (access, rectification, erasure, portability, objection, restriction)
- Response within timeframes set by NDPA

**6. Breach notification**
- Processor (Arkova) to Controller: **48 hours** from discovery (per base SCC Clause 5)
- Controller to NDPC: **72 hours** from discovery
- Controller to data subjects: without undue delay where breach is likely to result in high risk

**7. Data return/deletion**
- On termination, return or securely delete all personal data
- Provide certification of deletion on request

**8. Audit rights**
- Controller or their appointed auditor may verify compliance
- Arkova will cooperate with reasonable audit requests

---

## Binding Corporate Rules (alternative)

### When to consider BCRs

BCRs are an alternative to per-contract SCCs, suitable when:
- Arkova has an intra-group structure requiring regular data transfers
- Multiple Nigerian institutional customers would benefit from a single approved framework
- NDPC publishes BCR approval procedures

### BCR requirements under NDPA

- Legally binding on all members of the group
- Expressly confer enforceable rights on data subjects
- Specify the general data protection principles, data subject rights, and appropriate safeguards
- Include mechanisms for ensuring compliance (audits, complaint handling)
- Require NDPC approval before reliance

### Current assessment

**BCRs are not currently pursued.** Arkova is not part of a corporate group requiring intra-group transfers. SCCs executed per-customer are the appropriate mechanism. Reassess if:
- Arkova establishes subsidiaries in other jurisdictions
- NDPC publishes formal BCR approval procedures
- Volume of Nigerian institutional customers makes per-contract SCCs impractical

---

## Data flow mapping (Nigeria-specific)

| Flow | Source | Destination | Data | Transfer basis |
|------|--------|-------------|------|---------------|
| Credential upload | NG user's browser | Supabase (EU) | Fingerprint + metadata only | Contract + SCCs |
| Anchoring | Supabase (EU) | Cloud Run (US) | Fingerprint + metadata | SCCs |
| Bitcoin anchor | Cloud Run (US) | Bitcoin mainnet | Fingerprint only | N/A — not personal data |
| Verification | Requester | Supabase (EU) → response | Credential metadata | Legitimate interest + SCCs |
| Billing | NG institution | Stripe (US) | Billing details | Contract + SCCs |
| Notifications | Cloud Run (US) | Resend (US) | Email + content | Contract + SCCs |

**Architectural safeguard:** Documents never leave the user's device (Constitution Section 1.6). Only PII-stripped metadata and fingerprints cross borders. This dramatically reduces the scope and risk of cross-border transfers.

---

## Arkova status

### Already completed
- [x] SCC base template drafted (`../scc/base-template.md`)
- [x] Nigeria-specific SCC annex drafted (`../scc/annex-nigeria.md`)
- [x] Client-side processing architecture (documents never leave user's device)
- [x] Sub-processor list documented (above)
- [x] Security measures documented (`../soc2-evidence.md`)
- [x] Data retention policy documented (`../data-retention-policy.md`)

### Remaining actions
- [ ] **Legal review** of Nigeria SCC annex by Nigerian data protection counsel
- [ ] **Finalize SCC execution workflow** — integrate into Nigerian institutional customer onboarding
- [ ] **Register with NDPC** (REG-23) — registration required before processing
- [ ] **Publish Nigeria privacy notice** (REG-25) disclosing cross-border transfers and safeguards
- [ ] **Execute SCCs** with first Nigerian institutional customer
- [ ] **Monitor NDPC** for adequacy determinations and updated transfer guidance
- [ ] **Annual review** — reassess data flows, sub-processor list, and transfer mechanisms
- [ ] **Assess BCR need** — revisit if customer volume or corporate structure changes

---

## Key legal references

- NDPA 2023, Section 43: Transfer of personal data outside Nigeria
- NDPA 2023, Section 44: Conditions for transfer
- NDPA 2023, Section 28: Security of personal data
- NDPA 2023, Section 38-42: Data subject rights
- NDPA 2023, Section 46-48: Enforcement and penalties
- NDPC General Application and Implementation Directive 2025
- NDPC Cross-Border Transfer Guidelines (when published)

---

_Last updated: 2026-04-14 | Status: NOT STARTED — SCC annex drafted, execution and legal review pending_
