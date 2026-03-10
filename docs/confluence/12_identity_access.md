# Identity & Access Control
_Last updated: 2026-03-10 | Story: P2-TS-03 through P2-TS-0X_

## Overview

Arkova implements a robust identity and access control system that determines who users are, what they can do, and where they are routed. This document covers authentication, role-based access, onboarding flows, and session management.

## Authentication Methods

### Email/Password
- Standard email/password authentication via Supabase Auth
- Email confirmation required for new signups
- Password minimum: 8 characters

### Google OAuth
- Single sign-on via Google
- Redirects to `/auth/callback` after authentication
- Profile created automatically on first login
- **Status:** Not yet configured in Supabase project settings. Code references exist but OAuth provider is not enabled.

## User Roles

Arkova has three user roles, defined in the `user_role` enum:

| Role | Description | Access | Migration |
|------|-------------|--------|-----------|
| `INDIVIDUAL` | Personal users | Own anchors only | 0001 (original enum) |
| `ORG_ADMIN` | Organization administrators | Org-wide anchor access, member management | 0001 (original enum) |
| `ORG_MEMBER` | Organization members | Org anchor read access (via RLS) | 0022 (added value) |

> **Note:** `ORG_MEMBER` was added in migration 0022 for membership tracking. The onboarding flow only offers `INDIVIDUAL` and `ORG_ADMIN` — `ORG_MEMBER` is assigned via invitation/backend processes.

### Role Immutability

Roles are **immutable** once set:
- Role can only transition from `NULL` to `INDIVIDUAL` or `ORG_ADMIN`
- Enforced at database level via trigger (`check_role_immutability` — migration 0008)
- Attempted changes raise `check_violation` error
- Trigger fires even for `service_role` — no bypass possible

## Onboarding Flow

### Flow Diagram

```
┌─────────────┐
│   Sign Up   │
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│ Email Confirmed? │
└────────┬─────────┘
         │ Yes
         ▼
┌──────────────────────────────────────────────────────────────┐
│  Role Selection                                              │
│  /onboarding/role                                            │
│  Component: RoleSelector                                     │
│  ⚠ CRIT-4: Route currently renders <DashboardPage/>.        │
│  RoleSelector component exists but is not wired to route.    │
└────────┬─────────────────────────────────────────────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
INDIVIDUAL  ORG_ADMIN
    │         │
    │         ▼
    │  ┌─────────────────────────────────────────────────────┐
    │  │ Org Onboarding                                      │
    │  │ /onboarding/org                                     │
    │  │ Component: OrgOnboardingForm                        │
    │  │ ⚠ CRIT-4: Route currently renders <DashboardPage/>.│
    │  └────────┬────────────────────────────────────────────┘
    │           │
    │           ▼
    │  ┌─────────────────────────────────────────────────────┐
    │  │ Manual Review Gate (if flagged)                     │
    │  │ /review-pending                                     │
    │  │ Component: ManualReviewGate                         │
    │  │ ⚠ CRIT-4: Route currently renders <DashboardPage/>.│
    │  └────────┬────────────────────────────────────────────┘
    │           │
    ▼           ▼
┌──────┐  ┌───────────┐
│/vault│  │/dashboard │
└──────┘  └───────────┘
```

### Role Selection (P2-E1)
- New users select between Individual and Organization accounts
- Selection is one-time and cannot be changed
- Uses `update_profile_onboarding` RPC function (migration 0015)

### Organization Onboarding (KYB-lite)
- ORG_ADMIN users must provide organization details:
  - Legal name (required)
  - Display name (optional, defaults to legal name)
  - Domain (optional, for email verification)
- Creates organization record atomically with role assignment
- Organization starts with `verification_status = 'UNVERIFIED'`

## Route Guards

### Session Bootstrap

The `useProfile` hook determines routing based on user state:

```typescript
type RouteDestination =
  | '/auth'               // Not authenticated
  | '/onboarding/role'    // Authenticated but no role
  | '/onboarding/org'     // ORG_ADMIN with incomplete org setup
  | '/review-pending'     // Requires manual review
  | '/vault'              // INDIVIDUAL user, ready
  | '/dashboard';         // ORG_ADMIN, ready
```

### Manual Review Gate

Users with `requires_manual_review = true` are blocked from accessing the app:
- Shows "Account Under Review" message
- Cannot bypass until admin clears the flag (service_role only)
- Used for flagged signups, suspicious activity, etc.

## Database Functions

### `update_profile_onboarding` (migration 0015)

Transactional function for role assignment and org creation:

```sql
CREATE OR REPLACE FUNCTION update_profile_onboarding(
  p_role user_role,
  p_org_legal_name text DEFAULT NULL,
  p_org_display_name text DEFAULT NULL,
  p_org_domain text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
```

**Security**:
- SECURITY DEFINER with `SET search_path = public` (Constitution 1.4 compliant)
- Validates `auth.uid()` — rejects unauthenticated calls
- Only authenticated users can call (`GRANT EXECUTE ... TO authenticated`)
- Idempotent: returns success with `already_set = true` if role already set

