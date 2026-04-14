# NDPC Registration — Nigeria

_Story: REG-23 (SCRUM-584) — NDPC Registration_
_Legal basis: Nigeria Data Protection Act 2023 (NDPA), Sections 24-28; Nigeria Data Protection Commission (Establishment) Act 2023_
_Status: NOT STARTED — registration pending DPO appointment (REG-28) and data audit_

---

## Overview

The Nigeria Data Protection Act 2023 (NDPA) requires data controllers and processors to register with the Nigeria Data Protection Commission (NDPC) and conduct annual data protection audits. Arkova processes personal data of Nigerian data subjects (credential holders at Nigerian institutions, verification requesters), triggering registration obligations.

---

## Supervisory authority

**Name:** Nigeria Data Protection Commission (NDPC)
**Website:** https://ndpc.gov.ng
**Email:** info@ndpc.gov.ng
**Portal:** https://ndpc.gov.ng/Registration
**Phone:** +234 (0)9 461 5041
**Address:** No. 5 Dongorondami Close, Off IBB Boulevard, Maitama, Abuja, Nigeria

---

## Registration categories

The NDPA distinguishes between two categories based on the volume of data subjects processed:

### Data Controller/Processor of Major Importance

**Threshold:** Processes personal data of **200 or more data subjects** within any 6-month period.

**Additional obligations:**
- Register with NDPC
- Appoint a Data Protection Officer (DPO) with demonstrable competence
- Conduct annual Data Protection Audit by a licensed Data Protection Compliance Organization (DPCO)
- Submit audit report to NDPC
- Maintain a record of processing activities

### Data Controller/Processor of Minor Importance

**Threshold:** Processes personal data of **fewer than 200 data subjects** in any 6-month period.

**Obligations:**
- Register with NDPC (simplified process)
- May designate a DPO (not mandatory)
- Biennial audit (every 2 years)

### Arkova's classification

| Factor | Assessment |
|--------|-----------|
| Nigerian data subjects processed | Likely 200+ within 6 months once Nigerian institutions onboard |
| Classification | **Data Controller of Major Importance** (precautionary) |
| DPO requirement | **Mandatory** |
| Audit frequency | **Annual** |

---

## Registration requirements

### 1. Entity details

| Field | Value |
|-------|-------|
| Legal name | Arkova Inc. |
| Trading name | Arkova |
| Type of entity | Foreign private company |
| Country of incorporation | United States (Delaware) |
| Nigeria establishment | None (extraterritorial) |
| Website | https://arkova.ai |
| Contact email | privacy@arkova.ai |
| Role | Data Controller (also Data Processor for institutional customers) |

### 2. Data Protection Officer

| Field | Value |
|-------|-------|
| DPO name | _to be appointed — see REG-28_ |
| DPO email | dpo@arkova.ai |
| DPO phone | _pending_ |

**DPO requirements under NDPA:**
- Demonstrable competence in data protection law and practice
- Independent — no conflict of interest
- Directly reports to highest management level
- Must have knowledge of Nigerian data protection framework
- Contact details published and communicated to NDPC

### 3. Record of processing activities

Must include:
- Name and contact details of the controller/processor and DPO
- Purposes of processing
- Categories of data subjects and personal data
- Categories of recipients (including cross-border)
- Transfers to third countries and transfer safeguards
- Retention periods
- Description of technical and organizational security measures

### 4. Categories of data subjects

- Credential holders (students, graduates, licensed professionals at Nigerian institutions)
- Institutional staff (registrars, compliance officers, admins)
- Verification requesters (employers, regulators, auditors)

### 5. Categories of personal data

**Ordinary personal data:**
- Full name, date of birth
- Contact details (email, phone)
- Institutional affiliation, role/title
- Credential identifiers (student ID, registration number)
- Credential content (degree, certification, licence, qualification type + dates)

**Sensitive personal data:**
- Health credentials (medical licences, health professional registrations)
- Criminal record data (background check results, if applicable)

---

## Filing process

### Step 1: Create NDPC portal account

1. Navigate to https://ndpc.gov.ng/Registration
2. Create an organizational account
3. Select registration category: **Data Controller of Major Importance**

### Step 2: Complete registration form

Provide:
- Entity details (Section 1 above)
- DPO details (Section 2 above)
- Processing activities summary
- Cross-border transfer details
- Security measures description
- Privacy policy URL

### Step 3: Pay registration fee

