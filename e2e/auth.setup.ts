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
 *     setup fails fast (≤15s) on a real auth error instead of timing
 *     out at 30s and burning CI minutes.
 *   - Verify the storageState file was actually written and contains
 *     a Supabase session — catches silent state-save failures.
 *
 * @created 2026-04-26
 * @updated 2026-04-28 — SCRUM-1302 follow-up hardening
 */

import { test as setup, expect } from '@playwright/test';
import { SEED_USERS } from './fixtures/supabase';
import fs from 'fs';

const STORAGE_DIR = '.auth';
const POST_LOGIN_URL_PATTERN =
  /\/(vault|dashboard|onboarding|organization|records|settings|review-pending)/;
const LOGIN_FAILURE_TIMEOUT_MS = 15_000;

// Ensure storage directory exists (idempotent)
fs.mkdirSync(STORAGE_DIR, { recursive: true });

/**
 * Shared login helper — navigates to /login, fills credentials, races
 * post-submit redirect against any error toast, and saves storageState.
 */
async function loginAndSave(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
  storagePath: string,
) {
  await page.goto('/login');

  // Use ID locators (not getByLabel) — see file header on why.
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);

  // Race the success-URL navigation against an error-message surface so
  // a bad seed credential fails the setup at ≤15s instead of 30s.
  const successPromise = page.waitForURL(POST_LOGIN_URL_PATTERN, {
    timeout: LOGIN_FAILURE_TIMEOUT_MS,
  });
  const errorPromise = page
    .getByRole('alert')
    .filter({ hasText: /invalid|incorrect|wrong/i })
    .waitFor({ state: 'visible', timeout: LOGIN_FAILURE_TIMEOUT_MS })
    .then(() => 'error' as const)
    .catch(() => 'no-error' as const);

  await page.getByRole('button', { name: 'Sign in' }).click();

  const result = await Promise.race([
    successPromise.then(() => 'success' as const),
    errorPromise,
  ]);

  if (result === 'error') {
    const toastText = await page.getByRole('alert').first().innerText().catch(() => '');
    throw new Error(
      `Login failed for ${email}: server returned an error toast (${toastText.trim() || 'no text'}). ` +
      'Verify the seed user was created by `supabase db reset` and that E2E_SEED_PASSWORD ' +
      'matches the seed.sql password.',
    );
  }

  // Belt-and-suspenders: confirm we're not parked on /login or /auth.
  await expect(page).not.toHaveURL(/\/(login|auth)(\/|$)/);

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
}

// ── Setup tests — one per distinct seed user ──────────────────────────

setup('authenticate as individual (carson)', async ({ page }) => {
  await loginAndSave(
    page,
    SEED_USERS.individual.email,
    SEED_USERS.individual.password,
    `${STORAGE_DIR}/individual.json`,
  );
});

setup('authenticate as orgBAdmin (sarah)', async ({ page }) => {
  await loginAndSave(
    page,
    SEED_USERS.orgBAdmin.email,
    SEED_USERS.orgBAdmin.password,
    `${STORAGE_DIR}/orgBAdmin.json`,
  );
});
