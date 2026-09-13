# Sub-organisation management — UAT findings

_Captured 2026-09-13 against `origin/main` @ `8cbb0f02e`, local dev server, Supabase and worker
stubbed at the network layer (no rig touched). Founder feedback that prompted it: **"when I try
and use sub orgs it's clunky and confusing"** and **"make sure we can do all this in our dashboard
as well"**._

Reproduce either capture from the same spec:

```bash
npm run dev -- --port 5173 --strictPort
# before (against an unmodified origin/main checkout)
SUBORG_UAT_OUT=before SUBORG_UAT_TAB=settings \
  npx playwright test e2e/uat-suborg-ux.spec.ts --config=e2e/uat-suborg-ux.config.ts
# after
npx playwright test e2e/uat-suborg-ux.spec.ts --config=e2e/uat-suborg-ux.config.ts
```

Screenshots: `before/` and `after/`, each `<step>-<width>.png` at 1280 and 375.

---

## Headline: nothing was missing, everything was buried

Every parent-side action the API offers is present in the dashboard. Checked one by one against
`services/worker/src/api/v1/orgSubOrgs.ts`:

| API capability | Route | Reachable in the dashboard before this change? |
|---|---|---|
| List affiliates | `GET /api/v1/org/sub-orgs` | Yes — Settings tab, 2,396 px down |
| Approve | `POST …/approve` | Yes — same place |
| Revoke | `POST …/revoke` | Yes — same place, **no confirmation** |
| Allocate credits | `POST …/credits` | Yes — same place |
| View balances | `GET …/credits` | Yes — parent balance and child balance both shown |
| Offboard (reclaim + suspend) | `POST …/offboard` | Yes — same place, confirmed |
| Create an affiliate | `POST …/create` | Yes — same place |
| Request affiliation (child side) | `POST …/request` | Yes, **except when revoked** — finding 2 |
| Cancel a request (child side) | `POST …/cancel` | Yes |
| Set the affiliate cap | `POST …/max` | **No UI at all** — finding 13 |

So the founder's "clunky and confusing" is a findability and wording problem, not a capability gap.
The measurement below is the core of it.

**Measured depth of the panel heading inside the scrolling column** (`discoverability-*.json`,
captured on a deliberately *empty* org — 0 records, 0 members — so this is the best case):

| Viewport | Before | After | Viewports of scrolling, before → after |
|---|---|---|---|
| 1280 × 800 | 2,396 px | 476 px | 3.00 → 0.59 |
| 375 × 812 | 2,996 px | 490 px | 3.69 → 0.60 |

---

## Findings

Severity: **blocks task** / **confusing** / **cosmetic**.

### 1. A waiting affiliation request is invisible from every screen. — blocks task

The org page's tab row read Home / People / Settings. Neither the dashboard nor the org Home tab
showed any count, badge or notice that another organisation was waiting on approval. The only
Approve button lived at the bottom of the Settings tab, after fifteen profile fields, the
verification card and four connector cards — 2,396 px down at 1280 px and 2,996 px at 375 px. A
parent admin has no way to learn there is anything to do.

*Evidence:* `before/step2-org-page-home-tab-1280.png` (tab row, no affiliates entry),
`before/step1-dashboard-home-1280.png`, `before/discoverability-1280.json`,
`before/discoverability-375.json`.
*Fix:* give the org page an **Affiliates** tab carrying the pending-request count as a badge, and
move the panel to it. **Fixed.**

### 2. A revoked child organisation has no way to request a new affiliation. — blocks task

The "Request Affiliation" control was gated on `!isChildOrg`, and `isChildOrg` is derived from
`parent_org_id`, which a revoked child *keeps*. So the one organisation that most needs the control
is the one that cannot see it: it shows "Affiliation revoked by …" and nothing else, permanently.
The comment directly above the markup already said `(for non-child orgs or revoked)` — the condition
never matched its own stated intent.