| Category | Fee |
|----------|-----|
| Data Controller of Major Importance (foreign) | **NGN 500,000** (~$325 USD) — subject to NDPC fee schedule updates |
| Annual audit filing fee | **NGN 200,000** (~$130 USD) — estimated |

**Payment method:** Bank transfer or online payment via NDPC portal. Confirm current fees at https://ndpc.gov.ng before submission.

**Note:** Fee amounts are based on the NDPC's published fee schedule. Check the current schedule as fees may be updated.

### Step 4: Submit and await confirmation

- NDPC reviews the application
- Estimated processing time: **4-8 weeks**
- Registration certificate issued on approval

---

## Annual data protection audit

### Obligation

Data Controllers of Major Importance must conduct an annual Data Protection Audit and submit the report to NDPC.

### Audit scope

- Review of processing activities against NDPA requirements
- Assessment of security measures
- Verification of data subject rights procedures
- Cross-border transfer compliance check
- Breach notification readiness
- DPO function effectiveness

### Licensed DPCO requirement

The audit must be conducted by a **Data Protection Compliance Organization (DPCO)** licensed by NDPC. Arkova must engage a licensed Nigerian DPCO.

**Finding a DPCO:** NDPC publishes a list of licensed DPCOs at https://ndpc.gov.ng

### Audit timeline

| Activity | Deadline |
|----------|----------|
| Engage DPCO | Within 3 months of registration |
| Complete audit | Within 12 months of registration |
| Submit audit report to NDPC | Within 15 days of audit completion |
| Subsequent audits | Annually |

---

## Fees summary

| Item | Amount (estimated) | Frequency |
|------|-------------------|-----------|
| Registration (Major Importance) | NGN 500,000 (~$325 USD) | One-time |
| Annual audit filing | NGN 200,000 (~$130 USD) | Annual |
| DPCO audit engagement | NGN 1,000,000-3,000,000 (~$650-$1,950 USD) | Annual |

**Total estimated annual cost:** ~$1,100-$2,400 USD after initial registration

---

## Penalties for non-compliance

| Violation | Penalty |
|-----------|---------|
| Failure to register | Up to **NGN 10,000,000** (~$6,500 USD) or **2% of annual gross revenue** (whichever is greater) |
| Failure to conduct annual audit | Administrative sanctions + potential deregistration |
| Breach of data protection principles | Up to **NGN 10,000,000** or **2% of annual gross revenue** |
| Persistent non-compliance | Criminal sanctions |

---

## Arkova status

### Already completed
- [x] Privacy contact established: privacy@arkova.ai
- [x] SCCs drafted for Nigeria (see `../scc/annex-nigeria.md`)
- [x] Data retention policy documented (`../data-retention-policy.md`)
- [x] Security measures documented (`../soc2-evidence.md`)
- [x] Incident response plan documented (`../incident-response-plan.md`)
- [x] Client-side processing architecture (documents never leave user's device)

### Remaining actions
- [ ] **Designate DPO** (REG-28) — mandatory for Major Importance category
- [ ] **Create NDPC portal account** at https://ndpc.gov.ng/Registration
- [ ] **Complete registration form** with entity and processing details
- [ ] **Pay registration fee** — confirm current fee schedule
- [ ] **Engage licensed DPCO** for annual audit
- [ ] **Publish Nigeria-specific privacy notice** (REG-25)
- [ ] **Conduct first annual audit** within 12 months of registration
- [ ] **Submit audit report** to NDPC within 15 days of completion
- [ ] **Record registration certificate** details below
- [ ] **Set renewal/audit reminders** — annual cycle
- [ ] **Add compliance badge** to dashboard (REG-26)

---

## Registration details (to be completed on approval)

| Field | Value |
|-------|-------|
| Registration number | _pending_ |
| Registration category | Data Controller of Major Importance |
| Date submitted | _pending_ |
| Date approved | _pending_ |
| Certificate valid until | _pending_ |
| DPCO engaged | _pending_ |
| First audit due | _pending_ |

---

## Key legal references

- NDPA 2023, Sections 24-28: Registration obligations
- NDPA 2023, Section 29: Data Protection Officer
- NDPA 2023, Section 30: Record of processing activities
- NDPA 2023, Section 43: Cross-border transfer
- NDPA 2023, Section 46-48: Enforcement and penalties
- NDPC General Application and Implementation Directive 2025
- NDPC Registration Guidelines (https://ndpc.gov.ng)

---

_Last updated: 2026-04-14 | Status: NOT STARTED — blocked on DPO appointment (REG-28)_
