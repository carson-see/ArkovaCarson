# agents.md — components/auth
_Last updated: 2026-09-03_

## PR #2637 backup QR lost during token refresh (2026-09-05)

Real GoTrue traces reproduced successful backup-factor creation followed by a
missing QR and an incomplete factor. The verify and refresh responses carry
different JWTs for the same session_id/aal2. Whole-token cache identity forced
AuthGuard to show a spinner and unmount Settings during enrollment. Cache identity
now uses session_id plus AAL, bound to the current user. Token refresh still
rechecks immediately in the background; new sign-ins and AAL changes invalidate
the identity. Red-first tests cover refresh preservation and new-login/downgrade
isolation. The prior 12h UI soak remains failed evidence and is not reused.

## UAT-01 / SCRUM-4031 — open registration (2026-09-05)

`SignUpForm` renders email/password and Google/LinkedIn choices immediately. The retired beta-code prerequisite and its local state are removed. Keep organization invitation authorization and the `useAuth` session/confirmation flow separate. Registration tests run with both an absent and a stale `VITE_BETA_INVITE_CODE`; a legacy deployment variable must never restore the beta screen.

_Last updated: 2026-07-22_

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
- `TwoFactorSetup.tsx` — 2FA configuration UI (opt-in multi-factor list, enroll/verify/unenroll + AAL2 step-up card; rewritten — see the "TwoFactorSetup.tsx rewrite" dated entry below)
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

## SCRUM-4035 — OAuth mailbox confirmation

`OAuthEmailConfirmation` owns the separate post-OAuth mailbox step; `SignUpPage` selects it
without coupling `SignUpForm` to provider behavior. `AuthGuard` redirects signed pending
sessions before mounting protected content. This UI is not the security boundary: the
worker/edge verifiers and database role enforce the same state. Preserve the checked local
sign-out + `arkova_signed_out` flag + hard navigation convention to avoid profile teardown races.
## 2026-09-03 SCRUM-3167 — MFA login enforcement, restored and hardened (PR #1973 lineage)

Restores the MFA gate PR #1973 shipped (`3572fcd6e`) and reverted 9 minutes later (`6d10032b4`) after it walled out every ORG_ADMIN and platform admin — root cause was prod Supabase Auth having `mfa_totp_enroll_enabled=false` while the enrollment screen had no escape hatch on an `enroll()` failure. Prod TOTP is enabled now (2026-09-03, verified round-trip); the design below adds the fail-open contract PR #1973 was missing so a platform misconfiguration can never repeat that incident.

**AuthGuard.tsx decision order (first match wins)** — see `AuthGuard.mfaGate.test.tsx` for one named test per row. **REVISED 2026-09-03 by the R17-R21 CTO ruling below — this replaces the original PR #1973-lineage design (rows 5/6 used to be swapped, with a single top-level `mfaCapabilityUnavailable` flag checked BEFORE the challenge row).**
1. `authLoading` → spinner
2. `!user` → login redirect/fallback
3. `mfaStatus === 'loading'` (from `useMfaAssurance`) → spinner
4. policy loading (from `useMfaEnrollmentRequirement`) → spinner
5. `mfaStatus === 'challenge_required'` → `<MfaChallenge onVerified={markVerified} />`, **UNCONDITIONALLY** — no cooldown or capability-unavailable state is consulted here at all
6. `!hasVerifiedFactor && mfaRequired` → the userId-scoped capability cooldown is active for the current user? **children** : `<MfaEnrollmentRequired onEnrolled={markVerified} onCapabilityUnavailable={handleCapabilityUnavailable} />`
7. `mfaGraceActive` → `<MfaGraceNudge/>` rendered ABOVE children (children still render — this is a heads-up, not a gate)
8. else → children

