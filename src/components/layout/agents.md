# agents.md — components/layout
_Last updated: 2026-05-16_

## What This Folder Contains
App-level layout components: shell, sidebar, header, breadcrumbs, error boundaries, and branding.

## Key Files
- `AppShell.tsx` — Main layout wrapper for authenticated pages: sidebar + header + content area, responsive hamburger on mobile
- `Sidebar.tsx` — Navigation sidebar: max 5 primary items (Dashboard, Documents, Organization, Search, Settings), admin section behind collapsible toggle
- `Header.tsx` — Top header bar with user menu
- `Breadcrumbs.tsx` — Route-aware breadcrumb navigation
- `ArkovaLogo.tsx` — Arkova logo and icon components
- `AuthLayout.tsx` — Layout wrapper for unauthenticated pages (login, signup)
- `ErrorBoundary.tsx` — React class-based error boundary with recovery UI
- `RouteErrorBoundary.tsx` — Route-level error boundary for react-router
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
