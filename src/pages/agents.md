# agents.md — pages
_Last updated: 2026-03-12_

## What This Folder Contains
Top-level page components rendered by react-router-dom routes. Each page composes layout (AppShell) with domain-specific hooks and components.

## Recent Changes
- 2026-03-11 SonarQube sprint: `MyRecordsPage.tsx`, `OrganizationPage.tsx`, `SettingsPage.tsx` — S3358 (nested ternary → if/else), S6582 (optional chaining). No behavioral changes.
- 2026-03-07 Code-review fixes: `DashboardPage.tsx` — surfaced `revokeError` from `useRevokeAnchor` with dismissible Alert; used `recordDetailPath()` instead of hardcoded path; corrected docstring.
- 2026-03-07 P3-TS-01: `DashboardPage.tsx` — replaced `useState<Record[]>([])` mock with `useAnchors()` hook for real Supabase data. Wired `handleRevokeRecord` to `useRevokeAnchor`. Removed `Math.random()` fingerprints and `console.log` stubs.
- 2026-03-07 P4-TS-03: Created `RecordDetailPage.tsx` — extracts `:id` from URL params, uses `useAnchor` hook, renders `AssetDetailView` with real Supabase data. Wired into App.tsx route.

## Do / Don't Rules
- DO: Use hooks from `@/hooks/` for all data fetching — never `useState` for DB-backed data
- DO: Pass `loading` state from hooks to child components (RecordsList, StatCard)
- DON'T: Create mock records with `Math.random()` or `Date.now()` IDs
- DON'T: Use `console.log` as a placeholder for actions — use no-op functions or wire to real hooks

## MVP Launch Gap Context
- **MVP-03 (Legal Pages):** New `PrivacyPage.tsx`, `TermsPage.tsx`, `ContactPage.tsx` — public routes, no auth required. Add to `routes.ts` and `App.tsx`.
- **MVP-05 (Error Boundary + 404):** New `NotFoundPage.tsx` at catch-all `*` route. ErrorBoundary wraps App in `App.tsx`.
- **MVP-08 (Onboarding Stepper):** Visual progress indicator integrated into existing onboarding pages.
- **MVP-11 (Stripe Plan Change):** Settings page needs plan management UI (upgrade/downgrade/cancel).

## Dependencies
- `@/hooks/useAnchors` — anchor data for dashboard and vault
- `@/hooks/useAnchor` — single anchor data for record detail page
- `@/hooks/useAuth`, `@/hooks/useProfile` — auth and profile state
- `@/components/layout/AppShell` — page shell with sidebar
- `@/lib/routes` — named route constants
