# Standard Contractual Clauses — Base Template

> **Version:** 1.0 | **Date:** 2026-04-12 | **Classification:** CONFIDENTIAL
> **Jira:** SCRUM-573 (REG-12) | **Owner:** Arkova Legal
> **Status:** TEMPLATE — requires legal counsel review before execution
> **Jurisdiction annexes:** Kenya, Australia, South Africa, Nigeria

---

## Standard Contractual Clauses for Cross-Border Data Transfer

**Between:**

**Data Exporter** ("Institution" or "Controller"):
_[Institution Name]_
_[Country]_
_[Authorized Representative]_

**AND**

**Data Importer** ("Arkova" or "Processor"):
Arkova, Inc.
United States of America
Carson Seeger, CEO

**Effective Date:** _[Date]_

---

## CLAUSE 1: PURPOSE AND SCOPE

1.1 These Standard Contractual Clauses ("SCCs") ensure that the transfer of personal data from Data Exporter to Data Importer complies with applicable data protection laws in the Data Exporter's jurisdiction.

1.2 The purpose of the data transfer is to enable Arkova to provide credential verification, anchoring, and compliance services as described in the Service Agreement.

1.3 The categories of data subjects, types of personal data, and processing activities are described in Annex I.

---

## CLAUSE 2: DATA PROTECTION OBLIGATIONS OF THE DATA IMPORTER

2.1 **Purpose limitation:** Data Importer shall process personal data only for the specific purposes set out in Annex I and shall not process the data for any other purpose.

2.2 **Data minimization:** Data Importer shall process only the minimum amount of personal data necessary to fulfill the stated purposes.

2.3 **Accuracy:** Data Importer shall take reasonable steps to ensure the personal data is accurate and up to date.

2.4 **Storage limitation:** Data Importer shall retain personal data only for as long as necessary for the stated purposes or as required by law. Credential anchoring records (cryptographic fingerprints) are retained per the immutable anchoring policy, as they contain no recoverable personal data.

2.5 **Security measures:** Data Importer shall implement appropriate technical and organizational measures to protect personal data, including:
- Client-side document processing (documents never leave the user's device)
- SHA-256 cryptographic fingerprinting (one-way, irreversible)
- Encryption in transit (TLS 1.2+) and at rest (AES-256)
- Row-level security (RLS) for multi-tenant data isolation
- Regular security assessments and penetration testing
- Incident response procedures (see Section 5)

2.6 **Transparency:** Data Importer shall provide Data Exporter with sufficient information to demonstrate compliance with these SCCs upon reasonable request.

---

## CLAUSE 3: SUB-PROCESSOR RESTRICTIONS

3.1 Data Importer shall not engage sub-processors without prior written authorization from Data Exporter.

3.2 Where Data Importer engages a sub-processor, it shall:
- (a) Impose the same data protection obligations as set out in these SCCs;
- (b) Remain fully liable for the sub-processor's performance;
- (c) Notify Data Exporter of any intended changes to the sub-processor list at least 30 days in advance.

3.3 Current sub-processors are listed in Arkova's sub-processor register.

---

## CLAUSE 4: DATA SUBJECT RIGHTS

4.1 Data Importer shall assist Data Exporter in responding to data subject requests for:
- (a) Access to their personal data;
- (b) Rectification of inaccurate data;
- (c) Erasure of personal data ("right to be forgotten");
- (d) Data portability (export in machine-readable format);
- (e) Objection to processing;
- (f) Restriction of processing.

4.2 Data Importer shall respond to Data Exporter's requests within 10 business days.

4.3 Arkova provides self-service tools for Individuals to exercise their data subject rights directly (download data, request corrections).

---

## CLAUSE 5: BREACH NOTIFICATION

5.1 Data Importer shall notify Data Exporter of any personal data breach **without undue delay** and in any event:
- Within **48 hours** of becoming aware (processor to controller notification);
- Including: nature of breach, categories/approximate number of data subjects affected, likely consequences, measures taken or proposed.

5.2 The Data Exporter remains responsible for notifying the applicable supervisory authority within the jurisdiction-specific timeline (see Annex II).

---

## CLAUSE 6: DATA RETURN AND DESTRUCTION

6.1 Upon termination of the Service Agreement or upon request by Data Exporter:
- (a) Data Importer shall return all personal data in a commonly used, machine-readable format; or
- (b) Delete all personal data and certify deletion in writing.

6.2 Cryptographic fingerprints (anchoring records) are one-way hashes that contain no recoverable personal data and are not subject to deletion requirements.

---

## CLAUSE 7: GOVERNING LAW AND JURISDICTION

7.1 These SCCs shall be governed by the law of Data Exporter's jurisdiction (see Annex II for jurisdiction-specific provisions).

7.2 Disputes shall be resolved in the courts of Data Exporter's jurisdiction.

---

## CLAUSE 8: AUDITS

8.1 Data Importer shall make available to Data Exporter all information necessary to demonstrate compliance with these SCCs.

8.2 Data Importer shall allow and contribute to audits, including inspections, conducted by Data Exporter or an auditor mandated by Data Exporter, upon reasonable notice.

---

## ANNEX I: DESCRIPTION OF TRANSFER

| Field | Details |
|-------|---------|
| **Categories of data subjects** | Students, employees, professionals, healthcare workers |
| **Types of personal data** | Credential metadata (type, issuer, dates), PII-stripped structured data, cryptographic fingerprints |
| **Sensitive data** | Health information (insurance, medical licenses) — handled per HIPAA BAA where applicable |
| **Processing activities** | Credential verification, document anchoring, compliance scoring, audit reporting |
| **Frequency of transfer** | Continuous (as credentials are submitted and verified) |
| **Retention period** | Active credential lifetime + legal retention requirements |
| **Data Importer's location** | United States of America |

## ANNEX II: JURISDICTION-SPECIFIC PROVISIONS

See separate annex documents:
- `annex-kenya.md` — Kenya Data Protection Act 2019
- `annex-australia.md` — Australian Privacy Act 1988 (APP 8)
- `annex-south-africa.md` — POPIA Section 72
- `annex-nigeria.md` — Nigeria Data Protection Act 2023

---

## SIGNATURES

| Party | Name | Title | Date |
|-------|------|-------|------|
| **Data Exporter** | _________________________ | _________________________ | _____________ |
| **Data Importer (Arkova)** | Carson Seeger | CEO | _____________ |
