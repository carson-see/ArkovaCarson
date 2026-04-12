# FERPA Data Use Agreement Template

> **Version:** 1.0 | **Date:** 2026-04-12 | **Classification:** CONFIDENTIAL
> **Legal Reference:** 20 U.S.C. Section 1232g; 34 CFR Part 99 (Sections 99.31-99.37)
> **Jira:** SCRUM-563 (REG-03) | **Owner:** Arkova Legal
> **Status:** TEMPLATE — requires legal counsel review before execution

---

## FERPA-Compliant Data Use Agreement

**Between:**

**Institution** ("Educational Institution" or "Disclosing Party"):  
_[Institution Name]_  
_[Address]_  
_[Authorized Representative Name and Title]_

**AND**

**Arkova, Inc.** ("School Official" or "Receiving Party"):  
Arkova, Inc.  
_[Address]_  
Carson Seeger, CEO

**Effective Date:** _[Date]_

---

## RECITALS

WHEREAS, the Educational Institution maintains education records as defined under the Family Educational Rights and Privacy Act ("FERPA"), 20 U.S.C. Section 1232g, and its implementing regulations at 34 CFR Part 99;

WHEREAS, Arkova provides credential verification and anchoring services that constitute an institutional function for which the Educational Institution would otherwise use its own employees;

WHEREAS, the Educational Institution desires to designate Arkova as a "school official" with a "legitimate educational interest" under FERPA Section 99.31(a)(1)(i);

NOW, THEREFORE, the parties agree as follows:

---

## 1. DESIGNATION AS SCHOOL OFFICIAL

### 1.1 Four-Part Test Compliance

The Educational Institution designates Arkova as a school official under Section 99.31(a)(1)(i), having determined that Arkova satisfies the four-part test:

**(a) Institutional Function:** Arkova performs the institutional function of credential verification, document integrity assurance, and compliance record-keeping — services that the Educational Institution would otherwise use its own employees to perform.

**(b) Direct Control:** The Educational Institution retains direct control over Arkova's use of education records through this Agreement, including the scope of accessible records, permitted uses, and audit rights.

**(c) Purpose Limitation:** Arkova accesses personally identifiable information ("PII") from education records solely for the purpose of performing the credential verification and integrity services described in Section 2.

**(d) Annual Notification Criteria:** The Educational Institution's annual notification to parents and eligible students under Section 99.7 includes Arkova as a school official with legitimate educational interest, or will be updated to do so prior to the first disclosure.

### 1.2 Scope of Designation

This designation is limited to the services described in Section 2 and does not extend to any other use of education records.

---

## 2. PERMITTED USES OF EDUCATION RECORDS

### 2.1 Authorized Services

Arkova is authorized to access and process education records solely for:

- **Credential verification:** Confirming the authenticity and status of academic credentials (degrees, transcripts, certifications)
- **Document integrity anchoring:** Creating cryptographic fingerprints of credential documents for tamper-detection
- **Compliance record-keeping:** Maintaining disclosure logs per Section 99.32

### 2.2 Processing Boundary

In accordance with Arkova's client-side processing architecture:

- **Documents never leave the student's or institution's device.** Cryptographic fingerprinting occurs entirely within the user's browser.
- **Only PII-stripped metadata** (credential type, issue date, issuer name, fingerprint hash) flows to Arkova servers.
- **No raw document content** is stored, transmitted to, or accessible by Arkova servers.

### 2.3 Prohibited Uses

Arkova shall NOT:

- Use education records for any purpose other than the authorized services
- Share, sell, rent, or otherwise disclose education records to any third party
- Use education records for marketing, advertising, or profiling
- Retain education records beyond the scope of the authorized services
- Attempt to re-identify PII-stripped metadata

---

## 3. RE-DISCLOSURE PROHIBITION (Section 99.33)

### 3.1 No Re-Disclosure

Arkova shall not re-disclose PII from education records to any third party, except:

**(a)** As required by law (subpoena, court order) — with notice to the Educational Institution within 72 hours unless legally prohibited;

**(b)** With prior written consent of the parent or eligible student;

**(c)** To subprocessors listed in Exhibit A, solely for the purpose of performing the authorized services, and only where such subprocessors are contractually bound to equivalent obligations.

### 3.2 Re-Disclosure Notice in API Responses

All Arkova verification API responses for education-type credentials include the following notice:

> **FERPA Notice:** This verification result contains information from education records. Re-disclosure of personally identifiable information to third parties is prohibited under FERPA Section 99.33 unless an exception applies. The receiving party must comply with all applicable FERPA re-disclosure requirements.

### 3.3 Subprocessor Management

Arkova maintains a current list of subprocessors in its Vendor Risk Register (`docs/compliance/vendor-register.md`). Subprocessors are bound by equivalent data protection obligations. The Educational Institution will be notified 30 days prior to any new subprocessor addition.

