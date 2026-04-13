# Data Protection Impact Assessment — Kenya DPA 2019

_Story: REG-16 (SCRUM-577) — Kenya DPIA_
_Legal basis: Data Protection Act 2019, Section 31; Data Protection (General) Regulations, 2021_
_Controller: Arkova Inc. (Delaware, USA)_
_Prepared by: Compliance (draft) | Reviewed by: _pending DPO_ | Version: 0.1 | Date: 2026-04-11_

---

## 1. Introduction and scope

This Data Protection Impact Assessment (DPIA) evaluates the privacy risks of Arkova's credential issuance, anchoring, and verification services as they apply to Kenyan data subjects, in compliance with Section 31 of the Kenya Data Protection Act, 2019 ("the Act") and the Data Protection (General) Regulations, 2021.

### 1.1 Why a DPIA is required (Section 31(1))

A DPIA is mandatory when processing "is likely to result in high risk to the rights and freedoms of data subjects", including:

- **Systematic and extensive evaluation** — automated decisioning regarding credential validity (Section 35 scope)
- **Large-scale processing of sensitive personal data** — health-related professional credentials, education records of minors (university students under 18)
- **Systematic monitoring** — verification requests are logged and attributable
- **Cross-border transfer** of Kenyan personal data to the United States (no adequacy decision)

Arkova's processing triggers at least three of these conditions, so a DPIA is required under Section 31(1)(a), (b), and (g).

---

## 2. Description of processing operations (Section 31(2)(a))

### 2.1 Nature of processing

Arkova provides a credential anchoring and verification platform that:

1. Accepts structured credential metadata from an institutional customer (Controller A — e.g. a Kenyan university)
2. Generates a SHA-256 fingerprint of the credential **on the issuer's device** (Constitution Section 1.6)
3. Receives the fingerprint — *not* the source document — and stores it in a Postgres database with institutional metadata
4. Batches fingerprints into Merkle roots and anchors them to Bitcoin mainnet via `OP_RETURN`
5. Returns a verification URL that third parties can use to confirm anchor status and retrieve non-sensitive metadata
6. Logs each verification for audit and abuse detection

### 2.2 Scope and context

| Dimension | Value |
|-----------|-------|
| Geographic scope | Extraterritorial — no Kenyan infrastructure |
| Data subjects | Kenyan credential holders (students, professionals), institutional staff, verifiers |
| Volume | Expected < 10,000 Kenyan data subjects in year 1; growth TBD |
| Frequency | Continuous (real-time) |
| Duration | Credential records are permanent (business purpose); account data retained 7 years post-closure |

### 2.3 Purposes and lawful basis (Section 30)

| Purpose | Section 30 basis | Rationale |
|---------|-----------------|-----------|
| Credential issuance | 30(1)(a) contract | Institution is party to contract with Arkova; data subject receives service via institution |
| Verification by third parties | 30(1)(f) legitimate interests | Transparency and fraud prevention; documented balancing test in Section 8 below |
| Audit and fraud detection | 30(1)(c) legal obligation + 30(1)(f) legitimate interests | Anti-fraud regulations + platform integrity |
| Service operation | 30(1)(f) legitimate interests | Necessary for service provision |
| Marketing communications | 30(1)(a) consent | Separate opt-in only; not bundled |

---

## 3. Necessity and proportionality (Section 31(2)(b))

### 3.1 Necessity test

The processing is necessary because:

- **Credential fraud is a systemic problem** in credential-heavy sectors (education, healthcare, regulated professions). Arkova addresses a real harm and cannot operate without processing credential metadata.
- **The fingerprint-only architecture minimizes data collection** (Section 25(c) data minimization principle). Documents never leave the user's device.
- **No less-intrusive alternative** achieves the same verification guarantee. Paper transcripts, PDF seals, and issuer-hosted verification pages are all more privacy-invasive, more centralized, and less robust.

### 3.2 Data minimization (Section 25(c))

