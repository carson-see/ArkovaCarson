# agents.md — components/compliance
_Last updated: 2026-07-22_

## What This Folder Contains
Compliance monitoring and audit UI: score cards, audit gap analysis, jurisdiction privacy notices, and session timeout handling.

## Key Files
- `ComplianceScoreGauge.tsx` — Visual gauge for compliance score percentage
- `GradeBadge.tsx` — Letter grade badge (A/B/C/D/F) with color coding
- `AuditGapScorecard.tsx` — Filterable audit gap display by jurisdiction and category (MISSING/EXPIRED/EXPIRING_SOON/INSUFFICIENT)
- `AuditMyOrganizationButton.tsx` — Triggers a compliance audit run for the current org
- `ExpiringDocumentsCard.tsx` — Shows documents approaching expiration
- `MissingDocumentsCard.tsx` — Shows required documents not yet uploaded
- `RecommendationsCard.tsx` — AI-generated compliance improvement recommendations
- `JurisdictionPrivacyNotices.tsx` — Jurisdiction-specific privacy notice display
- `SessionTimeoutBanner.tsx` — HIPAA-compliant session timeout warning banner
- `ProfessionalEducationExportPanel.tsx` — CPE/CLE compliance-log export panel (workerFetch -> signed URL). SCRUM-2378: renders the inline excluded-records notice (`excluded_count` from the hardened worker endpoints, `data-testid="excluded-records-notice"`) — exclusions are surfaced, never blocking; notice copy asserts only "aren't secured" (no "will appear once secured" promise — false for revoked/expired records, round-1 review). SCRUM-2379: always renders the section 1.5 jurisdiction-informational disclaimer (`data-testid="jurisdiction-disclaimer"`, copy key `PROFESSIONAL_EDUCATION_S3_LABELS.JURISDICTION_DISCLAIMER`). NOTE: user_id validation uses a Postgres-UUID regex, NOT `z.string().uuid()` — Zod v4 enforces RFC version/variant bits and rejects deterministic seed ids.
- `OrgCpeMemberDashboard.tsx` — CPE-02 (SCRUM-2380) org CPE dashboard MVP: per-member secured vs in-progress tiles + last activity + terminal-records footnote (`org-cpe-terminal-footnote`, revoked/expired/superseded counted explicitly — round-1 review) over the live `useOrgCpeMemberSummary` hook (no new table, no migration; 0342 partial-index read shape). Org admins see org members; a plain member's data layer is pinned to own rows (query-layer — the standing `anchors_select` policy grants org members the org-wide read; see tests/rls/cpe-org-dashboard.test.ts).
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useLatestComplianceAudit` — reads from `compliance_audits` (not legacy `compliance_scores`)

## Do / Don't Rules
- DO: Read compliance data from `compliance_audits` table (NCA-03), not the legacy `compliance_scores` table
- DO: Compliance section is accessed via admin sidebar toggle, not primary nav

## Recent Changes
- 2026-07-22 SCRUM-2914 (Founder UI findings): `ComplianceScoreCard.tsx` deleted (dashboard-only, no other importer) + removed from `index.ts` and `DashboardPage.tsx`. `AuditMyOrganizationButton.tsx` kept — still used by `src/pages/ComplianceScorecardPage.tsx`; its `DashboardPage.tsx` render was removed but the component itself is not dead.