*Evidence:* `before/step11-revoked-child-dead-end-1280.png`.
*Fix:* render the control when `!isChildOrg || parentApprovalStatus === 'REVOKED'`, labelled
"Request Affiliation Again", and explain what being revoked means for them. **Fixed.**

### 3. Pending and revoked children are told the parent is called "parent organization". — blocks task

`fetchParentOrgName` returned early unless `parent_approval_status === 'APPROVED'`, so
`parentOrgDisplayName` fell back to the literal copy string `'parent organization'` in exactly the
two states where a child needs to know who to chase. The screen reads "Affiliation revoked by
**parent organization**".

*Evidence:* `before/step11-revoked-child-dead-end-1280.png`.
*Fix:* fetch the name for any child that has a parent, regardless of status. **Fixed.**

### 4. Revoke fires immediately; the gentler Offboard beside it confirms. — confusing

On an approved affiliate the row carries two identically styled red buttons, "Offboard" and
"Revoke". Offboard opens a confirmation explaining what happens. Revoke posts on the first click,
with no dialog and no undo in the UI, and nothing on screen says how the two differ.

*Evidence:* `before/step6a-approved-row-actions-1280.png`,
`before/step6a-approved-row-actions-375.png`.
*Fix:* a confirmation for Revoke that names the organisation and states only what revoking is
verified to do — sever the affiliation — and points at Offboard for the stronger action. It
deliberately does **not** claim revoking stops them securing documents, because it does not.
**Fixed.**

### 5. Neither destructive confirmation names the organisation. — confusing

"Offboard this organization?" gives no name, and at 375 px the row it was launched from truncates
to "Fabrikam C…". The operator confirms a credit-moving, organisation-suspending action without
being able to read which organisation it applies to.

*Evidence:* `before/step7-offboard-dialog-375.png`.
*Fix:* interpolate the display name into both confirmation titles. **Fixed.**

### 6. Raw worker replies are shown to the operator verbatim. — confusing

Every action handler did `toast.error(data.error ?? FALLBACK)`. The worker's replies are a mix of
engineer-facing sentences and machine codes — `sub_org_limit_reached`, `cap_check_unavailable`,
`membership_lookup_unavailable`, `credit_allocation_unavailable` — so all of those could and did
reach the user interface. The capture shows the cap message; the codes are read straight out of
`services/worker/src/api/v1/orgSubOrgs.ts`.

*Evidence:* `before/step8-create-error-toast-1280.png`.
*Fix:* a code → copy map in `src/lib/copy.ts`; unrecognised replies fall back to the generic copy
and are logged to the console rather than displayed, so a new worker code surfaces to engineering
instead of to the customer. No worker change. **Fixed.**

### 7. The counts are wrong and mis-iconed, and omit the number that matters. — confusing

The header read "**1** affiliated organizations" — hardcoded plural — while two rows were listed
below it, because the count included only APPROVED. The pending count, which is the number an admin
opens this panel to act on, was not stated at all. The credits figure used the *people* icon
(`Users2`).

*Evidence:* `before/step4-suborg-panel-1280.png`.
*Fix:* singular/plural noun, a separate amber pending count, coin icon for credits. **Fixed.**

### 8. The create form sits above the list. — confusing

The four-field "create an affiliate" form was between the panel header and the rows, so the pending
request an admin came to approve was below a form they had no intention of filling in.

*Evidence:* `before/step4-suborg-panel-1280.png`, `before/step6a-approved-row-actions-375.png`
(at 375 px the first row starts below the fold, under the form).
*Fix:* list first; the form is a disclosure beneath it, and the empty state opens it inline.
**Fixed.**

### 9. The empty state explains nothing. — confusing

"No affiliated organizations yet." is the entire first-run experience. It does not say what an
affiliated organisation is, that another organisation can request one, or what the four fields below
will do. (A first-time admin cannot tell from "Affiliate admin email" that naming an address sends
that person an invitation.)

