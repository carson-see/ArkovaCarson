# agents.md — components/org
_Last updated: 2026-05-16_

## What This Folder Contains
Organization management components: sub-org hierarchy, org verification, and affiliation requests.

## Key Files
- `ManageSubOrgs.tsx` — Displays and manages affiliated sub-organizations; parent admins can create, approve, and revoke affiliates
- `OrgVerification.tsx` — Multi-step org verification flow: submit EIN/Tax ID -> verify domain via email code -> verified
- `RequestAffiliationDialog.tsx` — Dialog for requesting affiliation with a parent organization
- `index.ts` — Barrel exports

## Dependencies
- `@/lib/workerClient` (WORKER_URL) — worker endpoints for verification and sub-org management
- `@/lib/supabase` — direct Supabase queries for org data

## Do / Don't Rules
- DO: Use dev bypass endpoints in development mode for auto-completing verification steps
- DO: Use copy from `SUB_ORG_LABELS` for all sub-org UI strings
