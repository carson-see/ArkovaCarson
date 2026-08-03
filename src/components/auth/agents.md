# agents.md — components/auth
_Last updated: 2026-08-03_

## What This Folder Contains
Authentication and identity components: login, signup, route guards, identity verification, 2FA, data rights (export/delete/correction).

## Key Files
- `AuthGuard.tsx` — Protects routes requiring authentication; redirects to login if unauthenticated. Also the MFA session/enrollment gate (see 2026-08-03 entry) — the single choke point every authenticated route in App.tsx renders through (51 `<AuthGuard>` usages as of this change), so it is the one place a page-reload or deep-link cannot slip past either gate.
- `LoginForm.tsx` — Email/password login with Google and LinkedIn OAuth support, plus forgot-password flow. Does NOT itself handle MFA — a password-only sign-in still lands the user on an aal1 session; `AuthGuard` (not this component) decides whether that session needs a challenge or forced enrollment before any route renders.
- `SignUpForm.tsx` — User registration form
- `OrgRequiredGate.tsx` — Wraps org-scoped pages; shows friendly upgrade prompt when user has no org_id
- `RouteGuard.tsx` — Route-level guard component
- `PlatformAdminRoute.tsx` — Route guard restricting platform-only admin routes to platform admins (see 2026-07-22 entry below)
- `IdentityVerification.tsx` — Stripe Identity verification card (dev mode auto-verifies via bypass)
- `TwoFactorSetup.tsx` — 2FA configuration UI (voluntary self-service enroll/disable, rendered on Settings). Untouched by the 2026-08-03 MFA hardening — kept as the one place ANY user (required role or not) can manage their own factor after they're already past AuthGuard.
- `MfaChallenge.tsx` — Login-challenge screen (2026-08-03). Rendered by AuthGuard in place of children when the session is aal1 but a verified TOTP factor exists.
- `MfaEnrollmentRequired.tsx` — Mandatory-enrollment screen (2026-08-03). Rendered by AuthGuard in place of children when the user's role requires MFA (see `useMfaEnrollmentRequirement`) and no verified factor exists yet. Non-skippable but always completable — see its own doc comment for the lockout-avoidance reasoning.
- `DataCorrectionForm.tsx` — GDPR/privacy data correction request form
- `DeleteAccountDialog.tsx` — Account deletion confirmation dialog
- `ExportDataButton.tsx` — GDPR data export trigger
- `RecoveryPhraseModal.tsx` — Recovery phrase display modal
- `index.ts` — Barrel exports (NOTE: `MfaChallenge`/`MfaEnrollmentRequired` are deliberately NOT barrel-exported, matching `TwoFactorSetup`'s existing direct-import convention — `AuthGuard.tsx` imports them by relative path)

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

## AuthLinkErrorRedirect (PR #1824, SCRUM-2907)

`AuthLinkErrorRedirect.tsx` is a render-nothing component mounted once inside `<BrowserRouter>` in `App.tsx`. When a Supabase email link fails (expired / already used / tampered), Supabase puts `error` + `error_code` in the URL **fragment** and creates no session. `emailRedirectTo` only governs links minted *after* it shipped, so links already in inboxes come back to the project Site URL (`/`) — a route with nothing to explain the failure. This component bounces those loads to `/auth/callback`, the one page that renders the explanation.

**It MUST stay one-shot.** `authLinkErrorFromUrl` (`@/lib/supabase`) is a module-scope constant captured at load — before `detectSessionInUrl` consumes the fragment — and is never cleared. A plain `pathname`-keyed effect therefore re-fires on every later navigation and drags the user back to `/auth/callback`, which makes the error card's own CTAs (`Request a new link` → `/signup`, `Back to sign in` → `/login`) unusable. The `handledRef` latch is set the first time the effect *observes* a link error, not only when it redirects — a user who lands directly on `/auth/callback` is never redirected, so latching only on redirect would leave their first click away unprotected.

Regression coverage: `AuthLinkErrorRedirect.test.tsx` drives a **real** `MemoryRouter` (react-router-dom is deliberately not mocked — a mocked `useNavigate` never changes the location, so the re-fire is invisible) and asserts the CTA still lands on `/login` from both entry paths. The pure-predicate tests in `src/lib/authLinkRedirect.test.ts` cannot catch this: `shouldRedirectToAuthCallback` is correct in isolation; the defect was in how often it is called.

Note: `eslint-rules/no-unscoped-service-test.cjs` flags any test-file variable whose name merely *contains* "from" (substring match), so a mock named `mockAuthLinkErrorFromUrl` trips it spuriously. Mock state here is named `stubbedAuthLinkError` to avoid the false positive.

## 2026-08-03 MFA session gate + mandatory enrollment (pre-pentest hardening, founder directive)

**Root cause fixed:** `signInWithPassword()` returned a session at `aal1` even for users with a verified TOTP factor, and nothing anywhere called `getAuthenticatorAssuranceLevel()` or `mfa.challenge()`/`mfa.verify()` after login. An enrolled user's MFA was decorative — a password alone granted full access, every time, forever (no re-prompt on later logins either, since nothing ever prompted in the first place).

**What changed, in `AuthGuard.tsx`** (the single choke point every authenticated route renders through): after the existing loading/redirect checks, AuthGuard now branches on two new self-contained hooks (`@/hooks/useMfaAssurance`, `@/hooks/useMfaEnrollmentRequirement` — see `src/hooks/agents.md`):
1. `mfaStatus === 'challenge_required'` → renders `MfaChallenge` instead of children. Applies to ANY user with a verified factor, regardless of role — voluntary enrollment is honored the same as mandated enrollment.
2. `!hasVerifiedFactor && mfaRequired` → renders `MfaEnrollmentRequired` instead of children. `mfaRequired` is role-gated (see enforcement tier below).
3. Otherwise → children, exactly as before. A user with no factor on a role that does not require MFA is **completely unaffected** — this is the regression this whole change cannot ever cause; see `AuthGuard.mfaGate.test.tsx`'s first test.

**Enforcement tier (recommendation, stated explicitly per founder ask):** mandatory NOW for `ORG_ADMIN` and platform admins (`profiles.is_platform_admin`) — the highest blast-radius accounts, matching `PlatformAdminRoute`'s own authority source. `ORG_MEMBER`/`INDIVIDUAL` are NOT forced in this PR; a grace-window rollout (dated deadline, in-app countdown nudge, then hard enforcement) is proposed in the PR description but deliberately not implemented — shipping population-wide forced enrollment same-day, bundled into a pentest-hardening PR, is a materially different and much larger blast-radius change than privileged-role enforcement, and deserves its own PR with its own soak.

**Forced enrollment ≠ lockout:** `MfaEnrollmentRequired` is rendered INLINE by AuthGuard (never via `<Navigate>`/route redirect), so there is no route to redirect to and therefore no possible "guard redirects to a route that is itself guarded" loop — proven explicitly by `AuthGuard.mfaGate.test.tsx`'s "NO REDIRECT LOOP" test (asserts `Navigate` is never invoked on this path). The screen starts TOTP enrollment automatically and ends with the user at aal2 in the SAME session once they verify — it is a completable path, not a dead end. It has no "skip" affordance by design, but always has a working "Sign out" affordance (lockout safety valve for a user without their device handy).

**Every-login enforcement, verified against `@supabase/auth-js` source** (`GoTrueClient.js` `_getAuthenticatorAssuranceLevel`): the `aal` level is decoded fresh from whatever JWT the CURRENT session holds — a stateless, per-session read, never a persistent "has this user ever verified" flag. Neither hook here persists a verified flag anywhere beyond one mounted component's local `useState` (destroyed on every route navigation, since each `<Route>` in App.tsx wraps its own `<AuthGuard>`, and on every full reload). The practical guarantee: a second, independent login by an already-enrolled user is challenged again, by construction, with no shortcut. Pinned by `useMfaAssurance.test.ts`'s "EVERY-LOGIN ENFORCEMENT" and "SESSION RESTORE" tests, and mirrored at the integration level in `AuthGuard.mfaGate.test.tsx`.

**Break-glass (lost device):** no in-app self-service path exists (by design — that would defeat MFA). Documented manual runbook (service_role only, auditable): identify the factor via `SELECT id FROM auth.mfa_factors WHERE user_id = ...`, remove it via `supabase.auth.admin.mfa.deleteFactor({ id, userId })` (verified against `GoTrueAdminApi` — the correct supported path, not a raw `DELETE`), then insert an `audit_events` row (`event_category = 'AUTH'`) recording the operator and reason. Not shipped as a worker endpoint in this PR — `services/worker/` is a different lane (see `docs/operating-model/lane-manifest.yaml`) and building a new admin-privileged endpoint under time pressure in the same PR as this frontend change was judged a needless second blast radius. Full runbook text is in the PR description.

**Deleted, same PR:** `useHipaaMfaGate.ts` (`src/hooks/`) — see `src/hooks/agents.md` 2026-08-03 entry. Also built-then-removed: `PrivilegedMfaNudge.tsx`, a non-blocking Settings banner for privileged roles without MFA, superseded before it ever landed by the mandatory-enrollment gate above (same predicate, but AuthGuard now blocks the exact population the banner would have nudged before they can ever reach Settings unenrolled — the banner would have been unreachable dead code from the moment this PR merged).

**RLS:** deliberately NOT touched. No `aal2` requirement was added to any RLS policy — this is app-level enforcement only, per explicit founder instruction (an RLS-level aal2 requirement can lock out worker/service_role paths and is not revertible without a migration). Proposed as a follow-up with its own written plan, not implemented here.
