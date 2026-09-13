# agents.md — components/org
_Last updated: 2026-09-13_

## What This Folder Contains
Organization management components: sub-org hierarchy, org verification, and affiliation requests.

## Key Files
- `ManageSubOrgs.tsx` — Displays and manages affiliated sub-organizations; parent admins can create, approve, revoke, fund and offboard affiliates. Renders on the org profile's **Affiliates** tab (NOT Settings — moved 2026-09-13). Takes an optional `onCountsChange` prop and reports `{ pending, approved }` after every successful list load, or `null` when the load failed, so the page can badge the tab. The initial sub-orgs load handles each state (SCRUM-1999 sibling): loading spinner, empty ("No affiliated organizations yet."), and an explicit load-error banner with Retry (`role="alert"`). Load-error copy lives in `SUB_ORG_LABELS.LOAD_ERROR_*`.
- `OrgVerification.tsx` — Multi-step org verification flow: submit EIN/Tax ID -> verify domain via email code -> verified
- `RequestAffiliationDialog.tsx` — Dialog for requesting affiliation with a parent organization
- `index.ts` — Barrel exports

## Dependencies
- `@/lib/workerClient` (WORKER_URL) — worker endpoints for verification and sub-org management
- `@/lib/supabase` — direct Supabase queries for org data

## Do / Don't Rules
- DO: Use dev bypass endpoints in development mode for auto-completing verification steps
- DO: Use copy from `SUB_ORG_LABELS` for all sub-org UI strings
- DO: Route every worker `{ error }` through `translateWorkerError()`. NEVER `toast.error(data.error)` — the worker replies with a mix of engineer-facing sentences and machine codes (`sub_org_limit_reached`, `credit_allocation_unavailable`), and all of them used to reach the customer. An unmapped code falls back to the generic copy AND is `console.error`-logged; it is never swallowed.
- DO: Add a `WORKER_ERROR_COPY` entry for every reply an endpoint you wire up can actually send, not just the interesting ones. Unmapped is a working state, not a finished one: it shows generic "please try again" copy and `console.error`s on every occurrence. The cancel endpoint's four replies were mapped on 2026-09-13 for that reason — `No pending affiliation request to cancel` (the 400 when the parent approved or revoked in another tab) was the worst of them, because "try again" is advice that cannot work once the request is gone. Read the route's `res.status(...).json({ error })` calls and map what you find. The map is keyed on the reply string, so an endpoint-specific sentence is fine alongside the shared machine codes.
- DO: Name the organization in every destructive confirmation. At 375 px the row name wraps but the dialog has no row to read from.
- DON'T: Report `{ pending: 0 }` through `onCountsChange` when the list failed to load — pass `null`. A tab badge reading zero is a reassurance we have not earned.
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

## 2026-09-12 SCRUM-5024 — `ReferralPanel.tsx` (new)

The organization's referral code, the share link, and the organizations that
joined through it. Three pinned behaviours (`ReferralPanel.test.tsx`):

- **No auto-mint on load** — the create button is the only path to a code.
- **A failed load renders an error + retry, never an empty table.** "You referred
  nobody" and "we could not find out" are different facts and the partner must be
  able to tell them apart.
- **`REFERRAL_LABELS.NOT_ASSERTED` is rendered unconditionally.** It is the §1.5
  measured / not-asserted boundary extended by the R-7 claims gate, not a
  footnote: the page states which organizations entered the code and when, and
  explicitly does not represent a commission, discount or payment. Do not soften
  it into marketing language.

Row keys fall back to `(displayName, referredAt)` when an organization has no
public id — never to an internal identifier, because none is fetched.
- Copy lives in `SUB_ORG_LABELS` (§1.3). The local `SUB_ORG_STATE_COPY` block that held the load-error strings while `copy.ts` was locked under a concurrent PR was promoted into `SUB_ORG_LABELS` on 2026-09-13 (`LOAD_ERROR_TITLE` / `LOAD_ERROR_DESC` / `LOAD_ERROR_RETRY`) and no longer exists — every string is in `copy.ts` now.
- The row stacks (`flex-col sm:flex-row`) and the name wraps: pinned on one line the org name truncated to ~8 characters at 375 px, which identified the organization worse than its own status chip did (2026-09-13 UAT finding 10).
- UAT (superseded 2026-09-13 by `e2e/uat-suborg-ux.spec.ts`, which drives the real router in a browser at 1280 and 375 with Supabase and the worker stubbed via `page.route`; the `uat-harness/` directory this line described is no longer in the tree): the visual pass needs no local Supabase — the local stack is shared across worktrees and a concurrent `stop` would wipe the run. Screenshots at 1280 and 375 in `docs/staging/hakichain-suborgs-2026-09/`.


## 2026-09-13 founder feedback — sub-org findability (UAT: `docs/uat/suborg-ux/FINDINGS.md`)

Founder: "when I try and use sub orgs it's clunky and confusing". The UAT walk found **no missing
capability** — every parent-side action the API offers was already wired — so nothing here gained an
endpoint. What changed:

- the panel moved off the bottom of the Settings tab (measured 2,396 px down at 1280 px / 2,996 px
  at 375 px) onto its own **Affiliates** tab, now 476 px / 490 px down;
- the list renders ABOVE the create form, which is a disclosure (`showCreate`). Specs that type into
  the create fields must click "Add an organization" first;
- **Revoke now confirms.** Its copy states only that the affiliation is severed — it must NOT claim
  the organization is suspended or stopped from securing documents, which is what Offboard does;
- counts are singular/plural and the pending count is stated separately;
- rows stack below `sm` so the display name wraps instead of truncating to ~8 characters.

Tests: `ManageSubOrgsFindability.test.tsx` (17 cases as of the 2026-09-13 CTO review below — 15
original + 2 covering the revoke confirmation's default focus and double-click protection) plus
updates to `ManageSubOrgs.test.tsx` (create disclosure, revoke confirmation) and
`ManageSubOrgsOffboard.test.tsx` (named dialog title).

## 2026-09-13 CTO review (PR #2907) — revoke confirmation, Enter/double-click safety verified

Review focus was whether the new Revoke `AlertDialog` (finding 4 above) could be bypassed by a
stray Enter keypress or fired twice by a double click. Both were previously assumed-safe by
similarity to SCRUM-3868's Offboard dialog, which used the same shape but was never itself pinned by
a test. Added two tests: default focus lands on `AlertDialogCancel` ("Keep Affiliation"), not the
destructive `AlertDialogAction`, so a stray Enter right after the dialog opens cannot revoke; and a
synchronous `fireEvent.click` × 2 on the confirm button (the shape that would actually race, unlike
`userEvent.click` which yields between events) sends exactly one `/sub-orgs/revoke` request, because
`setActionLoading` runs synchronously as the first line of `handleRevoke` and
`testing-library`'s `act()`-wrapped `fireEvent` flushes that before the second click is dispatched.
Also confirmed and documented (`src/pages/agents.md`'s dated entry): the "pending/revoked children
see the parent's real name" claim in `docs/uat/suborg-ux/FINDINGS.md` finding 3 does not hold for the
common case — RLS on `organizations` blocks the read for a child that requested affiliation into an
existing parent, and the UI falls back to the generic label, same as before this PR. Not a security
issue; a false "Fixed" claim, corrected in that file with regression tests added here.
