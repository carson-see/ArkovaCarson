# agents.md — components/vault
_Last updated: 2026-03-12_

## What This Folder Contains
Vault-related components for the INDIVIDUAL user experience, including the VaultDashboard.

## Recent Changes
- 2026-03-11 SonarQube sprint: `VaultDashboard.tsx` — S6582 (optional chaining), S7772 (node: prefix), S1854 (dead assignments), S2933 (readonly). No behavioral changes.
- 2026-03-07 Code-review fix: `VaultDashboard.tsx` — surfaced `revokeError` from `useRevokeAnchor` with dismissible Alert for user feedback on revocation failures.
- 2026-03-07 P3-TS-02: `VaultDashboard.tsx` — replaced local `useState` privacy toggle with DB-backed `profile.is_public_profile` via `updateProfile()`. Toggle now persists to Supabase.
- 2026-03-07 P3-TS-01: `VaultDashboard.tsx` — replaced `useState<Record[]>([])` mock with `useAnchors()` hook for real Supabase data. Wired `handleRevokeRecord` to `useRevokeAnchor`. Removed `Math.random()` fingerprints and `console.log` stubs.

## Do / Don't Rules
- DO: Use `useAnchors()` for all anchor data — never local useState arrays
- DO: Read `is_public_profile` from `profile` object, persist via `updateProfile({ is_public_profile })` — never local state

## MVP Launch Gap Context
- **MVP-09 (Records Pagination + Search):** VaultDashboard will need pagination controls and search/filter bar when records list grows. Currently loads all records at once via `useAnchors()`. Story targets `RecordsList.tsx` and `useAnchors.ts` with 25-per-page pagination + URL params.

## Dependencies
- `@/hooks/useAnchors` — anchor data
- `@/hooks/useRevokeAnchor` — revocation via RPC
- `@/hooks/useAuth`, `@/hooks/useProfile` — auth, profile state, and profile updates
