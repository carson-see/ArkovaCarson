/**
 * MFA enrollment + login challenge — SCRUM-3167 / SCRUM-3584
 *
 * Verified against the existing isolated MFA rig during PR #2637 closeout.
 * The original 12h UI window had three failures; the follow-up targeted
 * evidence exercises the corrected refresh race and async harness explicitly.
 * See the PR evidence block for the exact tested head and completed results.
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
  waitForMfaManagementOutcome,
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
  // Two real verifications can each require the next 30s RFC6238 step.
  // Per-action deadlines remain unchanged; reserve a budget for both flows.
  test.describe.configure({ timeout: 90_000 });
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
      // R26 (soak flake, 1-in-8 runs): signOut() hard-redirects via
      // `window.location.href = '/login'` — the URL-string assertion above
      // can pass while that navigation is still in flight, so the very
      // next loginViaUi's own page.goto('/login') can race it and throw
      // "Navigation to /login is interrupted by another navigation to
      // /login". page.waitForURL waits for the navigation itself to
      // settle, not just the URL string to match.
      await page.waitForURL(/\/login/, { timeout: 15_000 });

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

  test('a user with one verified factor can add and remove a backup authenticator', async ({ page }, testInfo) => {
    const serviceClient = getServiceClient();
    let userId: string | null = null;
    let browserAuth: { endpoint: string; apiKey: string } | null = null;
    page.on('request', (request) => {
      const url = new URL(request.url());
      const apiKey = request.headers().apikey;
      if (url.pathname.startsWith('/auth/v1/') && apiKey) browserAuth = { endpoint: url.origin, apiKey };
    });

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
      if (await waitForMfaManagementOutcome(page, 'twofactor-qr') === 'stepUp') {
        await submitTotpCodeWithBoundaryRetry(page, firstSecret, {
          codeTestId: 'twofactor-stepup-code',
          submitTestId: 'twofactor-stepup-submit',
          errorTestId: 'twofactor-error',
        });
      }

      await expect(page.getByTestId('twofactor-qr')).toBeVisible({ timeout: 10_000 });
      const backupFriendlyName = await page.getByTestId('twofactor-friendly-name').inputValue();
      const backupSecret = await readSecretFromSettings(page);
      // Reproduce the actual soak race deterministically: another browser tab
      // refreshes this same AAL2 session while the new backup QR is displayed.
      // GoTrue's real refresh response is delivered through auth-js's real
      // BroadcastChannel contract; no fake JWT or assertion bypass is involved.
      const authTarget = browserAuth as { endpoint: string; apiKey: string } | null;
      if (!authTarget) throw new Error('Browser auth request was not observed');
      await page.getByTestId('twofactor-qr').evaluate((element) => element.setAttribute('data-enrollment-marker', 'preserve-qr'));
      // A refresh within the same JWT issued-at second can return identical
      // bytes. Wait for the next minting interval so this exercises rotation.
      await page.waitForFunction((endpoint) => {
        const key = `sb-${new URL(endpoint).hostname.split('.')[0]}-auth-token`;
        const session = JSON.parse(localStorage.getItem(key) ?? 'null');
        const claims = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return Date.now() >= (claims.iat + 2) * 1_000;
      }, authTarget.endpoint, { timeout: 5_000 });
      const refresh = await page.evaluate(async ({ endpoint, apiKey }) => {
        const storageKey = `sb-${new URL(endpoint).hostname.split('.')[0]}-auth-token`;
        const current = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        if (!current?.refresh_token) throw new Error('Missing disposable user session');
        const response = await fetch(`${endpoint}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST', headers: { apikey: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: current.refresh_token }),
        });
        if (!response.ok) throw new Error(`Real session refresh failed: ${response.status}`);
        const refreshed = await response.json();
        const claims = (jwt: string) => JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const before = claims(current.access_token);
        const after = claims(refreshed.access_token);
        localStorage.setItem(storageKey, JSON.stringify(refreshed));
        const channel = new BroadcastChannel(storageKey);
        const receipt = new BroadcastChannel(storageKey);
        await new Promise<void>((resolve) => {
          receipt.onmessage = ({ data }) => {
            if (data.event === 'TOKEN_REFRESHED' && data.session.access_token === refreshed.access_token) resolve();
          };
          channel.postMessage({ event: 'TOKEN_REFRESHED', session: refreshed });
        });
        receipt.close();
        channel.close();
        return { status: response.status, sameSession: before.session_id === after.session_id, aal: after.aal, tokenChanged: current.access_token !== refreshed.access_token };
      }, authTarget);
      expect(refresh).toEqual({ status: 200, sameSession: true, aal: 'aal2', tokenChanged: true });
      // Assurance reads the refreshed session locally in auth-js; it does not
      // necessarily issue GET /user. Wait for React to paint the delivered event.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByTestId('twofactor-qr')).toHaveAttribute('data-enrollment-marker', 'preserve-qr');
      expect(await readSecretFromSettings(page)).toBe(backupSecret);
      await page.screenshot({
        path: testInfo.outputPath('backup-enrollment-after-refresh.png'),
        fullPage: true,
        mask: [page.getByTestId('twofactor-qr'), page.getByTestId('twofactor-secret')],
      });
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

      await expect.poll(async () =>
        await page.getByTestId('twofactor-stepup').isVisible() ||
        await page.getByTestId('mfa-challenge-code').isVisible() ||
        await page.locator('[data-testid^="twofactor-factor-"]').count() === 1,
      { timeout: 10_000 }).toBe(true);
      if (await page.getByTestId('twofactor-stepup').isVisible()) {
        await submitTotpCodeWithBoundaryRetry(page, firstSecret, {
          codeTestId: 'twofactor-stepup-code',
          submitTestId: 'twofactor-stepup-submit',
          errorTestId: 'twofactor-error',
        });
      }

      // Removing the factor verified by this session and refreshing it drops
      // GoTrue assurance to AAL1. Assert the gate returns before Settings is
      // usable, then satisfy it with the surviving authenticator.
      await expect(page.getByTestId('mfa-challenge-code')).toBeVisible({ timeout: 20_000 });
      await submitTotpCodeWithBoundaryRetry(page, firstSecret, {
        codeTestId: 'mfa-challenge-code',
        submitTestId: 'mfa-challenge-submit',
        errorTestId: 'mfa-challenge-error',
      });

      await expect(page.locator('[data-testid^="twofactor-factor-"]')).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await deleteDisposableUser(serviceClient, userId);
    }
  });

  test('an individual platform administrator must enroll after the deadline', async ({ page }) => {
    const serviceClient = getServiceClient();
    let userId: string | null = null;
    try {
      const user = await createDisposableUser(serviceClient, { role: 'INDIVIDUAL', emailPrefix: 'e2e-mfa-platform' });
      userId = user.userId;
      const grant = await serviceClient.rpc('admin_set_platform_admin', { p_user_id: userId, p_is_admin: true });
      expect(grant.error).toBeNull();
      const profile = await serviceClient.from('profiles').select('is_platform_admin').eq('id', userId).single();
      expect(profile.error).toBeNull();
      expect(profile.data?.is_platform_admin).toBe(true);
      await setEnforceDateOverride(page, '2020-01-01T00:00:00Z');
      await loginViaUi(page, user.email, user.password);
      await expect(page.getByTestId('mfa-enrollment-required')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#main-content')).toBeHidden();
      const secret = (await page.getByTestId('mfa-enrollment-secret').innerText()).trim();
      await submitTotpCodeWithBoundaryRetry(page, secret, {
        codeTestId: 'mfa-enrollment-code', submitTestId: 'mfa-enrollment-submit', errorTestId: 'mfa-enrollment-error',
      });
      await expect(page.getByTestId('mfa-enrollment-required')).toBeHidden();
      await expect(page.locator('#main-content')).toBeVisible({ timeout: 15_000 });
    } finally {
      await deleteDisposableUser(serviceClient, userId);
    }
  });

  for (const role of ['INDIVIDUAL', 'ORG_ADMIN'] as const) {
    test(`${role} cannot enter platform administration or read another organization's private profile`, async ({ page }) => {
      const serviceClient = getServiceClient();
      const userIds: string[] = [];
      const orgIds: string[] = [];
      let browserAuth: { endpoint: string; apiKey: string } | null = null;
      page.on('request', (request) => {
        const url = new URL(request.url());
        const apiKey = request.headers().apikey;
        if (url.pathname.startsWith('/auth/v1/') && apiKey) browserAuth = { endpoint: url.origin, apiKey };
      });
      try {
        const ownOrg = await createDisposableOrg(serviceClient);
        orgIds.push(ownOrg.orgId);
        const foreignOrg = await createDisposableOrg(serviceClient);
        orgIds.push(foreignOrg.orgId);
        const user = await createDisposableUser(serviceClient, { role, orgId: ownOrg.orgId, emailPrefix: 'e2e-mfa-denial' });
        userIds.push(user.userId);
        const foreign = await createDisposableUser(serviceClient, { role: 'ORG_ADMIN', orgId: foreignOrg.orgId, emailPrefix: 'e2e-mfa-foreign' });
        userIds.push(foreign.userId);
        await setEnforceDateOverride(page, '2099-01-01T00:00:00Z');
        await loginViaUi(page, user.email, user.password);
        await expect(page.locator('#main-content')).toBeVisible({ timeout: 15_000 });
        await page.goto('/admin/overview');
        await expect(page).toHaveURL(/\/dashboard(?:[/?#]|$)/, { timeout: 15_000 });
        await expect(page.locator('#main-content')).toBeVisible();
        const authTarget = browserAuth as { endpoint: string; apiKey: string } | null;
        if (!authTarget) throw new Error('Browser auth request was not observed');
        const reads = await page.evaluate(async ({ endpoint, apiKey, ownId, foreignId }) => {
          const key = `sb-${new URL(endpoint).hostname.split('.')[0]}-auth-token`;
          const session = JSON.parse(localStorage.getItem(key) ?? 'null');
          const read = async (id: string) => {
            const response = await fetch(`${endpoint}/rest/v1/profiles?select=id&id=eq.${id}`, {
              headers: { apikey: apiKey, Authorization: `Bearer ${session.access_token}` },
            });
            const data = await response.json();
            return { status: response.status, count: Array.isArray(data) ? data.length : -1 };
          };
          return { own: await read(ownId), foreign: await read(foreignId) };
        }, { ...authTarget, ownId: user.userId, foreignId: foreign.userId });
        expect(reads).toEqual({ own: { status: 200, count: 1 }, foreign: { status: 200, count: 0 } });
      } finally {
        for (const id of userIds) await deleteDisposableUser(serviceClient, id);
        for (const id of orgIds) await deleteDisposableOrg(serviceClient, id);
      }
    });
  }
});
