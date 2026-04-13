# Arkova Privacy Notice — Kenya

_This notice supplements our global privacy policy to address the specific rights and disclosures required by the Kenya Data Protection Act, 2019._

_Last updated: 2026-04-11 | Effective: pending first Kenyan customer_

---

## 1. Who we are

**Arkova Inc.** is a Delaware corporation headquartered in the United States. We operate the Arkova credential anchoring and verification platform, accessible at https://arkova.ai and https://app.arkova.ai.

For the purposes of the Kenya Data Protection Act, 2019, Arkova acts as:
- **Data Controller** for account, billing, and verification-log data
- **Data Processor** for institutional credential data (where an institution is the Controller)

### 1.1 Kenya representative

Because Arkova does not have a physical establishment in Kenya, we have appointed a local representative under Section 58 of the Act:

**Representative:** _to be appointed — see REG-15 registration packet_
**Address:** _pending_
**Email:** _pending_

### 1.2 Data Protection Officer

**DPO:** _to be appointed — see REG-28_
**Email:** dpo@arkova.ai

### 1.3 ODPC registration

Arkova is registered with the Office of the Data Protection Commissioner of Kenya.
**Registration number:** _pending issue_
**Valid until:** _pending_

---

## 2. What personal data we process

### 2.1 Ordinary personal data

- Name, date of birth, contact details
- Institutional affiliation (e.g., university, licensing body)
- Credential type and metadata (degree, certification, dates, status)
- Account credentials (email, hashed password)
- Billing data (where a Kenyan entity is the direct customer)
- Verification request logs (who verified what, when)

### 2.2 Sensitive personal data (Section 2)

Some credentials we anchor are sensitive personal data under the Act:

- **Health-sector credentials** — professional licences issued to nurses, doctors, clinicians
- **Biometric-adjacent** — where document-scanning features are used (opt-in, client-side)

Sensitive personal data is processed only under the contractual-necessity exception (Section 46(2)) or explicit consent.

### 2.3 What we do NOT process

- We do **not** store the content of source documents. All documents are fingerprinted on the user's device and only the cryptographic hash is transmitted to our servers.
- We do **not** publish personal data on the Bitcoin blockchain. Only Merkle roots — anonymous cryptographic artifacts — are published.
- We do **not** sell personal data to third parties.
- We do **not** use Kenyan credential data for advertising profiling.

---

## 3. Why we process it (Section 30 lawful bases)

| Purpose | Lawful basis |
|---------|-------------|
| Credential issuance on behalf of your institution | Section 30(1)(a) — performance of contract |
| Verification of credentials by authorized third parties | Section 30(1)(f) — legitimate interests |
| Fraud prevention and platform integrity | Section 30(1)(c) — legal obligation + legitimate interests |
| Billing and account management | Section 30(1)(a) — performance of contract |
| Service operation and security | Section 30(1)(f) — legitimate interests |
| Marketing communications (optional) | Section 30(1)(a) — consent (separate opt-in) |

---

## 4. Your rights under the Kenya DPA

As a Kenyan data subject, you have the following rights (Sections 26, 31-38):

| Right | How to exercise |
|-------|----------------|
| **Information** (Section 29) | Read this notice |
| **Access** (Section 26(c), 31) | `privacy@arkova.ai` or `https://arkova.ai/privacy/requests` |
| **Rectification** (Section 26(d)) | Same contact |
| **Erasure** (Section 40) | Same contact. Note: fingerprints already anchored on the public Bitcoin mainnet cannot be removed from the chain, but the underlying personal data will be deleted from our systems |
| **Restriction of processing** (Section 35) | Same contact |
| **Data portability** (Section 38) | Same contact — JSON export |
| **Objection** (Section 36) | Same contact |
| **Automated decisioning** (Section 35) | Arkova does not make solely automated decisions with legal effect on you |
| **Withdraw consent** | Where processing is based on consent, same contact |

