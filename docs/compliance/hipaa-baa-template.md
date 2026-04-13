# HIPAA Business Associate Agreement Template

> **Version:** 1.0 | **Date:** 2026-04-12 | **Classification:** CONFIDENTIAL
> **Legal Reference:** 45 CFR Section 164.504(e); 45 CFR Part 160, 162, and 164
> **Jira:** SCRUM-567 (REG-08) | **Owner:** Arkova Legal
> **Status:** TEMPLATE — requires legal counsel review before execution

---

## HIPAA-Compliant Business Associate Agreement

**Between:**

**Covered Entity** ("CE"):
_[Organization Name]_
_[Address]_
_[Authorized Representative Name and Title]_

**AND**

**Business Associate** ("BA"):
Arkova, Inc.
_[Address]_
Carson Seeger, CEO

**Effective Date:** _[Date]_

---

## RECITALS

WHEREAS, Covered Entity wishes to disclose certain information to Business Associate, some of which may constitute Protected Health Information ("PHI") as defined by the Health Insurance Portability and Accountability Act of 1996, as amended ("HIPAA"), and the regulations promulgated thereunder at 45 CFR Parts 160, 162, and 164 ("HIPAA Rules");

WHEREAS, Business Associate provides credential verification and anchoring services that may involve access to, creation of, receipt of, maintenance of, or transmission of PHI on behalf of Covered Entity;

WHEREAS, the Parties intend to comply with the requirements of HIPAA, the Health Information Technology for Economic and Clinical Health Act ("HITECH Act"), and all applicable implementing regulations;

NOW, THEREFORE, in consideration of the mutual promises and covenants contained herein, and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the Parties agree as follows:

---

## 1. DEFINITIONS

Terms used but not otherwise defined in this Agreement have the same meaning as those terms in the HIPAA Rules.

- **"Breach"** means the acquisition, access, use, or disclosure of PHI in a manner not permitted under the Privacy Rule which compromises the security or privacy of the PHI, as defined in 45 CFR 164.402.
- **"Electronic Protected Health Information" ("ePHI")** means PHI that is transmitted by or maintained in electronic media, as defined in 45 CFR 160.103.
- **"Individual"** means the person who is the subject of PHI, as defined in 45 CFR 160.103.
- **"Privacy Rule"** means the Standards for Privacy of Individually Identifiable Health Information at 45 CFR Part 160 and Part 164, Subparts A and E.
- **"Protected Health Information" ("PHI")** means individually identifiable health information, as defined in 45 CFR 160.103.
- **"Required by Law"** has the same meaning as the term "required by law" in 45 CFR 164.103.
- **"Secretary"** means the Secretary of the U.S. Department of Health and Human Services.
- **"Security Rule"** means the Security Standards for the Protection of Electronic Protected Health Information at 45 CFR Part 164, Subpart C.
- **"Unsecured PHI"** means PHI that is not rendered unusable, unreadable, or indecipherable to unauthorized persons through the use of technology or methodology specified by HHS guidance.

---

## 2. PERMITTED USES AND DISCLOSURES (Section 164.504(e)(2)(i))

**2.1** Business Associate may use or disclose PHI only as permitted or required by this Agreement or as Required by Law.

**2.2** Business Associate is permitted to use and disclose PHI for the following purposes:
- (a) To perform credential verification, anchoring, and related services on behalf of Covered Entity as described in the underlying Service Agreement;
- (b) For the proper management and administration of Business Associate's business;
- (c) To carry out the legal responsibilities of Business Associate;
- (d) To provide data aggregation services to Covered Entity as permitted by 45 CFR 164.504(e)(2)(i)(B).

**2.3** Business Associate shall not use or disclose PHI in a manner that would violate Subpart E of 45 CFR Part 164 if done by Covered Entity.

---

## 3. SAFEGUARDS (Section 164.504(e)(2)(ii)(A))

**3.1** Business Associate shall use appropriate safeguards to prevent use or disclosure of PHI other than as provided for by this Agreement, and shall comply with the Security Rule with respect to ePHI.

**3.2** Without limiting the foregoing, Business Associate shall:
- (a) Implement administrative, physical, and technical safeguards that reasonably and appropriately protect the confidentiality, integrity, and availability of ePHI;
- (b) Use SHA-256 cryptographic fingerprinting for document integrity verification, with document processing performed client-side only (no PHI stored on servers);
- (c) Enforce multi-factor authentication for access to healthcare credential types per Section 164.312(d);
- (d) Implement automatic session timeout after 15 minutes of inactivity per Section 164.312(a)(2)(iii);
- (e) Maintain audit controls that record and examine activity in systems containing ePHI per Section 164.312(b);
- (f) Encrypt ePHI in transit (TLS 1.2+) and at rest.

---

## 4. BREACH REPORTING (Section 164.504(e)(2)(ii)(B))

**4.1** Business Associate shall report to Covered Entity any use or disclosure of PHI not provided for by this Agreement of which it becomes aware, including any Breach of Unsecured PHI as required by 45 CFR 164.410.

**4.2** Business Associate shall report any Breach of Unsecured PHI to Covered Entity **within sixty (60) calendar days** of discovery of such Breach.

**4.3** The breach notification shall include, to the extent possible:
- (a) Identification of each Individual whose Unsecured PHI has been, or is reasonably believed to have been, accessed, acquired, used, or disclosed;
- (b) A brief description of what happened, including the date of the Breach and the date of discovery;
- (c) A description of the types of Unsecured PHI involved in the Breach;
- (d) Any steps Individuals should take to protect themselves from potential harm;
- (e) A brief description of what Business Associate is doing to investigate, mitigate harm, and protect against further Breaches.

