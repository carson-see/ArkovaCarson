# P3 Vault & Dashboard — Story Documentation
_Last updated: 2026-03-10 | 3/3 stories COMPLETE_

## Group Overview

P3 Vault & Dashboard delivers the authenticated user experience: a real-data dashboard querying Supabase, a privacy toggle persisted to the database, and sidebar navigation with active route highlighting. This group replaces any mock data or placeholder UI with production-ready components wired to real Supabase queries.

Key deliverables:
- `DashboardPage` and `VaultDashboard` — stats grid, records list, privacy controls, all backed by `useAnchors()` real queries
- `is_public_profile` column (migration 0023) with toggle persisted via `useProfile().updateProfile()`
- `Sidebar` with `react-router-dom` `<Link>` components and `useLocation()` active highlighting

All P3 work builds on P1 (schema + RLS) and P2 (auth + routing). No new tables are introduced — only one column addition (`is_public_profile`) and UI wiring.

## Architecture Context

**Design Principle: No Mock Data.** Once a Supabase table exists, all UI components must query it via hooks. P3 replaces any `useState` arrays with `useAnchors()` (real Supabase query scoped by RLS). The dashboard renders exactly what the database contains for the authenticated user.

**Privacy Toggle Pattern:** The `is_public_profile` boolean is a user-controlled field. Unlike privileged fields (role, org_id), it is NOT protected by the `protect_privileged_profile_fields()` trigger, so users can toggle it directly from the client via `updateProfile()`.

---

## Stories

---

### P3-TS-01: Dashboard + VaultDashboard (Real Supabase Queries)

**Status:** COMPLETE
**Dependencies:** P1-TS-02 (anchors table), P1-TS-04 (RLS), P2-TS-05 (useProfile)
**Blocked by:** None (~~CRIT-1~~ resolved 2026-03-10, commit a38b485)

#### What This Story Delivers

Replaces placeholder dashboard content with real data from Supabase. The `DashboardPage` and `VaultDashboard` components use the `useAnchors()` hook to query the `anchors` table (RLS-scoped), compute stats (total, secured, pending counts), and render records via `RecordsList`. No mock arrays or `useState` stand-ins remain.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Page | `src/pages/DashboardPage.tsx` | 260 | Main authenticated page — stats grid, privacy toggle, records list, account info |
| Component | `src/components/vault/VaultDashboard.tsx` | 273 | Alternative vault view with two-column layout |
| Hook | `src/hooks/useAnchors.ts` | 89 | Fetches all user anchors from Supabase (RLS-scoped) |
| Component | `src/components/records/RecordsList.tsx` | 209 | Record list with status badges, fingerprints, dropdown actions |
| Barrel | `src/components/vault/index.ts` | 1 | Re-exports VaultDashboard |

#### Database Changes

None (queries existing `anchors` table from P1-TS-02).

#### Hook Details

`useAnchors()` returns `{ records, loading, error, refreshAnchors }`:
- Query: `supabase.from('anchors').select('*').is('deleted_at', null).order('created_at', { ascending: false })`
- RLS handles tenant scoping — INDIVIDUAL users see own anchors, ORG_ADMIN see org-wide
- Maps DB rows to `Record` interface: `id`, `filename`, `fingerprint`, `status`, `createdAt`, `securedAt`, `fileSize`, `credentialType`

#### Security Considerations

- No client-side filtering — RLS enforces data isolation at the database layer
- Stats computed from query results (not separate privileged queries)
- No raw IDs or internal fields exposed in UI — `public_id` used for external references

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated unit tests for DashboardPage, VaultDashboard, or useAnchors |

**Untested areas:** Dashboard rendering, stats computation, empty state display. Validated indirectly by E2E tests and manual click-through with seed data.

#### Acceptance Criteria

- [x] DashboardPage queries `anchors` via `useAnchors()` — no mock data
- [x] Stats grid shows Total, Secured, Pending counts from real data
- [x] RecordsList renders all anchors with status badges and fingerprints
- [x] Loading state shown while fetching
- [x] Empty state shown when no records exist
- [x] Record actions (View, Download Proof, Revoke) wired to callbacks

#### Known Issues

