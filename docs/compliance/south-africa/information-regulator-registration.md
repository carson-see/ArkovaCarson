# Information Regulator Registration — South Africa

_Story: REG-20 (SCRUM-581) — Information Regulator Registration_
_Legal basis: Protection of Personal Information Act 4 of 2013 (POPIA), Sections 55-58; Regulations Relating to the Protection of Personal Information, 2018_
_Status: NOT STARTED — registration pending DPO appointment (REG-28)_

---

## Overview

POPIA Section 55 requires every responsible party (data controller) to designate an Information Officer and register with the Information Regulator. Since Arkova processes personal information of South African data subjects (credential holders, institutional staff, verification requesters), registration is required regardless of whether Arkova has a physical presence in South Africa.

---

## Supervisory authority

**Name:** Information Regulator (South Africa)
**Website:** https://www.justice.gov.za/inforeg/
**Email:** inforeg@justice.gov.za
**Physical address:** SALU Building, 316 Thabo Sehume Street, Pretoria, 0001
**Complaints:** complaints.IR@justice.gov.za
**Phone:** +27 (0)12 406 4818

---

## Registration requirements

### 1. Entity details

| Field | Value |
|-------|-------|
| Legal name | Arkova Inc. |
| Trading name | Arkova |
| Type of entity | Private limited company (foreign) |
| Country of incorporation | United States (Delaware) |
| South Africa establishment | None (extraterritorial — processes SA data subjects' information via internet) |
| Website | https://arkova.ai |
| Contact email | privacy@arkova.ai |
| Role | Responsible Party (POPIA term for data controller) |

### 2. Information Officer designation (Section 55-56)

Every responsible party must designate an Information Officer. For a private body, the head of the private body is the default Information Officer, but a deputy may be designated.

| Field | Value |
|-------|-------|
| Information Officer | _to be designated — see REG-28_ |
| Email | privacy@arkova.ai |
| Phone | _pending_ |

**Requirements for the Information Officer:**
- Must be registered with the Information Regulator (Form 1 — POPIA Regulations)
- Must ensure compliance with POPIA
- Must deal with requests from data subjects (access, correction, deletion)
- Must work with the Information Regulator during investigations
- Must ensure a compliance framework is developed and maintained

**Deputy Information Officers (Section 56(2)):**
- May designate one or more deputy Information Officers
- Deputies must be registered separately
- Useful if Arkova appoints a South African representative

### 3. Categories of personal information processed

**Ordinary personal information:**
- Full name, date of birth
- Contact details (email, phone)
- Institutional affiliation, role/title
- Credential identifiers (student ID, registration number)
- Credential content (degree, certification, licence, qualification type + dates)

**Special personal information (Sections 26-33):**
- Health credentials (medical licences, health professional registrations)
- Trade union membership (if disclosed in credentials)
- Criminal behavior data (background check results, if applicable)

### 4. Purposes of processing

| Purpose | Lawful basis (Section 11) |
|---------|--------------------------|
| Credential issuance and anchoring | Legitimate interest / contract performance |
| Credential verification by third parties | Legitimate interest (Section 11(1)(f)) |
| Fraud detection and audit | Legal obligation / legitimate interest |
| Service operation and analytics | Legitimate interest |
| Billing and account management | Contract performance |

### 5. Cross-border transfers

All personal data is processed in the United States and European Union (Supabase).

**Transfer mechanism under POPIA Section 72:**
- US does NOT have Section 72(1)(a)(i) adequacy status
- Transfers rely on binding SCCs executed with South African institutional customers — see `../scc/annex-south-africa.md`
- Additional safeguards: TLS 1.3, encryption at rest, RLS on all tables, client-side processing (documents never leave user's device)

---

## Required forms

### Form 1: Registration of Information Officer

**Where to get it:** https://www.justice.gov.za/inforeg/docs.html (Regulations, Form 1)

**Contents:**
- Full name and contact details of the Information Officer
- Name and address of the responsible party
- Description of categories of data subjects
- Description of personal information processed
- Recipients or categories of recipients
- Planned cross-border transfers
- Description of security measures (Section 19)

### Form 4: Notification of Processing (if required)

Section 57 allows the Information Regulator to require notification of specific processing activities. Currently not broadly enforced, but monitor for updates.

---

## Fees

| Item | Amount |
|------|--------|
| Information Officer registration | **Free** (no registration fee currently charged by the Information Regulator for Form 1 submission) |
| PAIA manual (Section 51) | Self-published, no fee |

**Note:** The Information Regulator may introduce registration fees in future regulations. Monitor https://www.justice.gov.za/inforeg/ for updates.

---

## Timeline

| Step | Estimated duration |
|------|--------------------|
| Designate Information Officer | 1-2 weeks (REG-28 dependency) |
| Prepare PAIA Section 51 manual | 1-2 weeks |
| Complete Form 1 | 1 day |
| Submit to Information Regulator | 1 day |
| Confirmation from Regulator | 2-8 weeks (variable) |

**Total estimated elapsed time:** 4-12 weeks from DPO appointment

---

## PAIA Section 51 manual

Under the Promotion of Access to Information Act (PAIA), every private body must compile a manual describing:
- Contact details of Information Officer
- Guide on how to make a PAIA request
- Categories of records held
- Description of records available without formal request
- Remedies available if a request is refused

This manual must be published on Arkova's website and a copy submitted to the Information Regulator.

---

## Arkova status

### Already completed
- [x] Privacy contact established: privacy@arkova.ai
- [x] SCCs drafted for South Africa (see `../scc/annex-south-africa.md`)
- [x] Data retention policy documented (`../data-retention-policy.md`)
- [x] Security measures documented (`../soc2-evidence.md`)
- [x] Incident response plan documented (`../incident-response-plan.md`)
- [x] Client-side processing architecture (documents never leave user's device)

### Remaining actions
- [ ] **Designate Information Officer** (REG-28 — DPO designation)
- [ ] **Prepare PAIA Section 51 manual** — publish on arkova.ai
- [ ] **Complete Form 1** — Information Officer registration
- [ ] **Submit Form 1** to Information Regulator (email or physical)
- [ ] **Publish privacy notice** for South African data subjects (REG-22)
- [ ] **Record confirmation** — store registration details below
- [ ] **Set renewal/review reminder** — annual compliance check
- [ ] **Add compliance badge** to dashboard (REG-26)

---

## Registration details (to be completed on confirmation)

| Field | Value |
|-------|-------|
| Registration reference | _pending_ |
| Date submitted | _pending_ |
| Date confirmed | _pending_ |
| Information Officer registered | _pending_ |
| PAIA manual published | _pending_ |

---

## Key legal references

- POPIA Sections 55-58: Information Officer duties and registration
- POPIA Section 19: Security safeguards
- POPIA Section 22: Breach notification
- POPIA Sections 26-33: Special personal information
- POPIA Section 72: Cross-border transfers
- POPIA Section 107: Penalties (up to ZAR 10,000,000 / ~$550,000 USD, or up to 10 years imprisonment)
- PAIA Section 51: Private body manual
- Regulations Relating to the Protection of Personal Information, 2018 (Form 1)

---

_Last updated: 2026-04-14 | Status: NOT STARTED — blocked on DPO appointment (REG-28)_
