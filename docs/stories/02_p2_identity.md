# P2 Identity & Access — Story Documentation
_Last updated: 2026-03-10 | 5/5 stories COMPLETE_

## Group Overview

P2 Identity establishes the authentication layer, profile management, routing infrastructure, and onboarding flow. This includes:

- React Router with named routes and nested guards
- Supabase Auth integration (email/password + Google OAuth scaffold)
- Role-based routing (INDIVIDUAL vs ORG_ADMIN destinations)
- Onboarding flow (role selection, org creation, manual review gate)
- Profile and organization CRUD hooks with audit logging

All P2 work depends on P1 Bedrock (tables, RLS, validators). The routing structure in `App.tsx` is the backbone that P3-P7 features plug into.

## Architecture Context

**Routing Model: Guard + Destination.** The system uses two nested guards:
1. `AuthGuard` — redirects to `/login` if not authenticated
2. `RouteGuard` — computes the user's "destination" based on profile state, redirects if they're on the wrong page

The `useProfile` hook computes the destination:
```
No user          → /auth
No role          → /onboarding/role
ORG_ADMIN no org → /onboarding/org
Manual review    → /review-pending
INDIVIDUAL       → /vault
ORG_ADMIN + org  → /dashboard
```

**Onboarding is transactional.** The `update_profile_onboarding` RPC (migration 0015) atomically sets the role + creates the organization (for ORG_ADMIN). It's idempotent — calling twice returns success with `already_set = true`.

---

## Stories

---

### P2-TS-03: React Router + Named Routes

**Status:** COMPLETE
**Dependencies:** P1-TS-04 (RLS for profile queries)
**Blocked by:** None (~~CRIT-4~~ resolved 2026-03-10, commit a38b485)

#### What This Story Delivers

Establishes the application's routing structure using react-router-dom v6 with BrowserRouter. All routes are defined in `App.tsx` with named constants from `routes.ts`. Public routes (login, signup, verify) are accessible without auth. Protected routes require AuthGuard + RouteGuard nesting.

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Router | `src/App.tsx` (235 lines) | BrowserRouter + all Route definitions + guard nesting |
| Constants | `src/lib/routes.ts` (65 lines) | ROUTES object, RouteDestination type, helper functions |

#### Database Changes

None (routing is frontend-only).

#### Security Considerations

- Public routes (`/login`, `/signup`, `/verify/:publicId`) have no auth requirement — intentional for public verification
- All app routes wrapped in `AuthGuard` → unauthenticated users redirected to `/login`
- `RouteGuard` prevents users from accessing pages they shouldn't (e.g., incomplete onboarding users can't reach dashboard)

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `e2e/route-guards.spec.ts` (105 lines) | E2E | Unauthenticated redirect to /auth, role-based routing, mid-onboarding redirect |
| `e2e/auth.spec.ts` (121 lines) | E2E | Login/signup form visibility, navigation between auth pages |

**Untested areas:** No unit test for `routes.ts` helper functions (`destinationToRoute`, `verifyPath`, `recordDetailPath`).

#### Route Table

| Path | Component | Guards | Notes |
|------|-----------|--------|-------|
| `/login` | LoginPage | PublicOnly | |
| `/signup` | SignUpPage | PublicOnly | |
| `/verify/:publicId` | PublicVerifyPage | None | Public access |
| `/auth/callback` | AuthCallbackPage | None | OAuth redirect target |
| `/onboarding/role` | OnboardingRolePage | AuthGuard + RouteGuard | ~~CRIT-4~~ FIXED — RoleSelector wired |
| `/onboarding/org` | OnboardingOrgPage | AuthGuard + RouteGuard | ~~CRIT-4~~ FIXED — OrgOnboardingForm wired |
| `/review-pending` | ReviewPendingPage | AuthGuard + RouteGuard | ~~CRIT-4~~ FIXED — ManualReviewGate wired |
| `/dashboard` | DashboardPage | AuthGuard + RouteGuard | ORG_ADMIN home |
| `/vault` | VaultPage | AuthGuard + RouteGuard | INDIVIDUAL home |
| `/records` | MyRecordsPage | AuthGuard + RouteGuard | |
| `/records/:id` | RecordDetailPage | AuthGuard + RouteGuard | |
| `/organization` | OrganizationPage | AuthGuard + RouteGuard | |
| `/settings` | SettingsPage | AuthGuard + RouteGuard | |
| `/settings/webhooks` | WebhookSettingsPage | AuthGuard + RouteGuard | |
| `/settings/credential-templates` | CredentialTemplatesPage | AuthGuard + RouteGuard | |
| `/help` | HelpPage | AuthGuard + RouteGuard | |