**Behavior**:
- For `INDIVIDUAL`: Sets `role` and `role_set_at` on profiles
- For `ORG_ADMIN`: Creates organization, sets `role`, `role_set_at`, and `org_id` on profiles
- Validates `p_org_legal_name` is required for `ORG_ADMIN`
- Defaults `p_org_display_name` to `p_org_legal_name` if not provided

**Audit Events Emitted**:
- `profile.role_set` (category: `PROFILE`) — When role is assigned
- `org.created` (category: `ORG`) — When organization is created (ORG_ADMIN only)

**Return Value**:
```json
{
  "success": true,
  "role": "INDIVIDUAL | ORG_ADMIN",
  "already_set": false,
  "user_id": "uuid",
  "org_id": "uuid (ORG_ADMIN only)"
}
```

## Privileged Field Protection

The following profile fields cannot be modified directly by users:

| Field | Protection | Migration |
|-------|------------|-----------|
| `role` | Immutability trigger (`check_role_immutability`) | 0008 |
| `role_set_at` | Privileged field trigger | 0008, 0035 |
| `org_id` | Privileged field trigger | 0008, 0035 |
| `requires_manual_review` | Privileged field trigger | 0008, 0035 |
| `manual_review_reason` | Privileged field trigger | 0008, 0035 |
| `manual_review_at` | Privileged field trigger | 0008, 0035 |
| `public_id` | Privileged field trigger | 0035 |

Enforced by `protect_privileged_profile_fields()` trigger (migration 0008, updated in 0035 to include `public_id`).

## Session Management

### Session Hook (`useAuth`)
- Tracks authentication state via `onAuthStateChange`
- Provides sign-in, sign-up, sign-out methods
- Located at `src/hooks/useAuth.ts`

### Profile Hook (`useProfile`)
- Fetches user profile from database
- Computes routing destination based on role, org_id, requires_manual_review
- Provides profile refresh method
- Located at `src/hooks/useProfile.ts`

### Onboarding Hook (`useOnboarding`)
- Calls `update_profile_onboarding` RPC
- Handles role selection and org creation flow
- Located at `src/hooks/useOnboarding.ts`

## Security Considerations

1. **RLS Policies**: All profile access scoped to `auth.uid()` (migration 0008)
2. **Role Immutability**: Prevents privilege escalation — trigger fires even for service_role
3. **Manual Review Gate**: Blocks suspicious accounts from app access
4. **Audit Trail**: All onboarding actions logged to `audit_events`
5. **Service Role**: Only backend can modify privileged fields
6. **SECURITY DEFINER**: Onboarding function runs with elevated privileges but validates caller identity

## Testing

### Unit Tests

| Test File | Exists | Location |
|-----------|--------|----------|
| `useAuth.test.ts` | **No** | — |
| `useProfile.test.ts` | **No** | — |
| `useOnboarding.test.ts` | **Yes** | `src/hooks/__tests__/useOnboarding.test.ts` |

### Integration Tests (RLS)
- Role immutability enforcement
- Privileged field protection
- Org scoping validation

### E2E Tests (Playwright)
- Complete signup flow with email confirmation
- Role selection paths (Individual vs ORG_ADMIN)
- Organization onboarding
- Manual review gate blocking
- Route guard enforcement

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Email/password auth | **Complete** | Supabase Auth configured |
| Google OAuth | **Not Started** | Provider not configured in Supabase |
| Role selection UI (RoleSelector) | **Complete** | Component exists at `src/components/onboarding/RoleSelector.tsx` |
| Org onboarding UI (OrgOnboardingForm) | **Complete** | Component exists at `src/components/onboarding/OrgOnboardingForm.tsx` |
| Manual review gate UI (ManualReviewGate) | **Complete** | Component exists at `src/components/onboarding/ManualReviewGate.tsx` |
| Onboarding route wiring | **Not Started** | CRIT-4: All three routes (`/onboarding/role`, `/onboarding/org`, `/review-pending`) render `<DashboardPage/>` placeholder |
| `update_profile_onboarding` RPC | **Complete** | Migration 0015 |
| Role immutability trigger | **Complete** | Migration 0008 |
| Privileged field protection trigger | **Complete** | Migration 0008, updated 0035 |
| Route guards (useProfile routing) | **Complete** | Hook computes correct destination |
| useAuth hook | **Complete** | No unit test |
| useProfile hook | **Complete** | No unit test |
| useOnboarding hook | **Complete** | Unit test exists |

## Related Documentation

- [02_data_model.md](./02_data_model.md) — Profile and Organization tables
- [03_security_rls.md](./03_security_rls.md) — Row Level Security policies
- [04_audit_events.md](./04_audit_events.md) — Audit logging

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit session 3 | Added `_Last updated_` line. Added ORG_MEMBER role (migration 0022). Annotated flow diagram with CRIT-4 status. Expanded `update_profile_onboarding` docs with full signature, return value, and behavior from migration 0015. Added `public_id` to privileged fields (migration 0035). Corrected test file table — `useAuth.test.ts` and `useProfile.test.ts` do not exist. Marked Google OAuth as not configured. Added implementation status table. |
