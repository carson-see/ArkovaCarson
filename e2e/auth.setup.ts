/**
 * Authentication Setup — Playwright Global Setup Project
 *
 * Runs once before all test projects. Logs in each seed user via the UI
 * and saves the authenticated browser state (cookies + localStorage) to
 * JSON files under `.auth/`. Test projects then reuse these files via
 * `storageState`, eliminating the per-test login overhead that caused
 * the SCRUM-1302 timeout regression.
 *
 * Hardening (SCRUM-1302 follow-ups):
 *   - Use #email / #password ID locators instead of getByLabel — the
 *     LoginForm renders a `Forgot password?` toggle whose modal also
 *     carries an "Email address" label, so getByLabel would fail strict
 *     mode whenever the toggle had been clicked in a prior test session
 *     and React reused the same hydrated DOM.
 *   - Race the post-submit redirect against any login-error toast so the
 *     setup fails fast (<=15s) on a real auth error instead of timing
 *     out at 30s and burning CI minutes.
 *   - Verify the storageState file was actually written and contains
 *     a Supabase session — catches silent state-save failures.
 *   - UAT-04: complete real TOTP enrollment before saving state, so every
 *     reused browser session carries signed AAL2 authority.
 *
 * @created 2026-04-26
 * @updated 2026-04-28 — SCRUM-1302 follow-up hardening
 * @updated 2026-09-03 — SCRUM-3167/3584 MFA enforcement-date override injection
 */

import { test as setup, expect, errors as playwrightErrors } from '@playwright/test';
import fs from 'fs';
import { getServiceClient, SEED_USERS } from './fixtures/supabase';
import { acceptDisclaimerIfVisible } from './helpers/dashboard';
import { submitTotpCodeWithBoundaryRetry } from './helpers/mfa';

const STORAGE_DIR = '.auth';
const POST_LOGIN_URL_PATTERN =
  /\/(vault|dashboard|onboarding|organization|records|settings|review-pending)/;
const LOGIN_FAILURE_TIMEOUT_MS = 15_000;
const serviceClient = getServiceClient();

interface StorageStateFile {
  origins?: Array<{
    origin?: string;
    localStorage?: Array<{
      name?: string;
      value?: string;
    }>;
  }>;
}

// Ensure storage directory exists (idempotent)
fs.mkdirSync(STORAGE_DIR, { recursive: true });