- Arkova stores **only structured metadata**, never source documents
- Fingerprints are SHA-256 hashes — cryptographically one-way, cannot be reversed to source content
- PII is stripped client-side before transmission (Constitution Section 1.6)
- Bitcoin anchoring publishes **only the Merkle root** — no metadata reaches the public chain
- Verification API responses return only fields the requester is authorized to see; internal IDs (`user_id`, `org_id`, `anchors.id`) are never exposed

### 3.3 Storage limitation (Section 25(e))

- Credential records: permanent (core business purpose)
- User accounts: 7 years post-closure
- Audit logs: 7 years
- Error logs: 90 days
- Webhook logs: 90 days

---

## 4. Identified risks

### 4.1 Risk register

| ID | Risk | Likelihood | Impact | Inherent risk |
|----|------|-----------|--------|--------------|
| R1 | Unauthorized access to credential metadata via broken RLS | Low | High | Medium |
| R2 | Cross-border transfer to US exposes data to US government access requests | Medium | Medium | Medium |
| R3 | Data subject cannot exercise Section 31-38 rights due to missing workflow | High | Medium | High (mitigated by REG-11) |
| R4 | Breach notification exceeds 72-hour ODPC deadline | Low | High | Medium (mitigated by REG-13) |
| R5 | Sensitive personal data (health credentials) processed without explicit consent | Medium | High | High |
| R6 | Fingerprint + verification URL enables re-identification via linked sources | Low | Medium | Low |
| R7 | Bitcoin anchoring is permanent — "right to erasure" collides with immutability | Medium | Medium | Medium |
| R8 | Institutional misuse — a Kenyan university uploads a student's record without consent | Medium | Medium | Medium |
| R9 | Verification API abuse — mass querying to build a database of Kenyan professionals | Low | Medium | Low (mitigated by rate limits, Constitution 1.10) |
| R10 | Audit log tampering conceals unauthorized access | Low | High | Medium |

### 4.2 Detailed analysis

**R1 — RLS bypass:** Every table has `FORCE ROW LEVEL SECURITY` and org-scoped policies (Constitution 1.4). All 190 migrations are reviewed; RLS is unit-tested via `src/tests/rls/helpers.ts`. SECURITY DEFINER functions include `SET search_path = public` to prevent injection. **Residual risk: Low.**

**R2 — US government access:** Supabase and Google Cloud are subject to US legal process (FISA 702, CLOUD Act). Arkova's **fingerprint-only architecture materially reduces this risk** — even a compelled disclosure yields only fingerprints and metadata, not source documents (which never leave the issuer's device). **Residual risk: Low.**

**R3 — Data subject rights:** Currently addressed ad hoc via `privacy@arkova.ai`. REG-11 (SCRUM-572) will deliver an in-product self-service rights workflow (access, correction, erasure, portability, objection) within 30 days of request. **Residual risk: Low once REG-11 ships.**

**R5 — Sensitive data consent (Section 46):** Health credentials and biometric-adjacent data fall under Section 2's definition of sensitive personal data. Section 46 requires **explicit consent** OR one of the Section 46(2) exceptions (performance of contract, vital interests, substantial public interest). Arkova relies on the contract exception, as the institution is the direct contractual party and has obtained upstream consent from the data subject. **Mitigation: institutional customers must warrant upstream consent in the Data Processing Agreement (REG-12). Residual risk: Medium.**

**R7 — Right to erasure vs. immutable ledger:** Bitcoin anchors store only a Merkle root — the data subject's personal data is never on-chain. Erasure is achieved by deleting the Postgres record (which contains the metadata) while the anchor remains as a cryptographic artifact. See `../gdpr-chain-limitation.md` for the detailed reasoning. **Residual risk: Low.**

**R8 — Institutional misuse:** Contractual safeguards in REG-12, institutional admin audit trails, data subject complaint channel. **Residual risk: Medium.**

---

## 5. Mitigation measures (Section 31(2)(c))

