# agents.md — components/org
_Last updated: 2026-05-30_

## What This Folder Contains
Organization management components: sub-org hierarchy, org verification, and affiliation requests.

## Key Files
- `ManageSubOrgs.tsx` — Displays and manages affiliated sub-organizations; parent admins can create, approve, and revoke affiliates. The initial sub-orgs load handles each state (SCRUM-1999 sibling): loading spinner, empty ("No affiliated organizations yet."), and an explicit load-error banner with Retry (`role="alert"`). Load-error copy lives in the local `SUB_ORG_STATE_COPY` constant.
- `OrgVerification.tsx` — Multi-step org verification flow: submit EIN/Tax ID -> verify domain via email code -> verified
- `RequestAffiliationDialog.tsx` — Dialog for requesting affiliation with a parent organization
- `index.ts` — Barrel exports

## Dependencies
- `@/lib/workerClient` (WORKER_URL) — worker endpoints for verification and sub-org management
- `@/lib/supabase` — direct Supabase queries for org data

## Do / Don't Rules
- DO: Use dev bypass endpoints in development mode for auto-completing verification steps
- DO: Use copy from `SUB_ORG_LABELS` for all sub-org UI strings
- DO: On the initial sub-orgs fetch failure, set the `loadError` state and render the error banner with Retry — never silently `return` on `!response.ok` or swallow the `catch` and fall through to the empty state (SCRUM-1999 sibling). Create/approve/revoke action errors stay on toast.

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

OrgVerification verified-badge helper text scrubbed ("shown on all your records"). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