async function markDisclaimerAccepted(userId: string) {
  const { error } = await serviceClient
    .from('profiles')
    .update({ disclaimer_accepted_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) {
    throw new Error(`Failed to prepare E2E seed user ${userId}: ${error.message}`);
  }
}

function storageStateHasSupabaseSession(storagePath: string): boolean {
  const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as StorageStateFile;
  return (parsed.origins ?? []).some((origin) =>
    (origin.localStorage ?? []).some((entry) =>
      typeof entry.name === 'string' &&
      entry.name.startsWith('sb-') &&
      entry.name.includes('auth-token') &&
      typeof entry.value === 'string' &&
      entry.value.includes('access_token'),
    ),
  );
}

function storageStateHasAal2Session(storagePath: string, userId: string): boolean {
  const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as StorageStateFile;
  for (const origin of parsed.origins ?? []) {
    for (const entry of origin.localStorage ?? []) {
      if (!entry.name?.startsWith('sb-') || !entry.name.includes('auth-token') || !entry.value) continue;
      try {
        const session = JSON.parse(entry.value) as { access_token?: string };
        const encoded = session.access_token?.split('.')[1];
        if (!encoded) continue;
        const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (claims.sub === userId && claims.aal === 'aal2' && claims.role === 'authenticated') return true;
      } catch {
        // Keep searching other persisted entries.
      }
    }
  }
  return false;
}

async function clearSeedMfaFactors(userId: string): Promise<void> {
  const { data, error } = await serviceClient.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error(`Failed to list E2E MFA factors for ${userId}: ${error.message}`);
  for (const factor of data?.factors ?? []) {
    const deleted = await serviceClient.auth.admin.mfa.deleteFactor({ userId, id: factor.id });
    if (deleted.error) throw new Error(`Failed to reset E2E MFA factor ${factor.id}: ${deleted.error.message}`);
  }
}

/**
 * Shared login helper — navigates to /login, fills credentials, races
 * post-submit redirect against any error toast, accepts the dashboard
 * disclaimer when visible, and saves storageState.
 */
async function loginAndSave(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
  userId: string,
  storagePath: string,
) {
  await clearSeedMfaFactors(userId);
  await page.goto('/login');

  // Use ID locators (not getByLabel) — see file header on why.
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);

  // Race the success-URL navigation against any error-message surface so
  // a bad seed credential fails the setup at <=15s instead of 30s.
  //
  // Important: page.waitForURL rejects with playwright.errors.TimeoutError
  // on its own timeout. Promise.race settles on the first SETTLED promise
  // (resolved OR rejected), so an unhandled successPromise rejection would
  // throw out of Promise.race before any other arm wins. Catch the
  // TimeoutError specifically and convert it into the same controlled
  // 'timeout' shape; rethrow anything else so genuine bugs surface.
  const successPromise = page
    .waitForURL(POST_LOGIN_URL_PATTERN, { timeout: LOGIN_FAILURE_TIMEOUT_MS })
    .then(() => ({ type: 'success' as const }))
    .catch((err: unknown) => {
      if (err instanceof playwrightErrors.TimeoutError) {
        return { type: 'timeout' as const };
      }
      throw err;
    });
  const alert = page.getByRole('alert').first();
  // The error watcher's own waitFor timeout is fine to swallow — the
  // successPromise above now owns the timeout fallback shape.
  const never = new Promise<never>(() => undefined);
  const errorPromise = alert
    .waitFor({ state: 'visible', timeout: LOGIN_FAILURE_TIMEOUT_MS })
    .then(async () => ({
      type: 'error' as const,
      message: (await alert.innerText().catch(() => '')).trim(),
    }))
    .catch(() => never);

  await page.getByRole('button', { name: 'Sign in' }).click();

  // Two-arm race: success (or its TimeoutError → timeout) vs error toast.
  // The redundant `waitForTimeout` arm was removed because Promise.race
  // would have already settled when waitForURL rejected — keeping it
  // around could mask a real success-arm rejection by a fraction.
  const result = await Promise.race([successPromise, errorPromise]);

  if (result.type === 'error') {
    throw new Error(
      `Login failed for ${email}: server returned an error toast (${result.message || 'no text'}). ` +
      'Verify the seed user was created by `supabase db reset` and that E2E_SEED_PASSWORD ' +
      'matches the seed.sql password.',
    );
  }
  if (result.type === 'timeout') {
    throw new Error(
      `Login timed out for ${email}: neither post-login navigation nor an error toast appeared within ` +
      `${LOGIN_FAILURE_TIMEOUT_MS}ms. Check the auth API, seed user, and login UI.`,
    );
  }

  // Belt-and-suspenders: confirm we're not parked on /login or /auth.
  await expect(page).not.toHaveURL(/\/(login|auth)(\/|$)/);

  const enrollment = page.getByTestId('mfa-enrollment-required');
  await enrollment.waitFor({ state: 'visible', timeout: LOGIN_FAILURE_TIMEOUT_MS });
  const secret = (await page.getByTestId('mfa-enrollment-secret').innerText()).trim();
  await submitTotpCodeWithBoundaryRetry(page, secret, {
    codeTestId: 'mfa-enrollment-code',
    submitTestId: 'mfa-enrollment-submit',
    errorTestId: 'mfa-enrollment-error',
  });
  await expect(enrollment).toBeHidden();

  await page.waitForFunction(() =>
    Object.entries(localStorage).some(([key, value]) =>
      key.startsWith('sb-') &&
      key.includes('auth-token') &&
      typeof value === 'string' &&
      value.includes('access_token'),
    ),
    undefined,
    { timeout: LOGIN_FAILURE_TIMEOUT_MS },
  );

  await acceptDisclaimerIfVisible(page);
  await page.context().storageState({ path: storagePath });

  // Verify the file was actually written and contains a Supabase session.
  // A zero-length file (or one missing the sb-* cookie / localStorage key)
  // means the navigation completed but auth state never landed in the
  // browser context — usually a sign of a race between the form submit
  // and the supabase-js token persistence. Fail loudly here instead of
  // letting downstream specs silently run as anon and 401 on every API
  // call.
  const stat = fs.statSync(storagePath);
  if (stat.size < 100) {
    throw new Error(
      `storageState file ${storagePath} is suspiciously small (${stat.size} bytes). ` +
      'Browser context lost the auth state before save. Check supabase-js token ' +
      'persistence and the post-submit redirect race.',
    );
  }
  if (!storageStateHasSupabaseSession(storagePath)) {
    throw new Error(
      `storageState file ${storagePath} does not contain a Supabase auth token. ` +
      'Browser context lost the auth state before save. Check supabase-js token ' +
      'persistence and the post-submit redirect race.',
    );
  }
  if (!storageStateHasAal2Session(storagePath, userId)) {
    throw new Error(`storageState file ${storagePath} does not contain a same-user authenticated AAL2 token.`);
  }

}

// ── Setup tests — one per distinct seed user ──────────────────────────

setup('authenticate as individual (demo-user)', async ({ page }) => {
  await markDisclaimerAccepted(SEED_USERS.individual.id);
  await loginAndSave(
    page,
    SEED_USERS.individual.email,
    SEED_USERS.individual.password,
    SEED_USERS.individual.id,
    `${STORAGE_DIR}/individual.json`,
  );
});

setup('authenticate as orgAdmin (demo-admin)', async ({ page }) => {
  await markDisclaimerAccepted(SEED_USERS.orgAdmin.id);
  await loginAndSave(
    page,
    SEED_USERS.orgAdmin.email,
    SEED_USERS.orgAdmin.password,
    SEED_USERS.orgAdmin.id,
    `${STORAGE_DIR}/orgAdmin.json`,
  );
});

setup('authenticate as orgBAdmin (sarah)', async ({ page }) => {
  await markDisclaimerAccepted(SEED_USERS.orgBAdmin.id);
  await loginAndSave(
    page,
    SEED_USERS.orgBAdmin.email,
    SEED_USERS.orgBAdmin.password,
    SEED_USERS.orgBAdmin.id,
    `${STORAGE_DIR}/orgBAdmin.json`,
  );
});
