# agents.md — pages
_Last updated: 2026-04-24_

## What This Folder Contains
Top-level page components rendered by react-router-dom routes. Each page composes layout (AppShell) with domain-specific hooks and components.

## Recent Changes
- 2026-04-24 SCRUM-1102: `RulesPage.tsx` adds org-admin "Run now" and execution history actions for each rule. New user-visible strings live in `RULES_PAGE_COPY` (`src/lib/copy.ts`). Pattern: rule actions that enqueue work should show a queued toast with a history action rather than blocking for worker completion.
- 2026-04-24 CONNECTORS-V2 ([SCRUM-1100](https://arkova.atlassian.net/browse/SCRUM-1100)): `RuleBuilderPage.tsx` — workspace file rules can now collect multiple Google Drive folder bindings into `trigger_config.drive_folders[]`. UI strings remain centralized in `src/lib/copy.ts`; frontend validation lives in `src/lib/ruleSchemas.ts` and the worker schema/evaluator remain authoritative.
- 2026-04-23 CIBA-HARDEN-04 ([SCRUM-1117](https://arkova.atlassian.net/browse/SCRUM-1117)): `RuleBuilderPage.tsx` — extracted every user-visible string into `src/lib/copy.ts` (`RULE_TRIGGER_COPY`, `RULE_ACTION_COPY`, `RULE_WIZARD_LABELS`); added HMAC-handle field for the `FORWARD_TO_URL` action (worker schema requires `hmac_secret_handle: sm:...`); wired `nextStep()` + `handleSave()` to the new `src/lib/ruleSchemas.ts` frontend shadow so invalid cron / missing HMAC handle / empty NOTIFY channels fail client-side instead of POST-then-400. Pattern: any wizard POSTing to a Zod-validated worker endpoint should shadow the schema in `src/lib/` and pre-validate before advance.
- 2026-04-21 Top-10 UAT sprint: `ComplianceScorecardPage.tsx` + `ApiKeySettingsPage.tsx` — both pages are org-scoped at the worker API layer but were rendering raw HTTP-403 / engineering-copy errors for individual-tier users (no `org_id`). Now detect `!profile.org_id` and short-circuit to the new shared `<OrgRequiredCard>` component (`src/components/shared/OrgRequiredCard.tsx`). For the API Keys page, the `useApiKeys` + `useApiUsage` hooks also now honor an `{ enabled }` option so individuals never fire the 403-bound worker calls at all. Pattern: any org-scoped page should mirror this.
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
