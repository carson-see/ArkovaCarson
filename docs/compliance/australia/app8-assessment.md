# APP 8 Cross-Border Disclosure Assessment — Australia

> **Version:** 1.0 | **Date:** 2026-04-12 | **Classification:** CONFIDENTIAL
> **Legal Reference:** Privacy Act 1988 (Cth), APP 8; Section 16C
> **Jira:** SCRUM-578 (REG-17) | **Owner:** Arkova Legal
> **Status:** Assessment complete — requires legal counsel review

---

## 1. Overview

Australian Privacy Principle 8 (APP 8) requires an APP entity to take reasonable steps to ensure that an overseas recipient of personal information handles it in accordance with the APPs. Under Section 16C, Arkova will be **held accountable** for the acts and omissions of overseas recipients as if they were Arkova's own.

This assessment documents the reasonable steps Arkova has taken to ensure compliance when processing Australian personal information in the United States.

---

## 2. Information Sensitivity Assessment

| Data Category | Sensitivity Level | Justification |
|--------------|------------------|---------------|
| Credential metadata (type, issuer, dates) | Medium | Identifies individuals indirectly when combined with other data |
| Cryptographic fingerprints | Low | One-way hashes; cannot be reversed to reconstruct personal information |
| Healthcare credentials (INSURANCE, MEDICAL) | High | APP 3 sensitive information; heightened protection required |
| Verification events (who, when, what) | Medium | Access patterns reveal credential status |
| Education records (DEGREE, TRANSCRIPT) | Medium | Protected under FERPA (US) and general privacy principles |

---

## 3. Recipient Country Assessment — United States

| Factor | Assessment |
|--------|-----------|
| **Privacy legislation** | No comprehensive federal privacy law equivalent to APPs. Sector-specific: FERPA (education), HIPAA (healthcare), CCPA/CPRA (California consumers) |
| **Adequacy status** | No formal APP 8 adequacy finding for the US by OAIC |
| **Relevant protections** | FTC enforcement authority; state privacy laws (CCPA, CPA, CDPA); sector regulators (HHS, Dept of Education) |
| **Government access risk** | CLOUD Act and FISA Section 702 allow US government access to data held by US companies; risk mitigated by client-side architecture (see Section 4) |
| **Judicial redress** | Limited for non-US persons; Executive Order 14086 provides some review mechanism |

**Conclusion:** US does not provide protection substantially similar to APPs. Contractual safeguards (SCCs) are required.

---

## 4. Safeguards Implemented

### 4.1 Architectural Safeguards (Primary)

| Safeguard | Description | APP Alignment |
|-----------|-------------|---------------|
| **Client-side processing** | Documents never leave the user's device; only PII-stripped metadata + fingerprints transmitted | APP 1.2 (privacy by design), APP 11 (security) |
| **Cryptographic fingerprinting** | SHA-256 one-way hash; cannot reconstruct source document | APP 11 (integrity controls) |
| **Row-level security** | Multi-tenant isolation at database level; no cross-org data access | APP 11 (access controls) |
| **Encryption** | TLS 1.2+ in transit; AES-256 at rest | APP 11 (security of personal information) |

### 4.2 Contractual Safeguards

| Safeguard | Reference |
|-----------|-----------|
| Standard Contractual Clauses | `docs/compliance/scc/base-template.md` + `annex-australia.md` |
| APP 8 specific obligations | SCC Annex II — Australia-specific provisions |
| Sub-processor restrictions | SCC Clause 3 — prior authorization required |
| Audit rights | SCC Clause 8 — inspection and audit |
| Data return/destruction | SCC Clause 6 — return in machine-readable format or certified deletion |

### 4.3 Organizational Safeguards

| Safeguard | Description |
|-----------|-------------|
| **Security training** | Annual security awareness training for all staff |
| **Access controls** | Principle of least privilege; MFA required for production systems |
| **Incident response** | Documented breach notification procedure (see operational runbook Section 12-14) |
| **Regular assessment** | This APP 8 assessment reviewed annually or upon material change |

---

## 5. Potential Harms Assessment

| Harm Scenario | Likelihood | Severity | Mitigation |
|---------------|-----------|----------|------------|
| Unauthorized access to credential metadata | Low | Medium | RLS, encryption, audit logging |
| Government access via CLOUD Act/FISA | Low | High | Client-side architecture means no raw documents on server; only metadata |
| Sub-processor breach | Low | Medium | Contractual restrictions, sub-processor register, notification obligations |
| Credential status manipulation | Very Low | High | Immutable blockchain anchoring, cryptographic integrity proofs |

---

## 6. Ongoing Monitoring Obligations

APP 8 is not a one-time assessment. Arkova commits to:

1. **Annual review** of this assessment (or upon material change to processing activities)
2. **Sub-processor monitoring** — review sub-processor compliance annually
3. **Incident tracking** — monitor for breaches affecting Australian data subjects
4. **Regulatory monitoring** — track OAIC guidance, enforcement actions, and legislative changes
5. **Security testing** — annual penetration testing with scope covering Australian data handling

---

## 7. Penalties Awareness

Under the Privacy and Other Legislation Amendment Act 2024:

| Violation | Maximum Penalty |
|-----------|----------------|
| Serious or repeated interference with privacy | **AUD 50,000,000** or **30% of adjusted turnover** or **3x benefit obtained** (whichever is greatest) |
| Failure to notify eligible data breach | AUD 2,500,000 (individual) / AUD 50,000,000 (body corporate) |

**This is the highest penalty exposure of any jurisdiction Arkova currently serves.**

---

## 8. Conclusion

Based on this assessment, Arkova has taken reasonable steps to ensure that Australian personal information disclosed to its US-based infrastructure is handled in accordance with the APPs. The combination of:

1. Client-side processing architecture (documents never leave user's device)
2. Standard Contractual Clauses with Australia-specific annex
3. Technical security measures (encryption, RLS, MFA)
4. Ongoing monitoring and annual reassessment

provides adequate protection for the cross-border disclosure of Australian personal information.

**Next review date:** 2027-04-12 (or earlier if material changes occur)
