# Malaysia Privacy Notice — Personal Data Protection Act 2010 (as amended 2024)

> **Version:** 1.0 | **Date:** 2026-04-17 | **Classification:** PUBLIC
> **Legal basis:** Personal Data Protection Act 2010 (Act 709); Personal Data Protection (Amendment) Act 2024 (phased commencement April–June 2025); Personal Data Protection (Data Breach Notification) Regulations 2025; Personal Data Protection (Data Protection Officer) Regulations 2025
> **Regulator:** Personal Data Protection Commissioner Malaysia (PDP) — https://www.pdp.gov.my/
> **Jira:** SCRUM-726 (INTL-06) | **Owner:** Arkova Legal
> **Status:** DRAFT — awaiting Malaysian counsel review

---

## 1. Scope

This notice applies to data subjects in Malaysia whose personal data Arkova Inc. processes in connection with credential verification services.

Under PDPA 2010 §3(1), the Act applies extraterritorially when processing is intended to be made in respect of that information by any equipment in Malaysia. Arkova's institutional customers in Malaysia trigger this by uploading on their Malaysia-based devices.

Arkova acts as **Data User** (equivalent to controller) when processing on its own account, and as **Data Processor** under §2 when acting on the written instructions of the institution.

---

## 2. Personal data we process

| Category | Examples | Processing ground |
|----------|----------|-------------------|
| Personal data | Name, email, organisation, credential type/issuer/dates | Contract performance (§6(2)(b)) or consent (§6(1)) |
| Cryptographic fingerprints | SHA-256 hashes of user documents | Legitimate interest of the institution (anti-fraud) |
| Verification events | Who verified a credential, when, from which organisation | Contract performance |
| Sensitive personal data | Medical / health credentials | **Explicit consent** (§40(1)(a)) |

Documents themselves never leave the data subject's device — only fingerprints and metadata are transmitted. See Arkova Constitution §1.6.

---

## 3. Seven Personal Data Protection Principles

| Principle (PDPA §5) | How Arkova applies it |
|---------------------|------------------------|
| General Principle (§6) | Process only with consent or a permitted contractual/legal basis |
| Notice & Choice (§7) | This notice is provided at onboarding; right to withdraw consent at any time |
| Disclosure (§8) | No disclosure beyond purposes stated in §3 without prior consent |
| Security (§9) | AES-256 at rest + TLS 1.2+ in transit; RLS multi-tenant isolation; MFA on admin access |
| Retention (§10) | Retained only while subscription active + 7 years audit-trail retention |
| Data Integrity (§11) | Data accuracy maintained via continuous validation + data subject rectification channel |
| Access (§12) | Access + correction rights honoured within 21 days |

---

## 4. Rights (PDPA §30–§38 and §43A as amended)

Data subjects in Malaysia may exercise the following rights by emailing `privacy@arkova.ai`:

- **Access** to personal data held by Arkova (§30)
- **Correction** of inaccurate, incomplete, misleading or outdated data (§34)
- **Withdraw consent** in whole or in part (§38)
- **Prevent processing** likely to cause substantial damage or distress (§42)
- **Prevent direct marketing** (§43)
- **Data portability** — receive or direct transmission to another data user (§43A, in force from 2025)

Arkova responds to valid access / correction requests within **21 days** (§29(1)).

---

## 5. Purposes

- Credential verification for the data subject's employer or institution
- Anti-fraud analytics
- Compliance reporting to institutional customers
- Service delivery + platform security

---

## 6. Cross-border transfers

The PDPA 2024 Amendment replaced the pre-existing whitelist regime with a **risk-based framework** (§129 as amended, commenced April 2025). Transfers out of Malaysia must meet one of:

- **Adequacy** — destination provides protection substantially similar to PDPA;
- **Transfer Impact Assessment (TIA)** — the Data User assesses and documents that reasonable precautions and due diligence have been taken (see `docs/compliance/malaysia/transfer-impact-assessment.md`);
- **Consent** — data subject's consent;
- **Contract performance** — transfer necessary for the performance of a contract with the data subject.

**Arkova's basis:** TIA + SCC-style contractual safeguards with the customer. A standing TIA for US-destined processing is maintained and reviewed annually.

---

## 7. Data Protection Officer (DPO)

The 2024 Amendment makes DPO appointment **mandatory** for data users processing personal data above thresholds set by the PDP Commissioner. Arkova meets this threshold for Malaysian institutional customers.

| Field | Value |
|-------|-------|
| DPO name | Shared group DPO (to be designated — see REG-28) |
| DPO email | `dpo@arkova.ai` |
| DPO registration with PDP | Filed via Malaysian counsel |

---

## 8. Breach notification

Under the Personal Data Protection (Data Breach Notification) Regulations 2025, Arkova notifies the PDP Commissioner of a personal data breach **without undue delay, and in any event within 72 hours**, where the breach is likely to result in significant harm to the data subject.

Affected data subjects are notified in the same timeframe when the risk is high.

---

## 9. Security controls

| Safeguard | Detail |
|-----------|--------|
| Encryption in transit | TLS 1.2+ |
| Encryption at rest | AES-256 |
| Access control | Row-level security + MFA on admin |
| Logging | Append-only audit log |
| Client-side processing | Documents never leave the device |
| Incident response | 72-hour breach runbook |
| Sub-processor register | `docs/compliance/vendor-register.md` |

---

## 10. Retention

Credential metadata: retained while organisation subscription active + 7 years thereafter. Audit events: 7 years. Data subjects may request earlier deletion when no legal retention obligation applies.

---

## 11. Contact

| Purpose | Contact |
|---------|---------|
| Data protection queries | `privacy@arkova.ai` |
| DPO | `dpo@arkova.ai` |
| PDP Commissioner | https://www.pdp.gov.my/ · +603-8911 7000 |

---

## 12. Changes to this notice

Material changes are communicated via in-app notice + email at least 30 days before taking effect. The effective date at the top of this notice is always updated.
