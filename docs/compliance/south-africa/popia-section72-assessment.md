# POPIA Section 72 — Cross-Border Transfer Assessment

_Story: REG-21 (SCRUM-582) — POPIA Section 72 Cross-Border Assessment_
_Legal basis: Protection of Personal Information Act 4 of 2013, Section 72_
_Status: NOT STARTED — SCCs drafted, assessment framework pending_

---

## Overview

POPIA Section 72 restricts the transfer of personal information of South African data subjects to third parties in foreign countries. Arkova processes all data in the United States (Cloud Run worker, Stripe) and European Union (Supabase), so every data flow involving South African data subjects constitutes a cross-border transfer requiring a lawful basis.

---

## Section 72 conditions for lawful transfer

A responsible party may only transfer personal information to a recipient in a foreign country if **at least one** of the following conditions is met:

### Condition 1: Adequate protection (Section 72(1)(a))

The recipient is subject to:
- **(i)** Law, binding corporate rules, or binding agreement that provides an **adequate level of protection substantially similar to POPIA**; OR
- **(ii)** Binding agreement between the responsible party and the recipient that provides adequate protection

**Assessment for Arkova's transfer destinations:**

| Destination | Adequacy status | Mechanism |
|-------------|----------------|-----------|
| United States | **No adequacy** — no SA adequacy determination for US | Binding SCCs (condition (ii)) |
| European Union (Supabase) | **No formal adequacy** — but EU GDPR is generally considered substantially similar | Binding SCCs (condition (ii)) as precaution |

### Condition 2: Consent (Section 72(1)(b))

The data subject consents to the transfer.

**Arkova approach:** Not relied upon as primary basis. Consent is fragile (can be withdrawn) and impractical for institutional credential flows. Used only as supplementary basis where applicable.

### Condition 3: Contract performance (Section 72(1)(c))

The transfer is necessary for the performance of a contract between the data subject and the responsible party, or for pre-contractual measures taken in response to the data subject's request.

**Arkova approach:** Applicable where South African credential holders directly use Arkova. The core service (credential anchoring and verification) requires data to flow to US-based infrastructure.

### Condition 4: Contract in interest of data subject (Section 72(1)(d))

The transfer is necessary for the conclusion or performance of a contract in the interest of the data subject between the responsible party and a third party.

**Arkova approach:** Applicable where a South African institution (third party) contracts with Arkova to anchor credentials on behalf of their students/staff (data subjects).

### Condition 5: Benefit of data subject (Section 72(1)(e))

The transfer is for the benefit of the data subject and it is not reasonably practicable to obtain consent.

**Arkova approach:** Not relied upon.

---

## Binding agreement requirements (Section 72(1)(a)(ii))

Since the US does not have POPIA adequacy, Arkova must execute binding SCCs with South African institutional customers. These SCCs must provide:

### Minimum clauses

1. **Purpose limitation** — personal information processed only for specified, explicit credential anchoring and verification purposes
2. **Processing restriction** — processing only on documented instructions of the responsible party (institution)
3. **Confidentiality** — all persons processing data are bound by confidentiality obligations
4. **Security measures** — technical and organizational measures per POPIA Section 19:
   - TLS 1.3 in transit
   - AES-256 encryption at rest
   - RLS on every Supabase table
   - Zero Trust ingress (Cloudflare Tunnel)
   - AWS/GCP KMS for key management
   - MFA on admin access
   - Annual penetration testing
5. **Sub-processing** — no sub-processing without prior authorization; sub-processors bound by equivalent obligations
6. **Data subject rights** — assist the responsible party in responding to access, correction, and deletion requests
7. **Breach notification** — notify responsible party as soon as reasonably possible (POPIA Section 22 standard)
8. **Data return/deletion** — on termination, return or delete personal information
9. **Audit rights** — allow responsible party or their auditor to verify compliance

### SCC template

The South Africa-specific SCC annex is at: `../scc/annex-south-africa.md`

This annex supplements the base SCC template at `../scc/base-template.md` with POPIA-specific requirements including:
- Information Officer obligations
- Special personal information safeguards (Sections 26-33)
- POPIA breach notification timeline
- Section 107 penalty acknowledgment

---

## Data flow mapping

| Flow | Source | Destination | Data types | Transfer basis |
|------|--------|-------------|-----------|---------------|
| Credential upload | SA user's browser | Supabase (EU) | Fingerprint + metadata only (document stays on device) | Contract performance + SCCs |
| Anchoring | Supabase (EU) | Cloud Run worker (US) | Fingerprint + credential metadata | SCCs |
| Bitcoin anchor | Cloud Run worker (US) | Bitcoin mainnet | Fingerprint only (no personal data) | N/A — not personal information |
| Verification | Requester | Supabase (EU) → response | Credential metadata | Legitimate interest + SCCs |
| Billing | SA institution | Stripe (US) | Name, email, billing address | Contract performance + SCCs |
| Email | Cloud Run worker (US) | Resend (US) | Email address, notification content | Contract performance + SCCs |

**Key architectural safeguard:** Documents never leave the user's device (Constitution Section 1.6). Only PII-stripped metadata and fingerprints flow to Arkova's servers. This significantly reduces the risk profile of cross-border transfers.

---

## Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Information Regulator enforcement action for non-compliance | Low-Medium | High (ZAR 10M fine) | SCCs in place, Section 72 compliance documented |
| Data subject complaint about cross-border transfer | Low | Medium | Transparent privacy notice, easy rights exercise |
| Sub-processor breach exposes SA data | Low | High | Sub-processor agreements, breach notification chain |
| Section 72 adequacy list published, excluding US | Medium | Medium | SCCs already in place as fallback |
| POPIA amendment tightens Section 72 | Low | Medium | Monitor Information Regulator guidance |

---

## Arkova status

### Already completed
- [x] SCCs drafted with South Africa annex (`../scc/annex-south-africa.md`)
- [x] Client-side processing architecture eliminates raw document transfers
- [x] Encryption in transit (TLS 1.3) and at rest (AES-256)
- [x] RLS enforced on all tables
- [x] Data flow mapping documented (above)
- [x] Security measures documented (`../soc2-evidence.md`)

### Remaining actions
- [ ] **Complete Section 72 assessment** — formal sign-off by legal counsel
- [ ] **Execute SCCs** with South African institutional customers at onboarding
- [ ] **Publish SA-specific privacy notice** (REG-22) disclosing cross-border transfers
- [ ] **Register Information Officer** (REG-20) — required before processing
- [ ] **Monitor Information Regulator** for adequacy determinations and updated guidance
- [ ] **Annual review** — reassess data flows and transfer mechanisms
- [ ] **Document sub-processor list** — maintain current list for SA institutional customers

---

## Key legal references

- POPIA Section 72: Transborder information flows
- POPIA Section 19: Security safeguards
- POPIA Section 22: Notification of security compromises
- POPIA Sections 26-33: Special personal information
- POPIA Section 107-109: Offences, penalties, and administrative fines
- Information Regulator Guidance Note on Cross-Border Transfers (when published)

---

_Last updated: 2026-04-14 | Status: NOT STARTED — SCCs drafted, formal assessment pending legal review_
