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
- 2026-08-10 (public-copy leak): `JurisdictionPrivacyNotices.tsx` renders `notice.description` unsanitized at the `eu-us-transfer` card, and that card is reached from `PrivacyPage` — an UNAUTHENTICATED public route (`App.tsx`). `PRIVACY_NOTICE_LABELS.DPF_DESCRIPTION` ended with an internal drafting instruction, `[Counsel review required — do not assert a specific transfer mechanism until confirmed.]`, which shipped verbatim to anyone reading our privacy page, including EU prospects doing transfer-basis diligence. The bracketed note is removed; the instruction survives as a source comment in `copy.ts`. The transfer-basis cell, which read `...(counsel-required)`, now uses the new `PRIVACY_NOTICE_LABELS.DPF_TRANSFER_BASIS` (§1.3 — it was an inline literal) and states the position as a deliberate public disclosure: "Under legal review — no specific transfer mechanism is asserted at this time".
  **The caution is deliberate and must not be "fixed" by strengthening it.** Arkova holds no DPF self-certification (SCRUM-2283 removed that false claim) and no confirmed EU→US mechanism; naming one here is a §1.13 R-7 violation. Guards: `src/lib/copy-internal-scaffolding.test.ts` (no bracketed segments or staff-directive markers in ANY shipped copy string, plus a no-upgraded-claim assertion on both keys) and the `eu-us-transfer` case in `JurisdictionPrivacyNotices.test.tsx`. The other 12 notices still carry their `transferBasis` as inline literals — those describe third-party statutory instruments, but they are user-visible copy and should migrate to `copy.ts` when next touched. (Count corrected from "13" in review: the table has 13 entries total, so 12 others.)
- 2026-08-10 (follow-up, §1.3 completion): the remaining-notices migration
  flagged above is done — `JURISDICTION_NOTICES` now sources ALL of
  `regulator` / `rights` / `transferBasis` / `breachTimeline` from the new
  `PRIVACY_NOTICE_LABELS.*_REGULATOR/_RIGHTS/_TRANSFER_BASIS/_BREACH_TIMELINE`
  keys (`rights` is `readonly string[]` — the copy.ts values are `as const`).
  Only `regulatorUrl` (hrefs) remains inline (`color` was dead data — declared
  and assigned but never rendered — and is deleted, per simplify review);
  they are not copy. Rendered output verified byte-identical. Regression is
  test-enforced from two sides: `src/pages/PrivacyPage.copy-centralization.test.tsx`
  fails on any inline literal in a copy field of this table AND on any rendered
  /privacy prose that copy.ts does not own.
