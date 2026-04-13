# ODPC Registration Application Packet

_Story: REG-15 (SCRUM-576) — ODPC Registration_
_Legal basis: Data Protection Act 2019, Sections 56-57; Data Protection (Registration of Data Controllers and Data Processors) Regulations, 2021_
_Status: DRAFT — awaiting legal review + submission_

---

## Registration portal

**URL:** https://odpc.go.ke/online-registration/
**Alternative:** email `info@odpc.go.ke`, postal submission to Britam Tower, 17th Floor, Hospital Road, Upper Hill, Nairobi

---

## Required fields

### 1. Entity details

| Field | Value |
|-------|-------|
| Legal name | Arkova Inc. |
| Trading name | Arkova |
| Type of entity | Private limited company |
| Country of incorporation | United States (Delaware) |
| Kenya establishment | None (extraterritorial under DPA Section 4(2)(b)) |
| Postal/physical address (Kenya) | N/A — appointed representative required if no Kenya presence |
| Website | https://arkova.ai |
| Contact email | privacy@arkova.ai |
| Controller/Processor role | **Data Controller** (also acts as Data Processor for institutional customers) |

### 2. Appointed representative in Kenya (DPA Section 58)

Because Arkova has no physical establishment in Kenya, the DPA requires appointing a local representative to receive ODPC correspondence.

**Status: Kenyan legal counsel engaged as of 2026-04-11.** Representative details + signed letter of appointment to be filled in by counsel before portal submission.

- [x] Kenyan legal counsel engaged
- [ ] Representative firm named and contact details recorded
- [ ] Signed letter of appointment

### 3. Data Protection Officer (DPA Section 24)

| Field | Value |
|-------|-------|
| DPO name | _to be appointed — see REG-28_ |
| DPO email | dpo@arkova.ai |
| DPO phone | _pending_ |

### 4. Categories of data subjects

- Credential holders (students, graduates, licensed professionals)
- Institutional staff (registrars, compliance officers, admins)
- Verification requesters (employers, regulators, auditors)

### 5. Categories of personal data processed

**Ordinary personal data:**
- Full name, date of birth
- Contact details (email, phone)
- Institutional affiliation, role/title
- Credential identifiers (student ID, registration number)
- Credential content (degree, certification, licence, qualification type + dates)

**Sensitive personal data (DPA Section 2):**
- Health and medical credentials (HIPAA-equivalent data, where applicable)
- Biometric data (if future document-scanning features store biometrics)
- Professional licence status (potentially sensitive under Section 46 "significant effects" test)

### 6. Purposes of processing

| Purpose | Lawful basis (Section 30) |
|---------|--------------------------|
| Credential issuance and anchoring on Bitcoin mainnet | Performance of contract with institution |
| Credential verification by third parties | Legitimate interests (Section 30(1)(f)) |
| Fraud detection and audit | Legal obligation (anti-fraud regulations) |
| Service operation and analytics | Legitimate interests |
| Billing and account management | Performance of contract |
| Security and abuse prevention | Legitimate interests |

### 7. Recipients / third parties

- Institutional customers (data controllers in their own right)
- Verification requesters (pull-based; scoped by org permissions)
- Bitcoin mainnet (public ledger — **only fingerprints, never personal data**, per Constitution Section 1.6)
- Cloud infrastructure providers: Supabase (Postgres + Auth), Google Cloud (Cloud Run worker), Cloudflare (tunnel + edge)
- Stripe (billing)
- Resend (transactional email)
- Sentry (error tracking, PII-scrubbed per Constitution Section 1.1)

### 8. Cross-border transfers

All personal data is processed in the United States and the European Union (Supabase).

**Lawful transfer mechanism under DPA Section 48:**

- **To US:** Kenya has no adequacy decision for the US. Transfers rely on Section 48(1)(a) — the transfer is necessary for the performance of a contract between the data subject (through their institution) and Arkova. Additionally, Standard Contractual Clauses (REG-12) will be executed with Kenyan institutional customers.
- **To EU (Supabase):** covered by Kenya–EU adequacy recognition and SCCs.

**Safeguards in place:**
- TLS 1.3 in transit
- Encryption at rest (Supabase, GCS, R2)
- RLS on every table (Constitution Section 1.4)
- PII-scrubbed error reporting (Sentry)
- Zero Trust network ingress (Cloudflare Tunnel)
- Bitcoin mainnet anchoring uses **only fingerprints** — documents never leave user's device (Constitution Section 1.6)

### 9. Security measures (DPA Section 41)

Cross-reference: `../soc2-evidence.md`

- SOC 2 Type II audit scheduled (see `../soc2-evidence.md`)
- MFA enforced on all admin access (pending REG-05 for HIPAA-equivalent)
- Encryption: TLS 1.3 + AES-256 at rest
- Access logging (audit events — see `../../confluence/04_audit_events.md`)
- Annual penetration testing (last: 9 findings resolved, see project directive)
- AWS/GCP KMS for Bitcoin treasury key management
- RLS enforced on 190+ migrations
- Secrets never committed; environment variables only
- Incident response plan (`../incident-response-plan.md`)
- Disaster recovery plan (`../disaster-recovery.md`)

### 10. Retention period

- Credential anchoring records: **permanent** — the chain receipt is the product
- User account data: retained for 7 years after account closure (regulatory retention for education/healthcare records)
- Audit logs: 7 years
- Billing records: 7 years (Kenya Tax Procedures Act)
- Webhook logs: 90 days
- Error logs (Sentry): 90 days

Full policy: `../data-retention-policy.md`

### 11. Data subject rights request contact

- Email: `privacy@arkova.ai`
- Web: `https://arkova.ai/privacy/requests` _(pending REG-11 implementation)_
- Response SLA: 30 days (DPA Section 31 standard; can be extended by 30 days under Section 32)

---

## Fee

Arkova will register at the **Small** tier: **KES 25,000** (~USD 194).

Payable via bank transfer to the National Bank of Kenya account specified on the ODPC portal during registration.

---

## Supporting documents required

- [ ] Certificate of Incorporation (Arkova Inc., Delaware)
- [ ] Memorandum and Articles of Association
- [ ] Legal Representative appointment letter (Kenya)
- [ ] DPO appointment letter
- [ ] Privacy policy (`privacy-notice.md`)
- [ ] DPIA (`dpia.md`)
- [ ] Proof of fee payment

---

## Action checklist

- [x] **Kenyan legal counsel engaged** (2026-04-11)
- [ ] **Legal review** — outside Kenyan counsel confirms all fields
- [ ] **Appoint Kenya representative** — required before submission
- [ ] **Appoint DPO** — part of REG-28
- [ ] **Finalize DPIA** (REG-16) — blocks REG-15 per dependency chain
- [ ] **Pay fee** — KES 25,000 to ODPC bank account
- [ ] **Submit application** via https://odpc.go.ke/online-registration/
- [ ] **Record registration number** — store in this file once received
- [ ] **Update Kenya privacy notice** with registration number
- [ ] **Set renewal reminder** — 24 months from issue, begin renewal 60 days prior
- [ ] **Add compliance badge** to dashboard (REG-26)

---

## Registration details (to be completed on issue)

| Field | Value |
|-------|-------|
| Registration number | _pending_ |
| Date issued | _pending_ |
| Valid until | _pending_ |
| Tier | Small |
| Renewal reminder set | _pending_ |

---

_Last updated: 2026-04-11 | Status: DRAFT — awaiting Kenyan legal counsel engagement_
