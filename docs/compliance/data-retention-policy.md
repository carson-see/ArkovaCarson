# Data Retention Policy

> **Version:** 2026-03-23
> **Classification:** CONFIDENTIAL
> **SOC 2 Control:** CC6.5 (Data Retention and Disposal)
> **Regulatory Alignment:** SOC 2 Type II, SOX, GDPR
> **Owner:** Engineering Lead / Data Protection Officer
> **Review Cadence:** Annual (next review: 2027-03-23)

---

## 1. Purpose

This policy defines retention periods, archival procedures, and deletion requirements for all data categories within the Arkova platform. Retention periods are designed to satisfy financial compliance obligations (SOX/SOC 2), support cryptographic proof chain integrity, and comply with GDPR data minimization principles.

**Governing principle:** Data shall be retained only as long as necessary to fulfill the purpose for which it was collected, meet legal and regulatory obligations, or maintain the integrity of cryptographic proof chains.

---

## 2. Retention Schedule

### 2.1 Summary Table

| Data Category | Table/Store | Retention Period | Justification | Disposal Method |
|--------------|-------------|-----------------|---------------|-----------------|
| Audit events | `audit_events` | 7 years | SOX/SOC 2 financial compliance | Archival then deletion |
| Billing events | `billing_events` | 7 years | Financial records retention (SOX) | Archival then deletion |
| Verification events | `verification_events` | Indefinite | Part of cryptographic proof chain | No deletion |
| Anchor chain index | `anchor_chain_index` | Indefinite | Blockchain reference data (immutable) | No deletion |
| Anchor records | `anchors` | Indefinite | Core proof chain data | No deletion |
| User activity logs | Application logs | 1 year | Operational monitoring | Automated deletion |
| Session logs | Application logs | 1 year | Security monitoring | Automated deletion |
| AI extraction metadata | `ai_extraction_results` | 2 years | Model improvement + audit trail | Archival then deletion |
| AI prompt versions | `ai_prompt_versions` | 2 years | Prompt lineage tracking | Archival then deletion |
| User profiles (active) | `profiles`, `auth.users` | Duration of account | Service delivery | Anonymization on deletion |
| User profiles (deleted) | `profiles`, `auth.users` | Anonymized immediately | GDPR compliance (migration 0061) | Anonymization |
| Organization data (active) | `organizations` | Duration of account | Service delivery | Anonymization on deletion |
| API keys (hashed) | `api_keys` | Duration of account + 90 days | Access audit trail | Hard deletion |
| Database backups | Supabase automated backups | 30 days rolling | Disaster recovery | Automatic rotation |
| Sentry error events | Sentry SaaS | 90 days | Debugging and incident response | Automatic expiry |
| CI/CD logs | GitHub Actions | 90 days | Build audit trail | Automatic expiry |

### 2.2 Detailed Retention Rules

#### 2.2.1 Audit Events (7 Years)

**Tables:** `audit_events`

Audit events capture all security-relevant actions including authentication, authorization changes, data access, and administrative operations. The 7-year retention period satisfies:

- SOC 2 Type II continuous monitoring requirements
- SOX Section 802 record retention (7 years)
- Potential litigation hold requirements

**Archival procedure:** After 2 years, audit events older than the active window are migrated to cold storage (compressed, encrypted). Archived records remain queryable for compliance investigations.

#### 2.2.2 Billing Events (7 Years)

**Tables:** `billing_events`, Stripe records

All financial transactions, subscription changes, invoice generation, and payment processing records. The 7-year retention aligns with:

- IRS record retention requirements
- SOX financial record obligations
- Stripe's own data retention (synchronized)

**Archival procedure:** After 2 years, billing events are archived to cold storage. Stripe retains its own copies per their data retention policy.

#### 2.2.3 Verification Events (Indefinite)

**Tables:** `verification_events`

Verification events are part of the cryptographic proof chain and must be retained indefinitely. Each verification event is linked to an anchor record that references an immutable blockchain entry. Deleting verification events would break the ability to validate historical proofs.

**No deletion or archival.** These records are compact (metadata only, no document content) and growth is bounded by anchoring volume.

#### 2.2.4 Anchor Chain Index (Indefinite)

**Tables:** `anchor_chain_index`, `anchors`

Blockchain reference data including network receipts, confirmation data, and chain state. This data is a local index of publicly available blockchain information and must be retained to support proof verification without requiring live chain queries.

**No deletion or archival.** Data mirrors immutable blockchain state.

#### 2.2.5 User Activity and Session Logs (1 Year)

**Store:** Application logs (Cloud Run, Vercel, Cloudflare)

Server-side request logs, session activity, and operational telemetry. Retained for security monitoring, incident investigation, and performance analysis.

**Automated deletion:** Logs older than 1 year are automatically purged by the logging infrastructure. No manual intervention required.

#### 2.2.6 AI Extraction Metadata (2 Years)

**Tables:** `ai_extraction_results`, `ai_prompt_versions`

