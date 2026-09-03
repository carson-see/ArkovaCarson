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

## AuthLinkErrorRedirect (PR #1824, SCRUM-2907)

`AuthLinkErrorRedirect.tsx` is a render-nothing component mounted once inside `<BrowserRouter>` in `App.tsx`. When a Supabase email link fails (expired / already used / tampered), Supabase puts `error` + `error_code` in the URL **fragment** and creates no session. `emailRedirectTo` only governs links minted *after* it shipped, so links already in inboxes come back to the project Site URL (`/`) — a route with nothing to explain the failure. This component bounces those loads to `/auth/callback`, the one page that renders the explanation.

**It MUST stay one-shot.** `authLinkErrorFromUrl` (`@/lib/supabase`) is a module-scope constant captured at load — before `detectSessionInUrl` consumes the fragment — and is never cleared. A plain `pathname`-keyed effect therefore re-fires on every later navigation and drags the user back to `/auth/callback`, which makes the error card's own CTAs (`Request a new link` → `/signup`, `Back to sign in` → `/login`) unusable. The `handledRef` latch is set the first time the effect *observes* a link error, not only when it redirects — a user who lands directly on `/auth/callback` is never redirected, so latching only on redirect would leave their first click away unprotected.

Regression coverage: `AuthLinkErrorRedirect.test.tsx` drives a **real** `MemoryRouter` (react-router-dom is deliberately not mocked — a mocked `useNavigate` never changes the location, so the re-fire is invisible) and asserts the CTA still lands on `/login` from both entry paths. The pure-predicate tests in `src/lib/authLinkRedirect.test.ts` cannot catch this: `shouldRedirectToAuthCallback` is correct in isolation; the defect was in how often it is called.

Note: `eslint-rules/no-unscoped-service-test.cjs` flags any test-file variable whose name merely *contains* "from" (substring match), so a mock named `mockAuthLinkErrorFromUrl` trips it spuriously. Mock state here is named `stubbedAuthLinkError` to avoid the false positive.

## 2026-09-03 — `TwoFactorSetup.tsx` rewrite: multi-factor list + AAL2 step-up (SCRUM-3167 / SCRUM-3584)

Rewritten from a single verified/unverified boolean into a real factor **list**. Mounted
unconditionally (no props) at `src/pages/SettingsPage.tsx:434` — unchanged from before. All
copy lives in `TWO_FACTOR_SETUP_LABELS` (`src/lib/copy.ts`, EOF section
`// ── Two-factor settings (SCRUM-3167 / SCRUM-3584) ──`); no raw provider error text is ever
rendered — every branch maps a GoTrue error `code` to one of our own copy strings.

**Behaviour:**
- Lists **every** TOTP factor from `listFactors()`, verified AND unverified (Amendment A2: a
  stale unverified factor — e.g. prod's 2026-03-23 row on a platform admin — must render as
  "Setup incomplete" with a working Remove action, never be hidden).
- `twofactor-enable` shows when there is no verified factor; `twofactor-add-backup` shows once
  one exists and total factors are below the GoTrue cap of 10 (`MAX_TOTAL_FACTORS`).
- The default friendly name (`Authenticator <YYYY-MM-DD>`) is de-duplicated **client-side**
  against the current factor list before `enroll()` is called (appends ` (2)`, ` (3)`, …) — a
  server-side `mfa_factor_name_conflict` is therefore a race, not the common case, and is
  handled by asking the user to retry rather than by an inline rename form.
- **GoTrue v2.196.0 AAL2 rule (Amendment A3):** enrolling a NEW factor while a verified one
  already exists, or unenrolling a VERIFIED factor, requires an `aal2` session. On
  `insufficient_aal` from either `enroll()` or `unenroll()`, the component shows an inline
  step-up form (`twofactor-stepup`) that runs `challengeAndVerify()` against the user's existing
  verified factor, then **automatically retries the original action** — never a dead end.
  Unverified factors need no step-up to remove.
- `mfa_totp_enroll_not_enabled` (the platform not having TOTP turned on) renders
  `TWO_FACTOR_SETUP_LABELS.UNAVAILABLE` as a non-blocking notice, not an error — this card must
  never wall a user the way the pre-revert PR #1973 architecture did platform-wide.
- After a successful verify (new or backup factor) or a successful unenroll, calls
  `supabase.auth.refreshSession()` (Amendment A4-8) so the JWT `aal` claim other code in the app
  reads (e.g. the sibling `useMfaAssurance` hook on `security/mfa-enforcement-3167`) is current
  in this session without waiting for a natural token refresh.

**Test ids:** `twofactor-factor-list`, `twofactor-factor-<id>`, `twofactor-remove-<id>`,
`twofactor-enable`, `twofactor-add-backup`, `twofactor-friendly-name` (read-only display of the
name actually sent to `enroll()` — editing it does nothing; the name is fixed at enroll time),
`twofactor-qr`, `twofactor-secret`, `twofactor-verify-code`, `twofactor-verify-submit`,
`twofactor-error`, `twofactor-unavailable`, `twofactor-stepup`, `twofactor-stepup-code`,
`twofactor-stepup-submit`, `twofactor-stepup-cancel`. Consumed by
`e2e/mfa-enrollment-and-challenge.spec.ts` (`e2e/agents.md`) via `e2e/helpers/mfa.ts`'s
`readSecretFromSettings` + `e2e/helpers/totp.ts`.

**Do NOT** assume `factor.friendly_name` is always present — it's optional in the SDK type
(prod has at least one legacy factor without one); the list falls back to
`TWO_FACTOR_SETUP_LABELS.UNNAMED_FACTOR`. **Do NOT** re-add an `organizations.hipaa_mfa_required`
query here — Amendment A4-3 dropped org-level enforcement from Phase 1 entirely; that lives only
in the sibling branch's `useMfaEnrollmentRequirement` hook, and even there it's currently unused
pending a Phase 2 audited RPC.
