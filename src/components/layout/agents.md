# agents.md — components/layout
_Last updated: 2026-05-16_

## What This Folder Contains
App-level layout components: shell, sidebar, header, breadcrumbs, error boundaries, and branding.

## Key Files
- `AppShell.tsx` — Main layout wrapper for authenticated pages: sidebar + header + content area, responsive hamburger on mobile
- `Sidebar.tsx` — Navigation sidebar: max 5 primary items (Dashboard, Documents, Organization, Search, Settings), an Account section (My Credentials, Billing, API Keys — personal/user-scoped destinations visible to all authenticated users incl. INDIVIDUAL), and an admin section behind a collapsible toggle. SCRUM-2915 ([PI05-CE06]): `My Credentials` (`/my-credentials`, the SCRUM-1598 recipient inbox) was route-only/unreachable and is now surfaced in the Account section; it is EXCLUDED from the Documents active-state block so only its own entry highlights. _(Bullet restored/corrected 2026-07-28 — the prior short description was stale, dropped by the union-merge-driver incident; see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`.)_
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

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

Breadcrumb label for /settings/credential-templates now "Document Templates" (via copy.ts NAV_POLISH_LABELS). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