### 5.1 Technical measures

- **End-to-end encryption** — TLS 1.3 in transit, AES-256 at rest
- **Row-level security** on all 190+ migrations (Constitution 1.4)
- **Client-side fingerprinting** — documents never leave the user's device (Constitution 1.6)
- **KMS-managed signing keys** — AWS + GCP KMS for Bitcoin treasury
- **PII-scrubbed error reporting** — Sentry events strip user emails, document fingerprints, API keys
- **Zero Trust ingress** — Cloudflare Tunnel, no public ports
- **Rate limiting** — 100 req/min anonymous, 1000 req/min authenticated (Constitution 1.10)
- **Audit logging** — every credential operation recorded in `audit_events` table
- **Advisory locks** on cron jobs — prevents concurrent mutation races

### 5.2 Organizational measures

- **SOC 2 Type II** audit (evidence: `../soc2-evidence.md`)
- **Annual penetration testing** (9 findings from prior audit resolved)
- **Incident response plan** (`../incident-response-plan.md`)
- **Disaster recovery plan** (`../disaster-recovery.md`, RPO 1h, RTO 4h)
- **Security awareness training** (`../security-training.md`)
- **Data classification policy** (`../data-classification.md`)
- **Change management process** (`../change-management.md`)
- **Access reviews** quarterly (`../access-review-log.md`)

### 5.3 Contractual measures (Section 40)

- **Data Processing Agreements** with all institutional customers (REG-12 Standard Contractual Clauses framework)
- **Sub-processor register** (`../vendor-register.md`)
- **Upstream consent warranty** in Kenyan institutional DPAs (mitigates R5)
- **Audit rights** for institutional customers to inspect Arkova's processing

### 5.4 Governance measures

- **DPO appointment** (REG-28)
- **Kenya representative** appointed for ODPC liaison (REG-15)
- **72-hour breach notification procedure** (REG-13)
- **Privacy-by-design review** required for any new feature touching Kenyan data
- **Annual DPIA review** — revisit this document if processing materially changes

---

## 6. Rights of data subjects (Sections 26, 31-38)

Arkova will implement the following data subject rights for Kenyan data subjects:

| Right | DPA section | Implementation | Status |
|-------|-------------|----------------|--------|
| Information | 29 | Privacy notice (`privacy-notice.md`) | Draft |
| Access | 26(c), 31 | Self-service via `/privacy/requests` | Pending REG-11 |
| Rectification | 26(d) | Self-service + institutional correction flow | Pending REG-11 |
| Erasure | 40 | Metadata deletion; fingerprint on chain remains (unresolvable) | Pending REG-11 |
| Restriction of processing | 35 | Account suspension flag | Pending REG-11 |
| Data portability | 38 | JSON export of user's records | Pending REG-11 |
| Objection | 36 | Opt-out from marketing; processing objection for legitimate interests | Pending REG-11 |
| Automated decisioning | 35 | Arkova does not make solely automated decisions with legal effect on data subjects | N/A |

Response SLA: **30 days** (DPA Section 31(3)), extendable by 30 days with reasons (Section 32).

---

## 7. Cross-border transfer assessment (Section 48-49)

### 7.1 Transfer mapping

| Destination | Provider | Data category | Mechanism |
|-------------|---------|---------------|-----------|
| United States | Supabase (Postgres, Auth) | Credential metadata, account data | Section 48(1)(a) contract + SCCs |
| United States | Google Cloud Run | Worker runtime, batch processing | Section 48(1)(a) contract + SCCs |
| European Union | Supabase backup region | Disaster recovery copy | Section 48(1)(e) adequacy (EU) |
| United States / Global | Cloudflare | Edge ingress, tunnel | Section 48(1)(a) contract + SCCs |
| Public (Bitcoin mainnet) | Global | **Only Merkle root — no personal data** | Not a transfer (anonymous cryptographic artifact) |

### 7.2 Adequacy assessment

Kenya has **not issued an adequacy decision for the United States**. Transfers to the US rely on:

