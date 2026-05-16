# agents.md — components/compliance
_Last updated: 2026-05-16_

## What This Folder Contains
Compliance monitoring and audit UI: score cards, audit gap analysis, jurisdiction privacy notices, and session timeout handling.

## Key Files
- `ComplianceScoreCard.tsx` — Dashboard widget showing latest audit score/grade from `compliance_audits` table
- `ComplianceScoreGauge.tsx` — Visual gauge for compliance score percentage
- `GradeBadge.tsx` — Letter grade badge (A/B/C/D/F) with color coding
- `AuditGapScorecard.tsx` — Filterable audit gap display by jurisdiction and category (MISSING/EXPIRED/EXPIRING_SOON/INSUFFICIENT)
- `AuditMyOrganizationButton.tsx` — Triggers a compliance audit run for the current org
- `ExpiringDocumentsCard.tsx` — Shows documents approaching expiration
- `MissingDocumentsCard.tsx` — Shows required documents not yet uploaded
- `RecommendationsCard.tsx` — AI-generated compliance improvement recommendations
- `JurisdictionPrivacyNotices.tsx` — Jurisdiction-specific privacy notice display
- `SessionTimeoutBanner.tsx` — HIPAA-compliant session timeout warning banner
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useLatestComplianceAudit` — reads from `compliance_audits` (not legacy `compliance_scores`)

## Do / Don't Rules
- DO: Read compliance data from `compliance_audits` table (NCA-03), not the legacy `compliance_scores` table
- DO: Compliance section is accessed via admin sidebar toggle, not primary nav