**FAIL-CLOSED CHALLENGE / FAIL-OPEN ENROLLMENT (CTO ruling, PR #2637 review round 2, R17-R21) — read before touching any of these four files:**

Supersedes the original "fail open on any platform error" design. Fail-open is allowed **ONLY on the enrollment path** (row 6 — a user with NO verified factor who cannot enrol because the platform cannot issue one). The **challenge path** (row 5 — a session at aal1 whose user HAS a verified factor) **fails CLOSED**: any error shows a retry screen, never renders children. Rationale: a client-detected "platform error" is trivially attacker-triggerable (block one request in DevTools), so fail-open on the challenge path made MFA optional for anyone holding a password — this is what the round-2 review confirmed as a live bypass (below).

- `MfaChallenge`: **no `onBypassed`/`onCapabilityUnavailable` props left at all** — `onVerified` is the only prop, and it fires ONLY after a real, successful `challenge()`+`verify()` round trip. Every other outcome enters a `'retry'` state (a full screen with "Try again" + "Sign out", never the code form): `listFactors()` erroring/throwing/timing out or defensively finding no verified factor; a `challenge()`/`verify()` error classified `'platform'` by `@/lib/mfaErrors`' `classifyMfaError` (the explicit MFA-disabled capability codes, an unrecognized/absent error code, a thrown exception, or a `withTimeout` race firing); a wrong-code (`mfa_verification_failed`, `mfa_verification_rejected`, `mfa_challenge_expired`) or an explicit backend **rejection** (`over_request_rate_limit`, `mfa_ip_address_mismatch`, `validation_failed`, or any other code — classified `'rejected'`) both show an inline retryable error and leave the form usable; neither ever calls `onVerified`. The `'retry'` state re-checks automatically on the same `useVisibilityPolling` cadence as the rest of the gate.
- `MfaEnrollmentRequired`: **CTO ruling A4-2 — no allowlist, unchanged.** `enroll()` returning ANY error, a thrown exception, or a request that hangs past its timeout ALL call `onCapabilityUnavailable(code)` — this is the ONE place fail-open still applies, since every existing ORG_ADMIN/platform admin has zero verified factors today and a design that could wall one of them out on ANY enroll failure mode would repeat the PR #1973 incident exactly. **R20 (round 2):** the orphan-factor cleanup for a late-resolving `enroll()` now fires on ANY unmount (navigating away), not just the original 8s→15s timeout race — a user who simply leaves this screen before `enroll()` resolves left the same kind of invisible, unverified orphan factor if the original call later succeeded server-side. **R3:** that cleanup `unenroll()` call is itself now timeout-bounded like every other call in the file.
- `AuthGuard`: `handleCapabilityUnavailable` (renamed in spirit, not in code, from the old shared callback) is wired ONLY from `MfaEnrollmentRequired`, and ONLY affects row 6. It arms a **userId-scoped** cooldown (`src/lib/mfaCapabilityCooldown.ts`, keyed by `sessionStorage` + a module map, one entry per user) and a local `mfaCapabilityUnavailable` flag consulted ONLY inside row 6, calls `markBypassed()` (see `useMfaAssurance`'s doc comment — enrollment-path-only now), fires a Sentry `mfa_capability_unavailable` message (`{code, path}` tags only, never PII) and a ONE-SHOT `toast.warning`. **CONFIRMED bypass fixed by R17:** the cooldown used to be a single global flag checked BEFORE the challenge row, so on a shared browser the NEXT user to sign in — a DIFFERENT person, with their OWN verified factor — could inherit a still-active cooldown from the PREVIOUS user's enrollment-path outage trip and skip `MfaChallenge` entirely. Per-userId keying plus row 6 never gating row 5 closes this two ways at once. `useAuth.ts`'s `signOut()` also clears the current user's cooldown before the redirect (R17c), and `AuthGuard` re-derives the cooldown flag on any user change within the same mounted instance (R17d).
- **The row-6 fail-open bypass remains an ACCEPTED PHASE-1 TRADE-OFF (CTO ruling A4-7)**, now scoped correctly to enrollment only. The Sentry emission makes a sustained or targeted bypass observable; **SCRUM-3593 (aal2-aware RLS on platform-admin surfaces)** is the phase-2 control that closes it server-side.
- **R11 (efficiency, not security):** `useMfaAssurance` also gained an optional module-scope cache (keyed by `userId` + a caller-supplied `sessionKey`, which `AuthGuard` populates from `session.access_token`) so a route change that remounts `AuthGuard` renders synchronously from the last known result instead of re-awaiting `getAuthenticatorAssuranceLevel()` and flashing the spinner. Inert whenever no `sessionKey` is supplied — see that hook's own doc comment for why this can never weaken the EVERY-LOGIN ENFORCEMENT guarantee.

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
- **R22 (live E2E on the rig, confirmed against GoTrue by a direct probe):** removing a verified
  factor drops the session to aal1 on the next refresh (GoTrue), so the login-time challenge
  re-appears; this is intended. `unenroll()` of a factor verified in THIS session does not
  itself change `getAuthenticatorAssuranceLevel()`'s answer (it still reports aal2), but this
  component's own post-change `refreshSession()` call above IS the trigger that re-evaluates
  it — the refreshed JWT carries `aal: aal1` (with the remaining factor's `nextLevel: aal2`),
  and `AuthGuard`'s live re-check correctly, fail-closed-ly swaps Settings for `MfaChallenge`
  right there. `e2e/mfa-enrollment-and-challenge.spec.ts`'s backup-authenticator test handles
  this by waiting for either the settings list or the challenge screen after a Remove, and
  completing the challenge with the surviving factor if it appears.
- After a successful verify (new or backup factor) or a successful unenroll, calls
  `supabase.auth.refreshSession()` (Amendment A4-8) so the JWT `aal` claim other code in the app
  reads (`useMfaAssurance`, in this same file's AuthGuard entry above) is current in this session
  without waiting for a natural token refresh.

**R1/R2/R3/R4/R9/R20 (PR #2637 review round 2 — this component and `MfaEnrollmentRequired.tsx`
were hardened in the SAME batch as the fail-closed `AuthGuard`/`MfaChallenge` rewrite above, not
by a separate stream):**
- **R2:** all six `supabase.auth.mfa.*` calls (`listFactors`, `enroll`, `unenroll`, `challenge`,
  `verify`, `challengeAndVerify`) now race against `withTimeout`, matching `MfaChallenge.tsx`/
  `MfaEnrollmentRequired.tsx`. `handleVerify`/`handleStepUpSubmit` route their outcomes through
  the shared `classifyMfaError` (`@/lib/mfaErrors`): a wrong-code rejection keeps
  `ERROR_STEP_UP_FAILED` ("that code did not match"); anything else (a platform failure, rate
  limit, thrown exception, timeout) shows `ERROR_GENERIC` instead of misleadingly implying the
  user mistyped their code. `performEnroll`/`performUnenroll` keep the private `authErrorCode()`
  helper directly — `insufficient_aal`/`mfa_factor_name_conflict`/`mfa_verified_factor_exists`
  are enrollment-management codes `classifyMfaError` deliberately does not cover.
- **R1 (real bug):** `refreshFactors()` had no try/catch and no timeout at all — a rejected or
  hung `listFactors()` left the card stuck on its loading spinner forever. A new `'error'` view
  state (`twofactor-load-error` + `twofactor-load-retry`) now covers that case.
- **R4 (live E2E rig failure):** the factor-list container's testid was renamed from
  `twofactor-factor-list` to **`twofactor-factors`** — it collided with
  `e2e/mfa-enrollment-and-challenge.spec.ts`'s prefix locator
  `[data-testid^="twofactor-factor-"]` (meant to match only the per-row `twofactor-factor-<id>`
  testids), inflating a `toHaveCount(2)` assertion to 3.
- **R9:** the default friendly name's random suffix comes from `crypto.randomUUID().slice(0, 8)`
  (computed on its own statement, not inlined into the template literal —
  `npm run lint:copy`'s scanner treats a whole backtick template as user-facing copy and would
  otherwise false-positive on the API name). The old `randomSuffixHex()` helper module under
  `src/lib/` is deleted.
- **R20 (in `MfaEnrollmentRequired.tsx`, not this file):** the orphan-factor cleanup for a
  late-resolving `enroll()` fires on ANY unmount now, not just its original timeout race — see
  the AuthGuard entry above.

**Test ids:** `twofactor-factors` (renamed from `twofactor-factor-list`, R4), `twofactor-factor-<id>`,
`twofactor-remove-<id>`, `twofactor-enable`, `twofactor-add-backup`, `twofactor-friendly-name`
(read-only display of the name actually sent to `enroll()` — editing it does nothing; the name is
fixed at enroll time), `twofactor-qr`, `twofactor-secret`, `twofactor-verify-code`,
`twofactor-verify-submit`, `twofactor-error`, `twofactor-load-error`, `twofactor-load-retry`,
`twofactor-unavailable`, `twofactor-stepup`, `twofactor-stepup-code`, `twofactor-stepup-submit`,
`twofactor-stepup-cancel`. Consumed by `e2e/mfa-enrollment-and-challenge.spec.ts` (`e2e/agents.md`)
via `e2e/helpers/mfa.ts`'s `readSecretFromSettings` + `e2e/helpers/totp.ts`.

**Do NOT** assume `factor.friendly_name` is always present — it's optional in the SDK type
(prod has at least one legacy factor without one); the list falls back to
`TWO_FACTOR_SETUP_LABELS.UNNAMED_FACTOR`. **Do NOT** re-add an `organizations.hipaa_mfa_required`
query here — Amendment A4-3 dropped org-level enforcement from Phase 1 entirely; that lives only
in `useMfaEnrollmentRequirement` (this same folder's AuthGuard entry above), and even there it's
currently unused pending a Phase 2 audited RPC.