1. **Section 48(1)(a) — contractual necessity**: processing is necessary for the performance of the contract between the institution and Arkova
2. **Standard Contractual Clauses** (REG-12): executed with Kenyan institutional customers; subject to ongoing review following the CJEU Schrems II reasoning (which Kenya's ODPC has indicated alignment with)
3. **Supplementary technical measures**: encryption in transit and at rest, fingerprint-only architecture that minimizes exposure, PII scrubbing on error paths

### 7.3 Transfer impact assessment summary

The residual risk of US government access is **low** given:

- Arkova processes only metadata, not source documents
- No systematic surveillance of Kenyan data subjects has been observed in practice
- Kenyan users are not politically targeted; credential data is non-sensitive compared to, e.g., intelligence or activist records
- Contractual commitments from Supabase, GCP, and Cloudflare to push back on unlawful access requests

---

## 8. Legitimate interests balancing test (Section 30(1)(f))

**Purpose:** verification of credentials by authorized third parties (employers, regulators).

| Factor | Analysis |
|--------|----------|
| Legitimate interest | Fraud prevention; truthful labor market; protection of institutional reputation |
| Necessity | Cannot be achieved with less-intrusive means (paper transcripts are more invasive) |
| Balancing — impact on data subject | Limited: only metadata the subject has authorized via the institutional flow is exposed |
| Reasonable expectations | Data subjects expect their credentials to be verifiable — this is the entire purpose of issuing a credential |
| Safeguards | Rate limiting, audit logging, right to object (Section 36) |

**Conclusion:** legitimate interests are **not overridden** by data subject interests. Processing is lawful under Section 30(1)(f).

---

## 9. Consultation (Section 31(4))

_Optional: the ODPC may be consulted if the DPIA indicates high residual risk that cannot be mitigated._

Arkova's residual risk is assessed as **medium**, driven primarily by:

- R5 (sensitive data consent) — mitigated by institutional DPA warranties
- R8 (institutional misuse) — mitigated by contractual controls and audit logging
- Cross-border transfer to US — mitigated by fingerprint-only architecture

No high residual risks remain after mitigation. **ODPC pre-consultation is not required**, but the DPIA will be submitted alongside the REG-15 registration application for transparency.

---

## 10. Conclusion and action plan

This DPIA concludes that:

- Arkova's processing of Kenyan data subjects' credential metadata is **proportionate and necessary** for the service's stated purpose
- All identified risks are **adequately mitigated** by the combination of technical, organizational, contractual, and governance measures listed in Section 5
- No high residual risks remain
- Section 30 lawful bases are identified and documented
- Section 48 cross-border transfer mechanism (contract necessity + SCCs) is sufficient given supplementary measures

### 10.1 Action plan

| ID | Action | Owner | Status | Due |
|----|--------|-------|--------|-----|
| A1 | Appoint Kenya representative (Section 58) | Legal | Pending | Before REG-15 submission |
| A2 | Appoint DPO (Section 24) | Executive | Pending | REG-28 |
| A3 | Implement data subject rights workflow | Engineering | Pending | REG-11 |
| A4 | Implement 72-hour breach notification procedure | SRE | Pending | REG-13 |
| A5 | Draft + execute Kenya-specific SCCs with institutional customers | Legal | Pending | REG-12 |
| A6 | Publish Kenya privacy notice on website | Product | Draft | Before first Kenyan customer |
| A7 | Submit ODPC registration | Compliance | Pending | REG-15 |
| A8 | Annual DPIA review | Compliance | Scheduled | 2027-04-11 |

---

## 11. Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Author (Compliance) | _pending_ | | |
| Reviewer (DPO) | _pending_ | | |
| Approver (Executive) | Carson Seeger | | |

---

_Version history:_
- _0.1 (2026-04-11): Initial draft — REG-16_

_Next review: upon appointment of DPO; or if processing materially changes; or 2027-04-11 at latest._