We respond within **30 days** (Section 31(3)). We may extend this by 30 days under Section 32 if the request is complex; we will tell you in writing if we do.

### 4.1 Right to complain to the ODPC

You also have the right to lodge a complaint with the Office of the Data Protection Commissioner of Kenya (Section 56(1)(f)):

- **Website:** https://odpc.go.ke
- **Email:** complaints@odpc.go.ke
- **Address:** Britam Tower, 17th Floor, Hospital Road, Upper Hill, Nairobi

---

## 5. How long we keep your data

| Category | Retention |
|----------|-----------|
| Credential anchoring records | Permanent (this is the product) |
| Account data | 7 years after account closure |
| Audit logs | 7 years |
| Billing records | 7 years (Tax Procedures Act, Kenya) |
| Error logs | 90 days |
| Webhook delivery logs | 90 days |

Full retention policy: https://arkova.ai/legal/retention (or `../data-retention-policy.md` in this repo)

---

## 6. Who we share data with

- **Your institution** — where you received a credential from a Kenyan institution, that institution is the controller for that credential
- **Authorized verifiers** — employers, regulators, or other parties you or your institution have authorized
- **Sub-processors** (full list in `../vendor-register.md`):
  - Supabase (database, authentication)
  - Google Cloud (application runtime)
  - Cloudflare (ingress, edge)
  - Stripe (billing only)
  - Resend (transactional email)
  - Sentry (error tracking, PII-scrubbed)

We require all sub-processors to sign data processing agreements with protections at least as strong as those in this notice.

---

## 7. Cross-border transfers (Section 48-49)

Your data is processed in the **United States** (our primary infrastructure) and the **European Union** (backup region). Kenya has not issued an adequacy decision for the United States.

We transfer your data under Section 48(1)(a) — the transfer is necessary for the performance of the contract between your institution and Arkova — and we execute **Standard Contractual Clauses** with all Kenyan institutional customers as a supplementary safeguard.

Our **fingerprint-only architecture** materially reduces the risk of cross-border transfer: source documents never leave your device, so a compelled disclosure by any foreign government would yield only cryptographic hashes, not your personal records.

Full analysis: see our DPIA at `../kenya/dpia.md`.

---

## 8. How we protect your data (Section 41)

- TLS 1.3 encryption in transit
- AES-256 encryption at rest
- Row-level security on every database table
- Multi-factor authentication for all administrative access
- SOC 2 Type II controls
- Annual third-party penetration testing
- 72-hour breach notification to the ODPC (Section 43)
- Zero Trust network ingress (no public ports)

Security evidence: `../soc2-evidence.md`
Incident response: `../incident-response-plan.md`

---

## 9. Breach notification (Section 43)

If a personal data breach affects your data, we will:

- Notify the ODPC within **72 hours** of becoming aware of the breach
- Notify you without undue delay if the breach is likely to result in high risk to your rights and freedoms
- Document the breach internally, regardless of whether notification is required

---

## 10. Children's data

Arkova's services are designed for credential holders aged 16 and above. For credentials issued to data subjects under 18, we process data only under the institutional-contract basis with parental/guardian consent obtained upstream by the issuing institution. Institutional customers warrant in their Data Processing Agreements that upstream consent has been obtained.

---

## 11. Changes to this notice

We will update this notice if our processing materially changes. The "Last updated" date at the top reflects the most recent change. Material changes will be communicated directly via email.

---

## 12. Contact

- **General privacy queries:** `privacy@arkova.ai`
- **Data Protection Officer:** `dpo@arkova.ai`
- **Kenya representative:** _pending appointment_
- **Postal:** Arkova Inc., _US address_, for the attention of the Privacy team

---

_This Kenya-specific notice must be read alongside Arkova's global Privacy Policy at https://arkova.ai/legal/privacy. Where the two conflict for Kenyan data subjects, this notice prevails._
