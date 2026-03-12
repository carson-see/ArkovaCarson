# agents.md — hooks
_Last updated: 2026-03-12_

## What This Folder Contains
React hooks for data fetching and mutations against Supabase. Each hook encapsulates a single concern (auth, profile, anchors, revocation, export, etc.).

## Recent Changes
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
