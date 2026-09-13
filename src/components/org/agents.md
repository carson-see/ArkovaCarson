# agents.md — components/org
_Last updated: 2026-09-13_

## What This Folder Contains
Organization management components: sub-org hierarchy, org verification, and affiliation requests.

## Key Files
- `ManageSubOrgs.tsx` — Displays and manages affiliated sub-organizations; parent admins can create, approve, and revoke affiliates. The initial sub-orgs load handles each state (SCRUM-1999 sibling): loading spinner, empty ("No affiliated organizations yet."), and an explicit load-error banner with Retry (`role="alert"`). Load-error copy lives in the local `SUB_ORG_STATE_COPY` constant.
- `SubOrgListingConsentToggle.tsx` — SCRUM-3864: one org's half of the two-party public-listing consent (migration 0429). Side-agnostic — the caller supplies `onToggle`; see the 2026-09-13 entry below.
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

## 2026-09-13 SCRUM-3864 — public-listing consent toggle (new component)

Migration 0429 (already on `origin/main`, well before this session — see `docs/uat/suborg-listing/SURFACES.md` for the full correction to this ticket's premise) added `organizations.sub_org_listing_parent_optin` / `sub_org_listing_child_optin`. Both live on the CHILD org's row; an affiliation is published on any public surface only when both are true. This folder gained the toggle UI that was the one genuinely missing piece:

- `SubOrgListingConsentToggle.tsx` renders ONE org's own half plus read-only status text for the other party ("Listed on public pages" / a side-specific "waiting on..." string / "Not shown on public pages"). It never renders a control for the OTHER party's flag — an org cannot set the other side's consent, and the DB trigger (`protect_org_tenancy_fields()`) refuses that write regardless.
- `ManageSubOrgs.tsx` renders one instance per APPROVED sub-org row (same place the credit-provisioning controls already live — offered only for an APPROVED affiliation, same rationale). Its `onToggle` is `useAffiliateListingConsent().setParentListingOptin(sub.id, next)` — the PARENT admin writing to the CHILD's row, which works because `buildAffiliateMembershipRows` already made them an `org_members` owner of the child (RLS lets the UPDATE through), while the trigger's column-level guard is what actually decides they may touch `sub_org_listing_parent_optin` specifically (see `src/hooks/agents.md`).
- The `GET /api/v1/org/sub-orgs` worker response gained both flags (see `services/worker/src/api/v1/agents.md`) so this panel can show current state without an extra per-row query. `SubOrg.sub_org_listing_parent_optin` / `_child_optin` are `?:` (optional) in the local interface for backward compatibility with any cached response shape.
- `OrgProfilePage.tsx` renders the CHILD-side instance in its own "Sub-Organization Affiliation" section, wired to `useOrganization().updateOrganization` (a same-row self-update, simpler than the parent case since both consent columns already live on the row `useOrganization` already fetches).
- No JS/TS predicate (`isAffiliationPubliclyListed`) exists anywhere — the only two public-facing surfaces that ever leaked an affiliation (`get_public_org_profile`, `get_org_subtree`) decide entirely inside their own SQL body, and adding a parallel JS copy of that decision with no call site would be dead code. See `docs/uat/suborg-listing/SURFACES.md`.
- Tests: `SubOrgListingConsentToggle.test.tsx` (pure component), `src/hooks/useAffiliateListingConsent.test.ts` (the parent-side write path), `ManageSubOrgs.test.tsx`'s new `describe('public listing consent', ...)` block, and `tests/rls/suborg-listing-consent.test.ts` (the trigger itself, against a live Supabase instance).
