# Identity & Access Control

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

## User Roles

Arkova has two user roles, assigned during onboarding:

| Role | Description | Access |
|------|-------------|--------|
| `INDIVIDUAL` | Personal users | Own anchors only |
| `ORG_ADMIN` | Organization administrators | Org-wide anchor access, member management |

### Role Immutability

Roles are **immutable** once set:
- Role can only transition from `NULL` to `INDIVIDUAL` or `ORG_ADMIN`
- Enforced at database level via trigger (`check_role_immutability`)
- Attempted changes raise `check_violation` error

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
┌──────────────────┐
│  Role Selection  │
│  /onboarding/role│
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
INDIVIDUAL  ORG_ADMIN
    │         │
    │         ▼
    │  ┌─────────────────┐
    │  │ Org Onboarding  │
    │  │ /onboarding/org │
    │  └────────┬────────┘
    │           │
    ▼           ▼
┌──────┐  ┌───────────┐
│/vault│  │/dashboard │
└──────┘  └───────────┘
```

### Role Selection (P2-E1)
- New users select between Individual and Organization accounts
- Selection is one-time and cannot be changed
- Uses `update_profile_onboarding` RPC function

### Organization Onboarding (KYB-lite)
- ORG_ADMIN users must provide organization details:
  - Legal name (required)
  - Display name (optional, defaults to legal name)
  - Domain (optional, for email verification)
- Creates organization record atomically with role assignment

## Route Guards

### Session Bootstrap

The `useProfile` hook determines routing based on user state:

```typescript
type RouteDestination =
  | '/auth'           // Not authenticated
  | '/onboarding/role'    // Authenticated but no role
  | '/onboarding/org'     // ORG_ADMIN with incomplete org setup
  | '/review-pending'     // Requires manual review
  | '/vault'              // INDIVIDUAL user, ready
  | '/dashboard';         // ORG_ADMIN, ready
```

### Manual Review Gate

Users with `requires_manual_review = true` are blocked from accessing the app:
- Shows "Account Under Review" message
- Cannot bypass until admin clears the flag
- Used for flagged signups, suspicious activity, etc.

## Database Functions

### `update_profile_onboarding`

Transactional function for role assignment and org creation:

```sql
update_profile_onboarding(
  p_role: user_role,
  p_org_legal_name?: text,
  p_org_display_name?: text,
  p_org_domain?: text
) RETURNS jsonb
```

**Security**:
- SECURITY DEFINER with `auth.uid()` validation
- Only authenticated users can call
- Idempotent: returns success if role already set

**Audit Events Emitted**:
- `profile.role_set` - When role is assigned
- `org.created` - When organization is created

## Privileged Field Protection

The following profile fields cannot be modified directly by users:

| Field | Protection |
|-------|------------|
| `role` | Immutability trigger |
| `org_id` | RLS trigger |
| `requires_manual_review` | RLS trigger |
| `manual_review_*` | RLS trigger |

Enforced by `protect_privileged_profile_fields()` trigger.

## Session Management

### Session Hook (`useAuth`)
- Tracks authentication state
- Listens for auth state changes
- Provides sign-in, sign-up, sign-out methods

### Profile Hook (`useProfile`)
- Fetches user profile from database
- Computes routing destination
- Provides profile refresh method

## Security Considerations

1. **RLS Policies**: All profile access scoped to `auth.uid()`
2. **Role Immutability**: Prevents privilege escalation
3. **Manual Review Gate**: Blocks suspicious accounts
4. **Audit Trail**: All onboarding actions logged
5. **Service Role**: Only backend can modify privileged fields

## Testing

### Unit Tests
- `useAuth.test.ts` - Auth hook
- `useProfile.test.ts` - Profile hook with routing
- `useOnboarding.test.ts` - Onboarding flow

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

## Related Documentation

- [02_data_model.md](./02_data_model.md) - Profile and Organization tables
- [03_security_rls.md](./03_security_rls.md) - Row Level Security policies
- [04_audit_events.md](./04_audit_events.md) - Audit logging
