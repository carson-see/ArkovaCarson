# agents.md — components/auth
_Last updated: 2026-09-03_

## What This Folder Contains
Authentication and identity components: login, signup, route guards, identity verification, 2FA, data rights (export/delete/correction).

## Key Files
- `AuthGuard.tsx` — Protects routes requiring authentication; redirects to login if unauthenticated. ALSO the MFA gate since SCRUM-3167 — see the dated entry below.
- `MfaChallenge.tsx` — Every-login MFA challenge for a session with a verified factor still at aal1 (SCRUM-3167)
- `MfaEnrollmentRequired.tsx` — Non-skippable, completable forced-enrollment screen for a required role with no verified factor (SCRUM-3167)
- `MfaGraceNudge.tsx` — Dismissible pre-enforcement heads-up banner, rendered ABOVE children (SCRUM-3167)
- `LoginForm.tsx` — Email/password login with Google and LinkedIn OAuth support, plus forgot-password flow
- `SignUpForm.tsx` — User registration form
- `OrgRequiredGate.tsx` — Wraps org-scoped pages; shows friendly upgrade prompt when user has no org_id
- `RouteGuard.tsx` — Route-level guard component
- `PlatformAdminRoute.tsx` — Route guard restricting platform-only admin routes to platform admins (see 2026-07-22 entry below)
- `IdentityVerification.tsx` — Stripe Identity verification card (dev mode auto-verifies via bypass)
- `TwoFactorSetup.tsx` — 2FA configuration UI (opt-in enroll/verify/unenroll card; a sibling SCRUM-3167 stream is rewriting this — see `security/mfa-settings-e2e-3167`, out of scope for this file's dated entry below)
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

## 2026-09-03 SCRUM-3167 — MFA login enforcement, restored and hardened (PR #1973 lineage)

Restores the MFA gate PR #1973 shipped (`3572fcd6e`) and reverted 9 minutes later (`6d10032b4`) after it walled out every ORG_ADMIN and platform admin — root cause was prod Supabase Auth having `mfa_totp_enroll_enabled=false` while the enrollment screen had no escape hatch on an `enroll()` failure. Prod TOTP is enabled now (2026-09-03, verified round-trip); the design below adds the fail-open contract PR #1973 was missing so a platform misconfiguration can never repeat that incident.

**AuthGuard.tsx decision order (first match wins)** — see `AuthGuard.mfaGate.test.tsx` for one named test per row:
1. `authLoading` → spinner
2. `!user` → login redirect/fallback
3. `mfaStatus === 'loading'` (from `useMfaAssurance`) → spinner
4. policy loading (from `useMfaEnrollmentRequirement`) → spinner
5. `mfaCapabilityUnavailable` → **children**, unconditionally, for the rest of this AuthGuard instance's life
6. `mfaStatus === 'challenge_required'` → `<MfaChallenge>`
7. `!hasVerifiedFactor && mfaRequired` → `<MfaEnrollmentRequired>`
8. `mfaGraceActive` → `<MfaGraceNudge/>` rendered ABOVE children (children still render — this is a heads-up, not a gate)
9. else → children

**FAIL-OPEN CONTRACT — read before touching any of these four files:**
- `MfaChallenge`: `listFactors()` erroring calls `onVerified()` directly (changed from PR #1973, which showed an unrecoverable error screen instead). `challenge()`/`verify()` errors split into wrong-code (`mfa_verification_failed`, `mfa_verification_rejected`, `mfa_challenge_expired`, `validation_failed` → retryable inline error, the user's own mistake) versus everything else (unknown code, no code, thrown exception → `onCapabilityUnavailable(code)`).
- `MfaEnrollmentRequired`: **CTO ruling A4-2 — no allowlist.** `enroll()` returning ANY error (known code, unknown code, missing data), a thrown exception, or a request that hangs past an 8s circuit breaker ALL call `onCapabilityUnavailable(code)`. Every existing ORG_ADMIN/platform admin has zero verified factors today, so a design that could wall one of them out on ANY enroll failure mode would repeat the PR #1973 incident exactly. Also sends a unique `friendlyName` per enrollment attempt (Amendment A2) to avoid `mfa_factor_name_conflict` against the one stale unverified factor already on prod.
- `AuthGuard`: `onCapabilityUnavailable` is wired identically from both screens into one `mfaCapabilityUnavailable` state — once set, renders children for good, fires a Sentry `mfa_capability_unavailable` message (`{code, path}` tags only, never PII, via the same lazy `import('@/lib/sentry')` pattern as `src/components/layout/RouteErrorBoundary.tsx`) and a ONE-SHOT `toast.warning(MFA_CAPABILITY_LABELS.UNAVAILABLE_NOTICE)` (ref-guarded — fires at most once per AuthGuard mount even if the callback somehow fires twice).
- **This fail-open bypass is an ACCEPTED PHASE-1 TRADE-OFF (CTO ruling A4-7).** An enrolled user hitting a blocked MFA endpoint falls back to aal1 pass-through rather than being locked out. The Sentry emission makes a sustained or targeted bypass observable; **SCRUM-3593 (aal2-aware RLS on platform-admin surfaces)** is the phase-2 control that closes it server-side, planned to land only after this gate has soaked in prod past the enforcement date.

**Role tier is phase-1 ONLY** (CTO ruling A4-3): ORG_ADMIN and platform admins, from `src/lib/mfaPolicy.ts`'s `isMfaRequiredRole`. `organizations.hipaa_mfa_required` (org-level enforcement) is **deliberately not read anywhere in this gate** — that column is writable by any org owner/admin via PostgREST with zero audit trail, so it cannot back a security control yet. Phase 2 needs an audited service-role RPC + a column `REVOKE` migration (T3) before org-level enforcement can safely re-enable (this is what delivers the still-open SCRUM-564 HIPAA REG-05 story).

**Date override rules** (`src/lib/mfaPolicy.ts`, CTO ruling A4-1/A4-9): the enforcement date defaults to `2026-09-21T00:00:00Z`, overridable by `VITE_MFA_ENFORCE_FROM` (Carson can move the deadline via a Vercel env change + redeploy, no code change), further overridable by `localStorage['arkova_mfa_enforce_from_override']` ONLY when `import.meta.env.DEV === true` OR `VITE_MFA_ALLOW_DATE_OVERRIDE === 'true'`. **Never set `VITE_MFA_ALLOW_DATE_OVERRIDE` on Vercel prod** — see `docs/reference/ENV.md`. Every candidate string must match a strict UTC regex or it is ignored (falls through, never treated as "never enforce").

**Deleted:** the former src/hooks/useHipaaMfaGate hook (deleted in this PR) (zero non-test importers, superseded by `useMfaEnrollmentRequirement.ts`).

**Founder-reserved go-live checklist items** (tracked, not this PR's job): enroll or demote the shared UAT demo account (`demo@arkova-uat.dev`, ORG_ADMIN) before 2026-09-21; `password_hibp_enabled` + `password_min_length=8` in Supabase Auth config; WebAuthn (SCRUM-1194) later.
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
