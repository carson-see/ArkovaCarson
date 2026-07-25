# agents.md — components/reports
_Last updated: 2026-05-30_

## What This Folder Contains
AI-generated report components: generation triggers, status tracking, and download/viewing.

## Key Files
- `AIReportsPanel.tsx` — Report generation UI: trigger new reports (integrity_summary, etc.), view status, and download results
- `ReportsList.tsx` — List of user's generated reports with download options; entitlement-gated access. Handles all four states (SCRUM-1999): loading spinner, empty ("No reports generated yet"), explicit load-error banner with Retry (`role="alert"`), and permission via the `hasReportsEntitlement` plan notice.
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useAIReports` — report data, generation triggers, and status polling

## Do / Don't Rules
- DO: Gate report generation behind entitlement checks — not all plans include reports
- DO: On a data-fetch failure, set an explicit error state and render the error banner — never just `console.error` and fall through to the empty state (SCRUM-1999). Error copy lives in the local `REPORTS_STATE_COPY` constant (promote to `src/lib/copy.ts` when that file is unlocked).

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

AIReportsPanel report names/descriptions scrubbed ("Record Analytics", "Total Records"). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
