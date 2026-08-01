# agents.md — components/auth
_Last updated: 2026-07-22_

## What This Folder Contains
Authentication and identity components: login, signup, route guards, identity verification, 2FA, data rights (export/delete/correction).

## Key Files
- `AuthGuard.tsx` — Protects routes requiring authentication; redirects to login if unauthenticated
- `LoginForm.tsx` — Email/password login with Google and LinkedIn OAuth support, plus forgot-password flow
- `SignUpForm.tsx` — User registration form
- `OrgRequiredGate.tsx` — Wraps org-scoped pages; shows friendly upgrade prompt when user has no org_id
- `RouteGuard.tsx` — Route-level guard component
- `PlatformAdminRoute.tsx` — Route guard restricting platform-only admin routes to platform admins (see 2026-07-22 entry below)
- `IdentityVerification.tsx` — Stripe Identity verification card (dev mode auto-verifies via bypass)
- `TwoFactorSetup.tsx` — 2FA configuration UI
- `DataCorrectionForm.tsx` — GDPR/privacy data correction request form
- `DeleteAccountDialog.tsx` — Account deletion confirmation dialog
- `ExportDataButton.tsx` — GDPR data export trigger
- `RecoveryPhraseModal.tsx` — Recovery phrase display modal
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useAuth` — auth state, signIn, signInWithGoogle, signInWithLinkedIn
- `@/hooks/useProfile` — profile state for org gating
- `@/lib/routes` (ROUTES) — named route constants

## Do / Don't Rules
- DO: Use `useAuth()` hook for all auth state — never call Supabase auth directly in components
- DO NOT: Expose `supabase.auth.admin` or service role key to browser

## 2026-07-22 PlatformAdminRoute (SCRUM-2939 / PI05-ADMIN)

_Restored 2026-07-28 — lost off `main` by the union-merge-driver incident (see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`). This is the confirmed example that triggered the audit: `PlatformAdminRoute.tsx` and this section both remained on disk and in git history the whole time, only the documentation was silently dropped._

`PlatformAdminRoute.tsx` gates platform-only admin routes (treasury, pipeline, controls, payments, ops-slo, system-health, platform-overview, admin user/record/subscription/org lists) to platform admins in `App.tsx`. Authority is the `profiles.is_platform_admin` DB flag via `useProfile` + `isPlatformAdmin(profile)` (@/lib/platform) — the SAME source the worker (`utils/platformAdmin.ts`) and RLS enforce. The legacy client-side email whitelist (`PLATFORM_ADMIN_EMAILS`) was DELETED. This guard is client UX / defence-in-depth ONLY; every platform endpoint/RPC re-verifies the flag server-side, so a client hide never stands alone. Use INSIDE `<AuthGuard>`. ORG_ADMIN/INDIVIDUAL are redirected to `/dashboard`.

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

IdentityVerification helper copy scrubbed ("your records and attestations"). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
