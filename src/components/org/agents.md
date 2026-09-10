# agents.md — components/org
_Last updated: 2026-07-21_

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

## Sub-org credit control (SCRUM-3865)

- `ManageSubOrgs.tsx` gained the credit provisioning control: parent balance in the header, per-sub-org balance, an amount field, and **Add Credits** / **Reclaim**. Both buttons drive one endpoint — the worker treats a negative amount as a reclaim, which is also the offboarding lever.
- The control is offered **only for an APPROVED affiliation**. Funding an org whose affiliation is pending or revoked would move credits across a boundary the parent has not (or no longer) accepted.
- `fetchCredits` is deliberately independent of `fetchSubOrgs` and swallows its failures: credit provisioning is additive to a panel that already worked, so a rollup outage degrades to "no balances shown" rather than taking approve/revoke down with it. `ManageSubOrgsCredits.test.tsx` pins that.
- Copy lives in `SUB_ORG_LABELS` (§1.3). The older local `SUB_ORG_STATE_COPY` block in this file is a leftover from when `copy.ts` was locked under a concurrent PR — new strings go in `copy.ts`.
- The row header is `flex-wrap`: with the actions pinned on one line the org name truncated to a single character at 375px.
- UAT: `uat-harness/` renders this component with stubbed supabase/worker modules, so the visual pass needs no local Supabase — the local stack is shared across worktrees and a concurrent `stop` would wipe the run. Screenshots at 1280 and 375 in `docs/staging/hakichain-suborgs-2026-09/`.
