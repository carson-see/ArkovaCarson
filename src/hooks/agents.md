# agents.md — hooks
_Last updated: 2026-05-05_

## What This Folder Contains

React hooks for data fetching and mutations against Supabase. Each hook encapsulates a single concern (auth, profile, anchors, revocation, export, etc.).

## Recent Changes

- 2026-05-05 SCRUM-1755: Created `useCanIssueCredential.ts` (+ 15 resolver tests) — gate hook for the Issue Credential UI surface. Pure `resolveIssueGate()` carries the logic; React wrapper pulls `organizations.verification_status` / `suspended` / `parent_org_id` / `parent_approval_status` and the parent-org row when present. Returns a discriminated `IssueGate` so UI surfaces can render the right gate-blocked banner copy. Replaces the prior implicit "ORG_ADMIN ⇒ may issue" assumption.
- 2026-04-26 SCRUM-1260 R1-6 /simplify carry-over: Extracted `useVisibilityPolling.ts` — page-visibility-aware polling with `(cb, intervalMs)` contract. Replaces three near-identical inline copies in `AnchorQueuePage`, `useTreasuryBalance`, `PipelineAdminPage`. `useTreasuryBalance.ts` also gained `Promise.all` parallelization for the worker + mempool legs (16s → ~8s worst case) plus equality guards on `setBalance` / `setFeeRates` / `setReceipts` so identical poll payloads don't churn the consumer tree.
- 2026-04-24 API-V2-02: `useApiKeys.ts` now defaults new keys to `read:search`, matching the v2 scope vocabulary and migration `0253_api_key_scope_defaults.sql`.
- 2026-03-16 UF-01: Created `useCredentialTemplate.ts` — fetches template by credential_type + org_id. Two modes: authenticated (direct Supabase query) and public (RPC via `get_public_template`). Exports `parseTemplateFields()` and `TemplateDisplayData`/`TemplateField` types.
- 2026-03-11 SonarQube sprint: `useAuth.ts` — S6582 (optional chaining), S7772 (node: prefix). `useCredentialTemplates.ts` — S6582 (optional chaining). No behavioral changes.
- 2026-03-07 Code-review fix: `useProfile.ts` — separated `updating` state from `loading` state in `updateProfile()`. Prevents RouteGuard full-page spinner flash when toggling profile fields.
- 2026-03-07 P3-TS-02: Updated `useProfile.ts` — expanded `updateProfile` type to include `is_public_profile` for privacy toggle persistence.
- 2026-03-07 P3-TS-01: Created `useAnchors.ts` — fetches anchors from Supabase, maps DB rows to `Record` UI interface. RLS handles tenant scoping automatically.
- 2026-03-07 P4-TS-03: Created `useAnchor.ts` — fetches a single anchor by ID. Used by RecordDetailPage for /records/:id route.

## Do / Don't Rules
- DO: Follow the `useProfile` pattern (useCallback for fetch, useEffect to trigger, return loading/error/data/refresh)
- DO: Separate `loading` (initial fetch) from `updating` (mutations) so RouteGuard only shows spinner during initial load, not during inline updates
- DO: Use `Database['public']['Tables'][table]['Row']` types from generated `database.types.ts`
- DON'T: Call real Stripe or Bitcoin APIs in hooks — use `IPaymentProvider` / `IAnchorPublisher` interfaces
- DON'T: Use `useState` arrays to mock data that should come from Supabase (Constitution: schema-first)

## MVP Launch Gap Context
- **MVP-02 (Toast Notifications):** Hooks (`useAnchors`, `useProfile`, `useOrganization`, etc.) need toast calls on success/error. Will use Sonner (`toast.success()`, `toast.error()`). Global `<Toaster />` goes in App.tsx.
- **MVP-09 (Records Pagination + Search):** `useAnchors.ts` needs pagination params (page, pageSize, search, status filter, sort) passed to Supabase `.range()` query.
- **MVP-12 (Dark Mode):** New `useTheme.ts` hook — localStorage persistence + system preference detection.

## Dependencies
- `@/lib/supabase` — the typed Supabase client
- `@/types/database.types` — auto-generated from `supabase gen types`
- `useAuth` — most hooks depend on the authenticated user
