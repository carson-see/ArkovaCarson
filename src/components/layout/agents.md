# agents.md — components/layout
_Last updated: 2026-07-21_
_Last updated: 2026-07-28_
_Last updated: 2026-08-03_

## What This Folder Contains
App-level layout components: shell, sidebar, header, breadcrumbs, error boundaries, and branding.

## Key Files
- `AppShell.tsx` — Main layout wrapper for authenticated pages: sidebar + header + content area, responsive hamburger on mobile
- `Sidebar.tsx` — Navigation sidebar: max 5 primary items (Dashboard, Documents, Organization, Search, Settings), an Account section (My Records, My Credentials, Billing, API Keys — personal/user-scoped destinations visible to all authenticated users incl. INDIVIDUAL), and an admin section behind a collapsible toggle. SCRUM-2915 ([PI05-CE06]): `My Credentials` (`/my-credentials`, the SCRUM-1598 recipient inbox) was route-only/unreachable and is now surfaced in the Account section; it is EXCLUDED from the Documents active-state block so only its own entry highlights. SCRUM-2940 (2026-08-03, founder escalation): `My Records` (`/records`, the SCRUM-2940 folders UI host — see `src/pages/agents.md`) had the same gap and got the same fix — Account-section entry + EXCLUDED from the Documents active-state block. _(Bullet restored/corrected 2026-07-28 — the prior short description was stale, dropped by the union-merge-driver incident; see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`.)_

## 2026-08-03 SCRUM-2940 — /records had no sidebar link (founder: "finish the folders")

The folders feature (create/rename/delete folder, move a record into one — see
`src/components/folders/agents.md`) has lived entirely on `MyRecordsPage.tsx`
at `ROUTES.RECORDS` (`/records`) since PR #1657's UI follow-up, but `Sidebar.tsx`
never linked to it — `ROUTES.RECORDS` appeared only inside the Documents
active-state check, never as a nav target. `/documents` (the linked item) has
its own separate, simpler "My Records" tab (`DocumentsPage.tsx`) with zero
folder UI, so the two pages are NOT the same surface; porting the folder UI
into `DocumentsPage`'s tab layout was judged out of scope for a same-day fix
(no sidebar-shaped slot in that tab's layout, new state/dialogs to wire, no
existing tests to lean on) and a plain nav link is the smaller, safer change.

Fix: added `{ label: NAV_LABELS.MY_RECORDS, icon: FolderClosed, to:
ROUTES.RECORDS }` to `accountNavItems` (first entry, ahead of My Credentials)
— `/records` is gated identically to `/documents` (`RouteGuard
allow={MAIN_APP_DESTINATIONS}`, no role restriction), so it is visible to
every authenticated user, matching the Account-section convention. Also
removed `/records` from the Documents `isNavActive` special case (it was
matching both `/records` and `/records/:id`) so the two items don't
double-highlight — same fix shape as SCRUM-2915's `/my-credentials` exclusion
above. `NAV_LABELS.MY_RECORDS` ('My Records') already existed in `copy.ts`
(used by `Header.tsx`'s page title and `Breadcrumbs.tsx`) and was reused
as-is — no new copy string, so `lint:copy` needed no changes. Icon is
`FolderClosed`, matching the icon `MoveToFolderDialog.tsx` already uses for
the same feature. Tests: `Sidebar.test.tsx` SCRUM-2940 block (6 cases — item
renders + href, visible to INDIVIDUAL, active-highlight on `/records` and on
the `/records/:id` sub-route, Documents does NOT double-highlight on
`/records`, Documents still highlights on its own `/attestations` route).
- `Header.tsx` — Top header bar with user menu
- `Breadcrumbs.tsx` — Route-aware breadcrumb navigation
- `ArkovaLogo.tsx` — Arkova logo and icon components
- `AuthLayout.tsx` — Layout wrapper for unauthenticated pages (login, signup)
- `ErrorBoundary.tsx` — React class-based error boundary with recovery UI
- `RouteErrorBoundary.tsx` — Route-level error boundary for react-router. SCRUM-2246: when the caught error is a chunk-load failure (`isChunkLoadError` from `@/lib/lazyWithRetry`), renders a dedicated "A new version is available / Refresh" affordance instead of the generic retry-in-place UI — the recovery for a stale chunk is a full reload, not a re-render.
- `NotificationBell.tsx` — Notification indicator in the header
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useAuditorMode` — auditor mode state for AppShell/Sidebar
- `@/hooks/useProfile` — profile for sidebar role checks
- `@/hooks/useTheme` — dark/light/system theme toggle
- `@/lib/routes` (ROUTES, destinationToRoute) — named routes
- `@/lib/copy` (NAV_LABELS, NAV_POLISH_LABELS) — sidebar/header strings

## Do / Don't Rules
- DO: Keep primary nav to max 5 items; overflow goes to Header user dropdown
- DO: Use `ArkovaIcon`/`ArkovaLogo` from this folder for all branding

## 2026-07-28 QUEUE-01 / SCRUM-2894 (L2-A1, founder P0)

`Sidebar.tsx` — added "Pending Documents" (`SECURE_QUEUE_LABELS.PAGE_TITLE`, `Clock` icon, `ROUTES.SECURE_QUEUE`) to the Account section, alongside My Credentials / Billing / API Keys. Personal destination, visible to every authenticated user. Primary nav stays at its existing count (unchanged) — the Account section has no hard cap.

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

Breadcrumb label for /settings/credential-templates now "Document Templates" (via copy.ts NAV_POLISH_LABELS). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