Metadata from AI-powered document analysis (classification, confidence scores, extracted field summaries). This data never contains original document content or PII (per Constitution 1.6 -- all PII is stripped client-side before transmission).

Retained for:
- Model performance evaluation and improvement
- Audit trail of AI-assisted decisions
- Bias detection and fairness analysis

**Archival procedure:** After 2 years, extraction metadata is archived to cold storage for an additional 1 year, then permanently deleted.

#### 2.2.7 User Profiles After Deletion (GDPR Compliance)

**Tables:** `profiles`, `auth.users`, `organizations`

When a user requests account deletion:

1. **Immediate anonymization** per migration 0061:
   - Email replaced with anonymized placeholder
   - Display name cleared
   - Personal identifiers removed
   - Organization membership severed
2. **Proof chain integrity preserved:** Anchor records and verification events retain their `org_id` references but no longer link to identifiable individuals.
3. **Billing records retained:** Financial records are retained for the 7-year compliance period but with anonymized user references.
4. **API keys revoked and deleted:** All API keys associated with the account are immediately invalidated and removed after 90-day audit window.

This approach satisfies GDPR Article 17 (Right to Erasure) while preserving the integrity of cryptographic proof chains that serve legitimate business interests (GDPR Article 17(3)(b)).

#### 2.2.8 Database Backups (30 Days Rolling)

**Store:** Supabase automated backups

Point-in-time recovery backups are maintained on a 30-day rolling window. Older backups are automatically replaced.

- Backups are encrypted at rest
- Access restricted to infrastructure administrators
- Restoration requires documented approval

---

## 3. GDPR Compliance Notes

### 3.1 Data Minimization (Article 5(1)(c))

Arkova collects only the minimum data necessary for service delivery:

- **Documents are never stored server-side** (Constitution 1.6)
- Only PII-stripped metadata and cryptographic fingerprints are transmitted
- User profile data is limited to authentication and billing requirements

### 3.2 Storage Limitation (Article 5(1)(e))

Personal data is kept in identifiable form no longer than necessary:

- Active accounts: data retained for service delivery
- Deleted accounts: immediately anonymized (migration 0061)
- Operational logs: 1-year automated expiry
- Financial records: 7-year retention per legal obligation (Article 17(3)(b) exemption)

### 3.3 Right to Erasure (Article 17)

Users may request account deletion at any time. Upon request:

- Personal data is anonymized within 30 days (target: immediate)
- Cryptographic proof chain data is retained under Article 17(3)(b) (legal obligation / legitimate interest)
- Financial records are retained under Article 17(3)(b) (legal obligation)
- Confirmation of anonymization is provided to the user

### 3.4 Data Processing Records (Article 30)

This retention policy, combined with `docs/compliance/data-classification.md`, serves as the record of processing activities required under Article 30.

---

## 4. Archival Procedures

### 4.1 Archival Process

For data categories with archival before deletion:

1. **Identify:** Automated job identifies records past the active retention window.
2. **Export:** Records exported to encrypted archive format (AES-256).
3. **Verify:** Archive integrity verified via checksum.
4. **Transfer:** Archive transferred to cold storage.
5. **Confirm:** Source records marked as archived with reference pointer.
6. **Purge source:** Source records deleted after archive confirmation (with 30-day grace period).

### 4.2 Archive Access

- Archived data is read-only.
- Access requires documented business justification and approval from the Data Protection Officer.
- All archive access is logged in `audit_events`.
- Archives are encrypted at rest and in transit.

---

## 5. Deletion Procedures

### 5.1 Soft Deletion vs Hard Deletion

| Method | Used For | Mechanism |
|--------|----------|-----------|
| Anonymization | User profiles, personal data | Replace PII with anonymous placeholders (migration 0061) |
| Hard deletion | Expired logs, archived-then-expired records, revoked API keys | `DELETE` with audit trail |
| Automated expiry | Application logs, Sentry events, CI/CD logs | Infrastructure-managed TTL |
| No deletion | Proof chain data, blockchain references | Retained indefinitely |

### 5.2 Deletion Verification

- Deletion jobs log the count and category of records removed.
- Monthly reconciliation confirms deletion schedules are executing correctly.
- Annual audit verifies no data is retained beyond its defined retention period (excluding indefinite categories).

---

## 6. Exceptions and Legal Holds

### 6.1 Legal Hold

When litigation, regulatory investigation, or audit requires preservation of data that would otherwise be deleted:

1. Legal counsel issues a written preservation notice.
2. Affected data categories are flagged with a hold marker.
3. Automated deletion is suspended for flagged records.
4. Hold is released only upon written authorization from legal counsel.
5. Normal retention schedule resumes after hold release.

### 6.2 Exceptions

Any exception to this policy requires:

- Written justification
- Approval from the Data Protection Officer
- Documentation in this policy's revision history
- Time-bounded scope (no permanent exceptions)

---

## 7. Revision History

| Date | Version | Change | Author |
|------|---------|--------|--------|
| 2026-03-23 | 1.0 | Initial document creation | Engineering |
