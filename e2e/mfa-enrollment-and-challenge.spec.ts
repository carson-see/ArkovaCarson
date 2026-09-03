/**
 * MFA enrollment + login challenge — SCRUM-3167 / SCRUM-3584
 *
 * NOT VERIFIED IN THIS SESSION — Playwright cannot run here (no dev
 * server / local Supabase stack available to this agent; another session
 * owns the local stack per CLAUDE.md). Written TDD-style against the agreed
 * contract with the sibling branch `security/mfa-enforcement-3167`
 * (AuthGuard / MfaChallenge / MfaEnrollmentRequired / MfaGraceNudge /
 * mfaPolicy) — test ids `mfa-challenge*`, `mfa-enrollment-required`,
 * `mfa-enrollment-qr/secret/code/submit`, `mfa-grace-nudge*`, and the
 * `arkova_mfa_enforce_from_override` localStorage override key. The CTO runs
 * this at integration once both branches land.
 *
 * FULLY SELF-CONTAINED — no `SEED_USERS`, no `.auth/*.json` storageState.
 * The MFA-3167 soak rig (`fizyjojbebyalirtjjht`) has none of the usual seed
 * users (`demo-admin@arkova.local` / `demo-user@arkova.local` /
 * `sarah@arkova.ai` are absent there), so every scenario below creates its
 * own disposable user via the service client and logs in through the real
 * `/login` UI (`loginViaUi`) rather than depending on seeded credentials or
 * a saved session. `test.use({ storageState: { cookies: [], origins: [] } })`
 * below means this spec never reads the `setup` project's `.auth/*.json`
 * either. Item 36 (PR #2637 review) — precisely: `playwright.config.ts`'s
 * checked-in projects ALL declare `dependencies: ['setup']`, so in CI this
 * spec still runs under the `setup` project and pays for seed-user logins
 * it never uses (harmless, just wasted setup time — it never READS
 * `.auth/*.json` regardless, per the empty storageState override above).
 * Against a rig with no seed users at all (e.g. the MFA-3167 soak rig),
 * run with a config whose project has `dependencies: []` instead — the
 * soak harness ships one outside this repo; no such project exists here.
 *
 * Covers:
 *  (a) an INDIVIDUAL enrolls TOTP in Settings, then completes the SAME
 *      factor as a login challenge on the next sign-in;
 *  (b) a disposable ORG_ADMIN (own throwaway `organizations` row — see
 *      `createDisposableOrg`, needed because `RouteGuard` sends an
 *      org-id-less ORG_ADMIN to `/onboarding/org` instead of `/dashboard`)
 *      sees the dismissible grace nudge before the enforcement date and
 *      still reaches the app;
 *  (c) a disposable ORG_ADMIN past the enforcement date hits the hard
 *      `MfaEnrollmentRequired` screen and can complete it — proves the
 *      block is a real onboarding step, not a dead end;
 *  (d) a user with one verified factor adds a second "backup" factor and
 *      removes it again, handling the AAL2 step-up prompt if GoTrue asks
 *      for one.
 *
 * Every test creates and tears down its own disposable user (and, for (b),
 * its own disposable org) in a `finally` block, per
 * `e2e/helpers/profile-session.ts`'s `withProfileSession` idiom.
 */

import { test, expect, getServiceClient } from './fixtures';
import { acceptDisclaimerIfVisible } from './helpers/dashboard';
import { totp, base32Decode } from './helpers/totp';
import {
  createDisposableUser,
  deleteDisposableUser,
  createDisposableOrg,
  deleteDisposableOrg,
  loginViaUi,
  setEnforceDateOverride,
  readSecretFromSettings,
  submitTotpCodeWithBoundaryRetry,
} from './helpers/mfa';
import { TWO_FACTOR_SETUP_LABELS } from '../src/lib/copy';

// These specs drive multiple real logins as different (and disposable)
// users. The project-level seed-user storageState would otherwise redirect
// an already-authenticated context away from /login before the form even
// renders — see auth.spec.ts for the same override.
test.use({ storageState: { cookies: [], origins: [] } });

