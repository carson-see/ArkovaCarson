# agents.md — components/reports
_Last updated: 2026-05-16_

## What This Folder Contains
AI-generated report components: generation triggers, status tracking, and download/viewing.

## Key Files
- `AIReportsPanel.tsx` — Report generation UI: trigger new reports (integrity_summary, etc.), view status, and download results
- `ReportsList.tsx` — List of user's generated reports with download options; entitlement-gated access
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useAIReports` — report data, generation triggers, and status polling

## Do / Don't Rules
- DO: Gate report generation behind entitlement checks — not all plans include reports