---

## 5. SUBCONTRACTORS (Section 164.504(e)(2)(ii)(C))

**5.1** Business Associate shall ensure that any subcontractors that create, receive, maintain, or transmit PHI on behalf of Business Associate agree to the same restrictions, conditions, and requirements that apply through this Agreement.

**5.2** Business Associate shall enter into a Business Associate Agreement with each subcontractor, in accordance with 45 CFR 164.502(e)(1)(ii) and 164.308(b)(2).

**5.3** Current subprocessors are listed in Arkova's subprocessor register, available upon request.

---

## 6. INDIVIDUAL ACCESS RIGHTS (Section 164.504(e)(2)(ii)(D))

**6.1** Business Associate shall make available PHI in a Designated Record Set to Covered Entity, and/or to Individual(s) as directed by Covered Entity, in order to meet the requirements of 45 CFR 164.524.

**6.2** Business Associate shall respond to such requests within **thirty (30) days** of receipt.

**6.3** Arkova provides self-service data export functionality enabling Individuals to download their personal data in JSON and human-readable formats.

---

## 7. AMENDMENT RIGHTS (Section 164.504(e)(2)(ii)(E))

**7.1** Business Associate shall make PHI in a Designated Record Set available to Covered Entity for amendment, and shall incorporate any amendments to PHI as directed by Covered Entity, in accordance with 45 CFR 164.526.

---

## 8. ACCOUNTING OF DISCLOSURES (Section 164.504(e)(2)(ii)(F))

**8.1** Business Associate shall maintain and make available the information required to provide an accounting of disclosures to Covered Entity, in accordance with 45 CFR 164.528.

**8.2** Business Associate shall maintain such information for a minimum of **six (6) years** from the date of the disclosure.

**8.3** Arkova maintains a comprehensive audit trail of all verification events, including: who accessed what, when, from where, and what action was taken.

---

## 9. HHS ACCESS (Section 164.504(e)(2)(ii)(G))

**9.1** Business Associate shall make its internal practices, books, and records relating to the use and disclosure of PHI available to the Secretary for purposes of determining Covered Entity's compliance with the HIPAA Rules.

---

## 10. PHI RETURN OR DESTRUCTION (Section 164.504(e)(2)(ii)(H))

**10.1** Upon termination of this Agreement for any reason, Business Associate shall:
- (a) Return or destroy all PHI received from, or created or received by Business Associate on behalf of, Covered Entity; and
- (b) Retain no copies of the PHI.

**10.2** If return or destruction is infeasible, Business Associate shall:
- (a) Extend the protections of this Agreement to such PHI; and
- (b) Limit further uses and disclosures of such PHI to those purposes that make the return or destruction infeasible.

**10.3** For credential anchoring records (cryptographic fingerprints that do not contain PHI), retention follows the immutable anchoring policy. Fingerprints are one-way hashes and cannot be reversed to reconstruct PHI.

---

## 11. TERMINATION (Section 164.504(e)(2)(iii))

**11.1** Covered Entity may terminate this Agreement if Covered Entity determines that Business Associate has violated a material term of this Agreement.

**11.2** Before termination, Covered Entity shall provide Business Associate with written notice of the violation and an opportunity to cure within **thirty (30) days**.

**11.3** If Business Associate fails to cure within the cure period, Covered Entity may terminate this Agreement immediately upon written notice.

**11.4** If termination is not feasible, Covered Entity shall report the violation to the Secretary.

---

## 12. GENERAL PROVISIONS

**12.1** **Regulatory References.** A reference to a section in the HIPAA Rules means the section as in effect or as amended.

**12.2** **Amendment.** The Parties agree to take such action as is necessary to amend this Agreement from time to time as necessary to comply with HIPAA and the HITECH Act.

**12.3** **Survival.** The respective rights and obligations of Business Associate under Sections 10 and 12 shall survive termination.

**12.4** **Interpretation.** Any ambiguity in this Agreement shall be resolved to permit compliance with the HIPAA Rules.

**12.5** **Governing Law.** This Agreement shall be governed by the laws of the State of _[State]_, without regard to conflict of laws principles.

---

## SIGNATURES

| Party | Name | Title | Date |
|-------|------|-------|------|
| **Covered Entity** | _________________________ | _________________________ | _____________ |
| **Business Associate (Arkova)** | Carson Seeger | CEO | _____________ |

---

## EXHIBIT A: Description of Services

Arkova provides the following services that may involve access to PHI:

1. **Credential Verification:** Verifying the authenticity and status of healthcare-related credentials (insurance certificates, medical licenses, immunization records)
2. **Document Anchoring:** Creating immutable, timestamped cryptographic proofs of document integrity
3. **Compliance Reporting:** Generating audit-ready compliance reports for healthcare credential management
4. **AI-Assisted Extraction:** Client-side metadata extraction from healthcare documents (no PHI transmitted to servers)

---

## EXHIBIT B: PHI Data Elements

The following categories of PHI may be processed under this Agreement:

| Category | Example Data Elements | Processing Location |
|----------|----------------------|-------------------|
| Healthcare Credentials | Insurance certificate numbers, medical license numbers, provider identifiers | Client-side fingerprinting only |
| Credential Metadata | Credential type, issuer, dates, status | Encrypted at rest (Supabase) |
| Verification Events | Who verified what, when, outcome | Audit trail (encrypted) |

**Note:** Arkova's architecture processes documents client-side. Only PII-stripped metadata and cryptographic fingerprints are transmitted to the server. No raw PHI is stored on Arkova servers.