---

## 4. DATA DESTRUCTION

### 4.1 Destruction Timeline

Upon termination of this Agreement or upon written request by the Educational Institution:

- **PII-stripped metadata:** Deleted within 30 days of request
- **Cryptographic fingerprints:** Retained indefinitely (non-PII, required for verification integrity)
- **Disclosure logs:** Retained as long as the education record exists, per Section 99.32 (not subject to destruction requests)
- **Backup copies:** Purged from backup systems within 90 days

### 4.2 Certification of Destruction

Upon completion of data destruction, Arkova will provide a written certification confirming all PII from education records has been destroyed or de-identified.

---

## 5. AUDIT ACCESS RIGHTS

### 5.1 Institutional Audit

The Educational Institution may, upon 30 days' written notice, audit Arkova's compliance with this Agreement, including:

- Review of disclosure logs (Section 99.32)
- Verification that PII is not stored beyond permitted scope
- Review of access controls and security measures
- Interview of Arkova personnel responsible for data handling

### 5.2 Audit Frequency

Audits may be conducted no more than once per 12-month period, unless a specific compliance concern is identified, in which case an additional audit may be requested.

### 5.3 Audit Cooperation

Arkova will reasonably cooperate with audit requests, provide access to relevant systems and personnel, and remediate any findings within 30 days.

---

## 6. SECURITY REQUIREMENTS

### 6.1 Technical Safeguards

Arkova maintains the following security controls:

- **Encryption at rest:** AES-256 (database), FileVault (endpoints)
- **Encryption in transit:** TLS 1.2+
- **Access control:** Row-Level Security (RLS) on all database tables, RBAC with least-privilege
- **Authentication:** MFA available, API keys with HMAC-SHA256 hashing
- **Audit logging:** Append-only, tamper-proof audit event trail
- **Client-side processing:** Documents processed entirely in-browser (no server upload)
- **Formal verification:** TLA+ model checking of anchor lifecycle state machine

### 6.2 SOC 2 Compliance

Arkova is pursuing SOC 2 Type II certification. Upon completion, the SOC 2 report will be made available to the Educational Institution upon request.

---

## 7. BREACH NOTIFICATION

### 7.1 Notification Timeline

In the event of a breach involving education records:

- Arkova will notify the Educational Institution within **72 hours** of discovery
- Notification will include: nature of the breach, categories of data affected, number of records involved, measures taken or proposed

### 7.2 Cooperation

Arkova will cooperate with the Educational Institution's investigation and any required notifications to affected students, parents, or regulatory bodies.

---

## 8. TERM AND TERMINATION

### 8.1 Term

This Agreement is effective from the Effective Date and continues for **12 months**, with automatic annual renewal unless terminated by either party with 60 days' written notice.

### 8.2 Termination for Cause

Either party may terminate immediately upon written notice if the other party materially breaches this Agreement and fails to cure within 30 days of written notice.

### 8.3 Survival

Sections 3 (Re-Disclosure Prohibition), 4 (Data Destruction), 5 (Audit Access), and 7 (Breach Notification) survive termination.

---

## 9. GENERAL PROVISIONS

### 9.1 Governing Law

This Agreement is governed by the laws of the State of _[State]_ and federal law, including FERPA.

### 9.2 Amendments

Amendments must be in writing and signed by both parties.

### 9.3 Entire Agreement

This Agreement constitutes the entire agreement between the parties regarding the use of education records and supersedes all prior agreements on this subject.

---

## SIGNATURES

**Educational Institution:**

Signature: _________________________  
Name: _[Authorized Representative]_  
Title: _[Title]_  
Date: _[Date]_

**Arkova, Inc.:**

Signature: _________________________  
Name: Carson Seeger  
Title: CEO  
Date: _[Date]_

---

## EXHIBIT A: SUBPROCESSORS

| Subprocessor | Service | Data Access | DPA |
|-------------|---------|-------------|-----|
| Supabase | Database & Auth | PII-stripped metadata | Signed |
| Google Cloud | Worker hosting, AI (PII-stripped only) | PII-stripped metadata | Signed |
| Cloudflare | Edge security, CDN | Request metadata only | Signed |
| Stripe | Payment processing | Billing data only (no education records) | Signed |

_See `docs/compliance/vendor-register.md` for full vendor risk register._

---

**TEMPLATE NOTES (remove before execution):**

1. This template requires review by institutional legal counsel before execution
2. The "Annual Notification Criteria" (Section 1.1(d)) must be verified with the institution's current FERPA annual notification
3. State-specific privacy laws may impose additional requirements
4. The re-disclosure notice text (Section 3.2) is automatically included in Arkova's verification API responses for education credential types
5. The destruction timeline (Section 4.1) is aligned with Arkova's data retention policy