// Runs each scenario in a fixed order — easier to debug at integration than
// interleaved output, and there is no correctness reason for them to race.
test.describe.configure({ mode: 'serial' });

const APP_URL_PATTERN = /\/(dashboard|onboarding|vault)/;

test.describe('totp helper (RFC 6238 vectors)', () => {
  // RFC 6238 Appendix B, SHA-1 row. Secret is ASCII "12345678901234567890",
  // base32-encoded. Proven once against the reference scratchpad helper
  // before e2e/helpers/totp.ts was ported from it; re-asserted here so a
  // future edit to the helper cannot silently break every MFA spec that
  // depends on it computing a real code.
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // gitleaks:allow — public RFC 6238 Appendix B test vector, not a credential

  test('matches the RFC 6238 Appendix B SHA-1 test vectors', () => {
    expect(totp(RFC_SECRET, { now: 59 * 1000 })).toBe('287082');
    expect(totp(RFC_SECRET, { now: 59 * 1000, digits: 8 })).toBe('94287082');
    expect(totp(RFC_SECRET, { now: 1_111_111_109 * 1000, digits: 8 })).toBe('07081804');
  });

  test('base32Decode round-trips the RFC secret to its ASCII bytes', () => {
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
  });
});

test.describe('MFA enrollment and login challenge', () => {
  test('individual enrolls TOTP in Settings, then completes it again at the next login', async ({ page }) => {
    const serviceClient = getServiceClient();
    const fullName = 'E2E MFA Individual';
    let userId: string | null = null;

    try {
      const user = await createDisposableUser(serviceClient, {
        role: 'INDIVIDUAL',
        emailPrefix: 'e2e-mfa-individual',
        fullName,
      });
      userId = user.userId;

      await loginViaUi(page, user.email, user.password);
      await page.waitForURL(APP_URL_PATTERN, { timeout: 15_000 });
      await acceptDisclaimerIfVisible(page);

      await page.goto('/settings');
      await page.getByTestId('twofactor-enable').click();

      const secret = await readSecretFromSettings(page);
      await submitTotpCodeWithBoundaryRetry(page, secret, {
        codeTestId: 'twofactor-verify-code',
        submitTestId: 'twofactor-verify-submit',
        errorTestId: 'twofactor-error',
      });

      await expect(page.getByText(TWO_FACTOR_SETUP_LABELS.STATUS_ENABLED)).toBeVisible({ timeout: 10_000 });

      // Sign out (disposable user — safe to end its own session) and sign
      // back in: the fresh aal1 session must now be challenged.
      await page.getByRole('button', { name: new RegExp(fullName, 'i') }).click();
      await page
        .getByRole('menuitem', { name: 'Sign out' })
        .or(page.getByRole('button', { name: 'Sign out' }))
        .click();
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

      await loginViaUi(page, user.email, user.password);

      await expect(page.getByTestId('mfa-challenge')).toBeVisible({ timeout: 15_000 });
      await submitTotpCodeWithBoundaryRetry(page, secret, {
        codeTestId: 'mfa-challenge-code',
        submitTestId: 'mfa-challenge-submit',
        errorTestId: 'mfa-challenge-error',
      });

      await page.waitForURL(APP_URL_PATTERN, { timeout: 15_000 });
      await acceptDisclaimerIfVisible(page);
      await expect(page.getByTestId('mfa-challenge')).toBeHidden();
    } finally {
      await deleteDisposableUser(serviceClient, userId);
    }
  });

  test('a disposable ORG_ADMIN sees the dismissible grace nudge before the enforcement date and still reaches the app', async ({ page }) => {
    const serviceClient = getServiceClient();
    let userId: string | null = null;
    let orgId: string | null = null;

    try {
      // RouteGuard sends an ORG_ADMIN with no org_id to /onboarding/org, not
      // /dashboard — this spec needs the real app to assert #main-content
      // and the nudge together, so it needs a real (throwaway) org.
      const org = await createDisposableOrg(serviceClient, { namePrefix: 'e2e-mfa-grace-org' });
      orgId = org.orgId;

      const user = await createDisposableUser(serviceClient, {
        role: 'ORG_ADMIN',
        orgId,
        emailPrefix: 'e2e-mfa-grace',
      });
      userId = user.userId;

      // Far-future override: this must hold regardless of the real wall-clock
      // date relative to the 2026-09-21 default.
      await setEnforceDateOverride(page, '2099-01-01T00:00:00Z');

      await loginViaUi(page, user.email, user.password);
      await page.waitForURL(APP_URL_PATTERN, { timeout: 15_000 });
      await acceptDisclaimerIfVisible(page);

      // Grace, not a block: the nudge shows AND the app content is reachable.
      await expect(page.getByTestId('mfa-grace-nudge')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#main-content')).toBeVisible();

      await page.getByTestId('mfa-grace-nudge-dismiss').click();
      await expect(page.getByTestId('mfa-grace-nudge')).toBeHidden();

      // Dismissal is sessionStorage-backed (per-session, not per-visit) — it
      // must survive a reload of the same tab.
      await page.reload();
      await expect(page.getByTestId('mfa-grace-nudge')).toBeHidden();
    } finally {
      // Delete the user first — profiles.id cascades on auth.users delete,
      // so the org has no remaining referencing row by the time it's deleted.
      await deleteDisposableUser(serviceClient, userId);
      await deleteDisposableOrg(serviceClient, orgId);
    }
  });

  test('a disposable ORG_ADMIN past the enforcement date must enroll before entering, and can', async ({ page }) => {
    const serviceClient = getServiceClient();
    let userId: string | null = null;

    try {
      const user = await createDisposableUser(serviceClient, {
        role: 'ORG_ADMIN',
        emailPrefix: 'e2e-mfa-required',
      });
      userId = user.userId;

      // Past override: proves the hard-block screen, not just the grace path.
      await setEnforceDateOverride(page, '2020-01-01T00:00:00Z');
      await loginViaUi(page, user.email, user.password);

      await expect(page.getByTestId('mfa-enrollment-required')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('mfa-enrollment-qr')).toBeVisible();

      const secret = (await page.getByTestId('mfa-enrollment-secret').innerText()).trim();
      await submitTotpCodeWithBoundaryRetry(page, secret, {
        codeTestId: 'mfa-enrollment-code',
        submitTestId: 'mfa-enrollment-submit',
        errorTestId: 'mfa-enrollment-error',
      });

      // The block is completable — it must release into the real app, not
      // just accept the code and stay parked.
      await page.waitForURL(APP_URL_PATTERN, { timeout: 15_000 });
      await acceptDisclaimerIfVisible(page);
      await expect(page.getByTestId('mfa-enrollment-required')).toBeHidden();
    } finally {
      await deleteDisposableUser(serviceClient, userId);
    }
  });

  test('a user with one verified factor can add and remove a backup authenticator', async ({ page }) => {
    const serviceClient = getServiceClient();
    let userId: string | null = null;

    try {
      const user = await createDisposableUser(serviceClient, {
        role: 'INDIVIDUAL',
        emailPrefix: 'e2e-mfa-backup',
      });
      userId = user.userId;

      await loginViaUi(page, user.email, user.password);
      await page.waitForURL(APP_URL_PATTERN, { timeout: 15_000 });
      await acceptDisclaimerIfVisible(page);

      await page.goto('/settings');
      await page.getByTestId('twofactor-enable').click();
      const firstSecret = await readSecretFromSettings(page);
      await submitTotpCodeWithBoundaryRetry(page, firstSecret, {
        codeTestId: 'twofactor-verify-code',
        submitTestId: 'twofactor-verify-submit',
        errorTestId: 'twofactor-error',
      });
      await expect(page.getByTestId('twofactor-add-backup')).toBeVisible({ timeout: 10_000 });

      // Verifying a newly-enrolled factor elevates THIS session to aal2
      // immediately (GoTrue behaviour), so add-backup should not need a
      // step-up here — but handle it anyway rather than coupling the spec
      // to that internal timing (Amendment A3: insufficient_aal on enroll
      // shows the inline step-up form).
      await page.getByTestId('twofactor-add-backup').click();
      if (await page.getByTestId('twofactor-stepup').isVisible({ timeout: 2_000 }).catch(() => false)) {
        await submitTotpCodeWithBoundaryRetry(page, firstSecret, {
          codeTestId: 'twofactor-stepup-code',
          submitTestId: 'twofactor-stepup-submit',
          errorTestId: 'twofactor-error',
        });
      }

      await expect(page.getByTestId('twofactor-qr')).toBeVisible({ timeout: 10_000 });
      const backupFriendlyName = await page.getByTestId('twofactor-friendly-name').inputValue();
      const backupSecret = await readSecretFromSettings(page);
      await submitTotpCodeWithBoundaryRetry(page, backupSecret, {
        codeTestId: 'twofactor-verify-code',
        submitTestId: 'twofactor-verify-submit',
        errorTestId: 'twofactor-error',
      });

      await expect(page.locator('[data-testid^="twofactor-factor-"]')).toHaveCount(2, { timeout: 10_000 });

      const backupRow = page
        .locator('[data-testid^="twofactor-factor-"]')
        .filter({ hasText: backupFriendlyName });
      await backupRow.getByRole('button', { name: TWO_FACTOR_SETUP_LABELS.REMOVE_ACTION }).click();

      if (await page.getByTestId('twofactor-stepup').isVisible({ timeout: 2_000 }).catch(() => false)) {
        await submitTotpCodeWithBoundaryRetry(page, firstSecret, {
          codeTestId: 'twofactor-stepup-code',
          submitTestId: 'twofactor-stepup-submit',
          errorTestId: 'twofactor-error',
        });
      }

      // R22/R25 (live E2E on the rig at 32b10aef5 and 7a75bdd04; confirmed
      // against GoTrue by probe-unenroll-aal.mjs): unenroll() of a factor
      // verified THIS session drops the session's AAL from aal2 to aal1 on
      // the NEXT refreshSession() — getAuthenticatorAssuranceLevel() still
      // reports aal2 until then, but TwoFactorSetup's post-change
      // refreshSession() call is exactly that trigger, so AuthGuard's live
      // re-check correctly (fail-closed) swaps Settings for the login
      // challenge right here. That is the intended security behaviour (see
      // AuthGuard.tsx/MfaChallenge.tsx), not a bug.
      //
      // R25: the settings list is still visible for a moment right after
      // Remove — the swap only happens once refreshSession() resolves and
      // AuthGuard's re-check runs — so a Promise.race against BOTH
      // testids was non-deterministic: it could resolve on the still-
      // visible list before the challenge ever appears, skip the challenge
      // branch entirely, and then run the count assertion against the
      // (about to disappear) settings page. Wait ONLY for the challenge
      // testid instead — it is the expected outcome per the GoTrue probe
      // above — and treat a timeout as "this platform did not downgrade"
      // rather than a failure.
      await page
        .getByTestId('mfa-challenge-code')
        .waitFor({ state: 'visible', timeout: 20_000 })
        .catch(() => {});
      if (await page.getByTestId('mfa-challenge-code').isVisible().catch(() => false)) {
        await submitTotpCodeWithBoundaryRetry(page, firstSecret, {
          codeTestId: 'mfa-challenge-code',
          submitTestId: 'mfa-challenge-submit',
          errorTestId: 'mfa-challenge-error',
        });
      }

      await expect(page.locator('[data-testid^="twofactor-factor-"]')).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await deleteDisposableUser(serviceClient, userId);
    }
  });
});