*Evidence:* `before/step10-empty-state-1280.png`.
*Fix:* an empty state that defines the concept, names both routes in, and offers the add control;
plus help text on the form stating that the named admin is emailed an invitation. **Fixed.**

### 10. At 375 px the organisation name truncates to about eight characters. — confusing

The row pinned its action buttons on the same line as the name, so "Contoso Legal" rendered as
"Contoso …" and "Fabrikam Compliance" as "Fabrikam C…", while the status chip beside them kept its
full width. The row identified the organisation worse than its own badge did.

*Evidence:* `before/step5a-pending-row-actions-375.png`,
`before/step6a-approved-row-actions-375.png`.
*Fix:* the row stacks below `sm`; the name wraps instead of truncating; status chip and domain move
under it; the action buttons share a full-width line. **Fixed.**

### 11. The affiliate's credit balance is an unlabelled number floated to the row edge. — confusing

"150 credits" appeared bottom-right of the credit controls with no label, and at 375 px it landed
under an unrelated button row, reading as a stray value rather than that organisation's balance.

*Evidence:* `before/step6a-approved-row-actions-375.png`.
*Fix:* label it ("Their balance: 150 credits") and place it above the controls that change it.
**Fixed.**

### 12. The offboard dialog styles the destructive action as the primary button. — cosmetic

"Offboard Organization" rendered as the bright cyan primary control and "Keep Active" as the quiet
one, so the dangerous option was the visually default one.

*Evidence:* `before/step7-offboard-dialog-1280.png`.
*Fix:* destructive red on the confirm action in both dialogs. **Fixed.**

### 13. The affiliate cap (`max_sub_orgs`) has no user interface at all. — confusing — DEFERRED

`POST /api/v1/org/sub-orgs/max` sets a per-organisation limit, the create endpoint enforces it
(`resolveSubOrgCap`), and breaching it is what produced the error in finding 6. Grepping `src/` for
`max_sub_orgs` returns only the generated `database.types.ts` — nothing reads or writes it from the
dashboard. An admin can hit a limit they cannot see or change.

*Deferred* because adding the control is new capability, not a findability fix, and it needs a
product decision first: whether an org admin may raise their own cap at all, or whether it is a
support-only lever. Finding 6's copy currently says "Contact support to raise it", which is the
conservative reading. Needs a Jira story of its own.

### 14. The page header reads "Directory", not the organisation name. — cosmetic — DEFERRED

Visible in every capture. Affects the whole org-profile page, not the sub-org flow, so it is out of
scope here.

---

## Naming — an open question for the CTO

The same concept has three names: the founder and the API say **sub-org** / `sub_orgs`, the database
says `parent_org_id`, and the user interface says **Affiliated Organization** / **Affiliate**. The
new tab is labelled **Affiliates** to match the vocabulary already on screen rather than introduce a
fourth term, and because four tabs share one row at 375 px. If the product decision is that
"Sub-organisations" is the customer-facing word, the rename is a one-line copy change in
`SUB_ORG_LABELS` plus the section title — but it should be done everywhere at once, not just on the
tab.

## What could not be verified in this session

- **No rig, no production check.** Supabase and the worker were stubbed in-browser, so this exercises
  the real components, router and copy against synthetic HTTP responses. It proves what the interface
  does with a given reply; it does not prove what production replies with.
- **No CI-suite e2e coverage for the sub-org flow.** None existed before, and adding one needs a real
  Supabase project with a seeded parent/child pair, which this session is not permitted to write to.
  `e2e/uat-suborg-ux.spec.ts` self-skips under the shared config for the reason documented in
  `e2e/agents.md`; it is a reproducible capture, not a CI gate. That gap is real and should be a
  follow-up story.
- **The worker's own behaviour is untouched and untested here** — no endpoint, payload or status code
  changed.