| Bug | Impact |
|-----|--------|
| ~~[CRIT-1](../bugs/bug_log.md#crit-1-securedocumentdialog-fakes-anchor-creation)~~ | RESOLVED 2026-03-10 (commit a38b485). SecureDocumentDialog now uses real Supabase insert. Dashboard data display and creation path both working. |

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as `admin_demo@arkova.local` / `demo_password_123`
3. Dashboard should show stats computed from seed data anchors
4. Records list should show anchor rows with status badges
5. Click any record to navigate to `/records/:id`
6. Verify: no console errors, no mock data warnings

---

### P3-TS-02: Privacy Toggle (is_public_profile)

**Status:** COMPLETE
**Dependencies:** P1-TS-04 (RLS on profiles), P2-TS-05 (useProfile hook)
**Blocked by:** None

#### What This Story Delivers

Adds a boolean `is_public_profile` column to the `profiles` table (default `false`) and wires a toggle switch in the dashboard that persists the setting to the database. When enabled, the user's profile is discoverable in public contexts (e.g., verification pages). The toggle uses `useProfile().updateProfile()` which logs an audit event on every change.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Migration | `supabase/migrations/0023_is_public_profile.sql` | ~10 | Add `is_public_profile boolean NOT NULL DEFAULT false` to profiles |
| Hook | `src/hooks/useProfile.ts` | 184 | `updateProfile()` accepts `is_public_profile` field, logs audit event |
| Page | `src/pages/DashboardPage.tsx` | 260 | Privacy toggle card with Eye/EyeOff icon feedback |
| Component | `src/components/vault/VaultDashboard.tsx` | 273 | Privacy Settings card with toggle |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `is_public_profile` | Column | 0023 | Boolean, NOT NULL, DEFAULT false. Added to `profiles` table. |

#### Security Considerations

- **Not a privileged field:** `is_public_profile` is intentionally excluded from `protect_privileged_profile_fields()` trigger — users should be able to toggle it directly
- **RLS scoped:** Users can only update their own profile (`auth.uid() = id`)
- **Audit trail:** Every toggle logs an audit event via `logAuditEvent()` in `updateProfile()`
- **Default false:** New users are private by default — opt-in disclosure

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated test for privacy toggle |

**Untested areas:** Toggle persistence, audit event logging on toggle, default value on new profile creation.

#### Acceptance Criteria

- [x] `is_public_profile` column added to profiles (migration 0023)
- [x] Column defaults to `false` for new and existing users
- [x] Toggle switch in dashboard persists value to DB via `updateProfile()`
- [x] Audit event logged on every toggle change
- [x] Visual feedback (Eye/EyeOff icon) reflects current state
- [x] RLS allows user to update their own `is_public_profile`

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as any seed user
3. Find the Privacy toggle card on the dashboard
4. Toggle it ON — observe icon change
5. Query DB: `SELECT is_public_profile FROM profiles WHERE email = '<user>';` — expect `true`
6. Toggle it OFF — query again — expect `false`
7. Check audit trail: `SELECT * FROM audit_events WHERE event_type LIKE '%PROFILE%' ORDER BY created_at DESC LIMIT 1;`

---

### P3-TS-03: Sidebar Navigation

**Status:** COMPLETE
**Dependencies:** P2-TS-03 (React Router + named routes)
**Blocked by:** None

#### What This Story Delivers

A professional sidebar with collapsible state, route-aware active highlighting, and tooltip support. Navigation items use `react-router-dom` `<Link>` components (not `href="#"` dead links). Active state is computed by matching `useLocation().pathname` against each item's `to` prop.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/layout/Sidebar.tsx` | 169 | Sidebar with collapse toggle, nav items, active highlighting |
| Component | `src/components/layout/AppShell.tsx` | 55 | Layout wrapper: Sidebar + Header + content area |
| Constants | `src/lib/routes.ts` | — | `ROUTES` object with named route constants |

#### Database Changes

None (purely UI component).

#### Component Details

**Sidebar navigation items:**
- Main: Dashboard, My Records, Organization
- Secondary: Settings, Help

**Active highlighting logic:**
- `useLocation()` provides current pathname
- Each nav item compared via exact match or `startsWith` for nested routes
- Active item gets `sidebar-accent` background + `sidebar-accent-foreground` text

**Collapse behavior:**
- Toggle button at bottom switches width: `w-64` (expanded) to `w-16` (collapsed)
- Collapsed state shows icon-only with tooltip on hover
- Logo shrinks to icon-only in collapsed state

#### Security Considerations

None (pure UI rendering with no data access).

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated unit tests for Sidebar or AppShell |

**Untested areas:** Active highlighting logic, collapse state persistence, tooltip rendering.

#### Acceptance Criteria

- [x] Sidebar renders with main and secondary navigation sections
- [x] All nav items use `<Link>` from react-router-dom (no `href="#"`)
- [x] Active route highlighted via `useLocation()` pathname matching
- [x] Collapse toggle switches between expanded (w-64) and collapsed (w-16)
- [x] Tooltip shown on hover in collapsed state
- [x] Logo displayed (full wordmark expanded, icon-only collapsed)
- [x] AppShell wraps Sidebar + Header + scrollable content area

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as any seed user
3. Verify sidebar shows Dashboard, My Records, Organization, Settings, Help
4. Click each nav item — verify URL changes and active highlighting updates
5. Click collapse toggle — verify sidebar shrinks to icon-only
6. Hover over collapsed icons — verify tooltips appear
7. Verify no `href="#"` in rendered HTML (inspect element)

---

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| `useAnchors()` replaces `useState` mock arrays | Schema-first rule: once a table exists, query it |
| `is_public_profile` not in privileged fields trigger | Users should control their own privacy setting |
| Default `false` for `is_public_profile` | Privacy by default — opt-in disclosure |
| `useLocation()` for active nav highlighting | Standard React Router pattern, no custom state needed |
| Collapsible sidebar with tooltip | Desktop UX — users can reclaim screen space |

## Migration Inventory

| Migration | Story | Description |
|-----------|-------|-------------|
| 0023 | P3-TS-02 | `is_public_profile` boolean column on profiles |

## Related Documentation

- [02_data_model.md](../confluence/02_data_model.md) — Profiles table schema
- [03_security_rls.md](../confluence/03_security_rls.md) — RLS policies on profiles
- [01_p1_bedrock.md](./01_p1_bedrock.md) — Foundation that P3 builds on
- [02_p2_identity.md](./02_p2_identity.md) — Auth + routing that P3 depends on

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial P3 story documentation created (Session 2 of 3). |
| 2026-03-11 ~12:30 AM EST | Documentation audit: Updated CRIT-1 reference as resolved (commit a38b485). |
