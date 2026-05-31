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