#### Acceptance Criteria

- [x] BrowserRouter wraps all routes
- [x] Named route constants in routes.ts (ROUTES object)
- [x] RouteDestination type for guard computation
- [x] Public routes accessible without auth
- [x] Protected routes require AuthGuard
- [x] Helper functions for dynamic paths (verifyPath, recordDetailPath)

#### Known Issues

| Bug | Impact |
|-----|--------|
| ~~[CRIT-4](../bugs/bug_log.md#crit-4-onboarding-routes-are-placeholders)~~ | RESOLVED 2026-03-10 (commit a38b485). OnboardingRolePage, OnboardingOrgPage, ReviewPendingPage created and wired into App.tsx. |

#### How to Verify (Manual)

1. Run: `npm run dev`
2. Open `localhost:5173` — should redirect to `/login`
3. Navigate to `/verify/test-id` — should show public verify page (no auth required)
4. Navigate to `/dashboard` — should redirect to `/login` (not authenticated)
5. Login as `admin@umich-demo.arkova.io` / `Demo1234!` — should land on `/dashboard`
6. Navigate to `/settings` — should render SettingsPage

---

### P2-TS-04: AuthGuard + RouteGuard

**Status:** COMPLETE
**Dependencies:** P2-TS-03 (routes to guard)
**Blocked by:** None (~~CRIT-4~~ resolved 2026-03-10, commit a38b485)

#### What This Story Delivers

Two guard components that enforce authentication and role-based access:
- **AuthGuard** checks if a user is authenticated (has a Supabase session). If not, redirects to `/login` preserving the original location for post-login redirect.
- **RouteGuard** computes the user's correct destination based on profile state and redirects if they're on the wrong page. Uses the `useProfile().destination` computed value.

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Component | `src/components/auth/AuthGuard.tsx` (42 lines) | Auth check → redirect to /login or render children |
| Component | `src/components/auth/RouteGuard.tsx` (68 lines) | Destination check → redirect or render children |
| Hook | `src/hooks/useAuth.ts` (142 lines) | Provides `user` and `loading` state for AuthGuard |
| Hook | `src/hooks/useProfile.ts` (185 lines) | Provides `destination` computed value for RouteGuard |

#### Database Changes

None (guards are frontend-only, but depend on profile data from P1 tables).

#### Security Considerations

- **AuthGuard** prevents unauthenticated access to all app routes
- **RouteGuard** prevents users from skipping onboarding (e.g., accessing dashboard before setting role)
- Guards are nested: AuthGuard runs first (has session?), then RouteGuard (correct destination?)
- Location state preserved for post-login redirect (UX pattern)
- Loading states prevent flash-of-wrong-content

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `e2e/route-guards.spec.ts` (105 lines) | E2E | Unauthenticated redirect, role-based routing, mid-onboarding blocking |
| `e2e/identity.spec.ts` (113 lines) | E2E | Privileged field protection, manual review gate blocking |

**Untested areas:** No unit tests for AuthGuard or RouteGuard components in isolation.

#### Acceptance Criteria

- [x] AuthGuard redirects unauthenticated users to /login
- [x] AuthGuard preserves original location for post-login redirect
- [x] AuthGuard shows loading spinner during auth initialization
- [x] RouteGuard computes destination from useProfile()
- [x] RouteGuard redirects if current route not in `allow` list
- [x] Guards are nestable (AuthGuard wraps RouteGuard)

#### Known Issues

| Bug | Impact |
|-----|--------|
| ~~[CRIT-4](../bugs/bug_log.md#crit-4-onboarding-routes-are-placeholders)~~ | RESOLVED 2026-03-10 (commit a38b485). Onboarding routes now render actual components. RouteGuard + route destinations both work correctly. |

#### How to Verify (Manual)

1. Run: `npm run dev`
2. Open browser devtools Network tab
3. Navigate to `/dashboard` while logged out — observe 302 redirect to `/login`
4. Login as `admin@umich-demo.arkova.io` / `Demo1234!`
5. Navigate to `/vault` — if user is ORG_ADMIN, RouteGuard should redirect to `/dashboard`
6. Open new incognito window, navigate to `/settings` — should redirect to `/login`

---

### P2-TS-05: useProfile Hook + DB Persistence

**Status:** COMPLETE
**Dependencies:** P1-TS-02 (profiles table), P1-TS-04 (RLS for SELECT/UPDATE)
**Blocked by:** None

#### What This Story Delivers

The `useProfile` hook provides profile state management with real Supabase persistence. It fetches the user's profile on mount, computes the routing destination, and provides an `updateProfile()` method that writes changes back to the database with audit logging.

This hook is the central source of truth for "who is this user and where should they be?" — every RouteGuard decision flows through `useProfile().destination`.

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Hook | `src/hooks/useProfile.ts` (185 lines) | Profile fetch, destination computation, update with audit log |
| Page | `src/pages/SettingsPage.tsx` (279 lines) | Profile editing UI (full_name, is_public_profile) |

#### Database Changes

None (uses profiles table from P1-TS-02 and RLS from P1-TS-04).

#### Security Considerations

- **RLS enforced:** `users_select_own` policy means the hook can only fetch the authenticated user's profile
- **Profile update:** Only editable fields (full_name, avatar_url, is_public_profile) are sent. Privileged fields (role, org_id, manual_review) are protected by the `protect_privileged_profile_fields()` trigger.
- **Audit logging:** Every profile update logs a `PROFILE_UPDATED` event with the changed field names.

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `e2e/identity.spec.ts` (113 lines) | E2E | Role field not editable, org_id not exposed, privileged field protection |

**Untested areas:** No unit test for `useProfile.ts`. The hook's destination computation logic is critical and should have dedicated tests.

#### Acceptance Criteria

- [x] Profile fetched from Supabase on mount
- [x] Destination computed based on role, org_id, requires_manual_review
- [x] updateProfile() writes to database with validation
- [x] Audit event logged on profile update
- [x] refreshProfile() re-fetches without full loading state
- [x] Error handling for fetch and update failures

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as `individual@demo.arkova.io` / `Demo1234!`
3. Navigate to Settings
4. Change your full name, click Save
5. Observe "Saved" confirmation message
6. Refresh page — name persists (DB persistence confirmed)
7. Query: `SELECT * FROM audit_events WHERE event_type LIKE '%PROFILE%' ORDER BY created_at DESC LIMIT 1;`
8. Verify: audit event exists with details mentioning the changed field

---

### P2-TS-06: useOrganization Hook + OrgSettingsPage

**Status:** COMPLETE
**Dependencies:** P1-TS-02 (organizations table), P1-TS-04 (RLS for org access)
**Blocked by:** None

#### What This Story Delivers

The `useOrganization` hook provides organization state management for ORG_ADMIN users. It fetches the organization record, provides `updateOrganization()` for editing display_name and domain, and logs audit events on changes. The OrgSettingsPage wires this into a settings UI.

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Hook | `src/hooks/useOrganization.ts` (116 lines) | Org fetch, update with validation, audit logging |
| Page | `src/pages/OrgSettingsPage.tsx` | Org settings UI (display_name, domain) |

#### Database Changes

None (uses organizations table from P1-TS-02 and RLS from P1-TS-04).

#### Security Considerations

- **RLS enforced:** `organizations_select_own` policy: user can only read their own org.
- **RLS enforced:** `organizations_update_admin` policy: only ORG_ADMIN can update their org.
- **Audit logging:** Every org update logs an `ORG_UPDATED` event.

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `e2e/identity.spec.ts` (113 lines) | E2E | Org scoping (user sees only their org) |

**Untested areas:** No unit test for `useOrganization.ts`. No specific E2E test for org settings update flow.

#### Acceptance Criteria

- [x] Organization fetched by org_id from profiles
- [x] updateOrganization() validates and persists changes
- [x] Audit event logged on org update
- [x] RLS prevents cross-org access
- [x] Only ORG_ADMIN role can update organization
- [x] Null org_id returns null organization (INDIVIDUAL users)

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as `admin@umich-demo.arkova.io` / `Demo1234!`
3. Navigate to Organization settings
4. Change the display name, save
5. Refresh — change persists
6. Login as `individual@demo.arkova.io` — should NOT see org settings

---

### P2-TS-0X: Auth Forms + Onboarding Components

**Status:** COMPLETE
**Dependencies:** P2-TS-03 (routes), P2-TS-05 (useProfile for auth state)
**Blocked by:** None (~~CRIT-4~~ resolved 2026-03-10, commit a38b485)

#### What This Story Delivers

All authentication and onboarding UI components:
- **LoginForm** — email/password + Google OAuth button
- **SignUpForm** — registration with email confirmation flow
- **RoleSelector** — one-time role selection (INDIVIDUAL vs ORG_ADMIN)
- **OrgOnboardingForm** — organization details (legal name, display name, domain)
- **ManualReviewGate** — blocking screen for flagged accounts
- **Page wrappers** — LoginPage, SignUpPage, SettingsPage (thin wrappers in `src/pages/`)

The `useOnboarding` hook calls the `update_profile_onboarding` RPC for transactional role + org creation.

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Component | `src/components/auth/LoginForm.tsx` (150 lines) | Email/password login + Google OAuth |
| Component | `src/components/auth/SignUpForm.tsx` (188 lines) | Registration + email confirmation |
| Component | `src/components/onboarding/RoleSelector.tsx` (148 lines) | Role selection cards (INDIVIDUAL / ORG_ADMIN) |
| Component | `src/components/onboarding/OrgOnboardingForm.tsx` (156 lines) | Org creation form (legal name, display name, domain) |
| Component | `src/components/onboarding/ManualReviewGate.tsx` (80 lines) | Account review blocking screen |
| Hook | `src/hooks/useAuth.ts` (142 lines) | signIn, signUp, signInWithGoogle, signOut |
| Hook | `src/hooks/useOnboarding.ts` (126 lines) | setRole(), createOrg() via RPC |
| Migration | `supabase/migrations/0015_onboarding_function.sql` (152 lines) | update_profile_onboarding() SECURITY DEFINER function |
| Page | `src/pages/LoginPage.tsx` (25 lines) | LoginForm wrapper with AuthLayout |
| Page | `src/pages/SignUpPage.tsx` (25 lines) | SignUpForm wrapper with AuthLayout |
| Page | `src/pages/SettingsPage.tsx` (279 lines) | Profile editing with privacy toggle |
| Unit test | `src/hooks/__tests__/useOnboarding.test.ts` | useOnboarding hook tests |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `update_profile_onboarding()` | Function | 0015 | SECURITY DEFINER function. Atomically: validates auth.uid(), checks role not already set, sets role + role_set_at on profiles, creates organization (for ORG_ADMIN), logs audit events (profile.role_set, org.created). Idempotent — returns success with already_set=true if called twice. |

#### Security Considerations

- **SECURITY DEFINER with SET search_path = public:** The onboarding function runs with elevated privileges to create the organization and set the role atomically. This bypasses RLS (by design) but validates `auth.uid()` to ensure only the authenticated user can onboard themselves.
- **Role immutability:** Once set via this function, the role cannot be changed (trigger from P1-TS-04).
- **Idempotent:** Safe for retry — no duplicate orgs or audit events on repeated calls.
- **Google OAuth:** Code references exist but provider is NOT configured in Supabase project settings. signInWithGoogle() will fail until configured.
- **Password minimum:** 8 characters enforced client-side in SignUpForm.

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/hooks/__tests__/useOnboarding.test.ts` | Unit | setRole(), createOrg(), error handling, idempotency |
| `e2e/auth.spec.ts` (121 lines) | E2E | Login/signup form visibility, navigation, password validation, sign out |
| `e2e/onboarding.spec.ts` (115 lines) | E2E | Role selection UI, org form validation, manual review gate display |
| `e2e/route-guards.spec.ts` (105 lines) | E2E | Mid-onboarding redirect, role-based routing |
| `e2e/identity.spec.ts` (113 lines) | E2E | Role immutability warning, privileged field protection, manual review blocking |

**Untested areas:**
- No unit test for `useAuth.ts`
- No unit test for `useProfile.ts`
- No test for Google OAuth flow (provider not configured)
- No test for email confirmation resend

#### Acceptance Criteria

- [x] LoginForm with email/password and Google OAuth button
- [x] SignUpForm with email confirmation flow and resend capability
- [x] RoleSelector shows INDIVIDUAL and ORG_ADMIN options with immutability warning
- [x] OrgOnboardingForm validates legal name (required) and domain (format)
- [x] ManualReviewGate blocks access with review timeline
- [x] useOnboarding.setRole() calls update_profile_onboarding RPC
- [x] useOnboarding.createOrg() creates org atomically with role
- [x] update_profile_onboarding is SECURITY DEFINER with SET search_path = public
- [x] Audit events logged for role_set and org_created
- [x] Page wrappers route correctly

#### Known Issues

| Bug | Impact |
|-----|--------|
| ~~[CRIT-4](../bugs/bug_log.md#crit-4-onboarding-routes-are-placeholders)~~ | RESOLVED 2026-03-10 (commit a38b485). RoleSelector, OrgOnboardingForm, and ManualReviewGate wired to routes via OnboardingRolePage, OnboardingOrgPage, ReviewPendingPage. |

#### How to Verify (Manual)

**Login flow:**
1. Run: `npm run dev`
2. Navigate to `/login`
3. Login as `admin@umich-demo.arkova.io` / `Demo1234!`
4. Should redirect to `/dashboard`

**Signup flow (requires email service):**
1. Navigate to `/signup`
2. Fill in name, email, password (8+ chars), confirm password
3. Click Sign Up — should show "Check your email" confirmation

**Onboarding (~~CRIT-4~~ FIXED):**
1. Navigate to `/onboarding/role` — RoleSelector renders with INDIVIDUAL/ORG_ADMIN options
2. OrgOnboardingForm: validates legal name required, domain format
3. ManualReviewGate: renders blocking screen with amber shield icon

**Settings:**
1. Login as any seed user
2. Navigate to `/settings`
3. Edit full name, save — should persist on refresh
4. Toggle privacy setting — should persist on refresh
5. Copy public_id — should work with clipboard API

---

## Onboarding Flow Diagram

```
Sign Up → Email Confirmation → Role Selection → [Branch]
                                                    │
                                        ┌───────────┴───────────┐
                                        │                       │
                                   INDIVIDUAL              ORG_ADMIN
                                        │                       │
                                        │              Org Onboarding Form
                                        │                       │
                                        │              Manual Review Gate
                                        │              (if flagged)
                                        │                       │
                                        ▼                       ▼
                                     /vault               /dashboard
```

All three onboarding steps (role, org, review) are gated by RouteGuard and the `useProfile().destination` computation.

## Hook Architecture

| Hook | Purpose | Returns | Used By |
|------|---------|---------|---------|
| `useAuth` | Supabase auth state | user, session, signIn, signUp, signOut | AuthGuard, LoginForm, SignUpForm |
| `useProfile` | Profile + destination | profile, destination, updateProfile | RouteGuard, SettingsPage |
| `useOrganization` | Org CRUD | organization, updateOrganization | OrgSettingsPage |
| `useOnboarding` | Role + org creation | setRole, createOrg, result | RoleSelector, OrgOnboardingForm |

## Related Documentation

- [12_identity_access.md](../confluence/12_identity_access.md) — Identity & access control details
- [02_data_model.md](../confluence/02_data_model.md) — profiles + organizations schema
- [03_security_rls.md](../confluence/03_security_rls.md) — RLS policies for profiles, organizations
- [04_audit_events.md](../confluence/04_audit_events.md) — Audit event types (profile.role_set, org.created)
- [bug_log.md](../bugs/bug_log.md) — ~~CRIT-4~~ (onboarding routes — RESOLVED)

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial P2 story documentation created (Session 1 of 3). |
| 2026-03-11 ~12:30 AM EST | Documentation audit: Updated all CRIT-4 references as resolved (commit a38b485). Route table updated with actual page components. |
