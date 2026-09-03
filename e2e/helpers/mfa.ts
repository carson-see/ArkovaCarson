/**
 * MFA E2E helpers (SCRUM-3167 / SCRUM-3584).
 *
 * `createDisposableUser` / `deleteDisposableUser` follow the same
 * `withProfileSession` idiom as `e2e/helpers/profile-session.ts` — an
 * explicit `profiles` upsert after `auth.admin.createUser()`, never assuming
 * an `auth.users` trigger populates the row. Unlike `createProfileSession`
 * (which injects a session directly into `storageState` for speed),
 * `loginViaUi` drives the real `/login` form: these specs exercise the
 * AuthGuard MFA gate, which only runs on a real UI login.
 */

import type { Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SEED_USERS } from '../fixtures/supabase';
import { uniqueTestId } from './unique';

export const MFA_ENFORCE_DATE_OVERRIDE_KEY = 'arkova_mfa_enforce_from_override';

export interface DisposableUserOptions {
  role: 'INDIVIDUAL' | 'ORG_ADMIN';
  orgId?: string | null;
  emailPrefix?: string;
  fullName?: string;
}

export interface DisposableUser {
  userId: string;
  email: string;
  password: string;
}

/**
 * Create a throwaway auth user + profile for an MFA spec. Reuses the shared
 * E2E seed password (same pattern as `createProfileSession` and
 * `auth.spec.ts`'s sign-out test) so `loginViaUi` can drive a real login.
 *
 * Caller owns cleanup via `deleteDisposableUser` (prefer try/finally, per
 * the `withProfileSession` idiom this mirrors) — never touch seed users'
 * factors or profiles.
 */
export async function createDisposableUser(
  serviceClient: SupabaseClient,
  options: DisposableUserOptions,
): Promise<DisposableUser> {
  const email = `${uniqueTestId(options.emailPrefix ?? 'e2e-mfa')}@test.arkova.io`;
  const password = SEED_USERS.individual.password;
  const fullName = options.fullName ?? 'E2E MFA User';

  const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createError || !created.user) {
    throw new Error(`Failed to create disposable MFA test user: ${createError?.message}`);
  }

  const userId = created.user.id;

  // Explicit upsert — do NOT assume an auth.users trigger populates profiles.
  const { error: profileError } = await serviceClient
    .from('profiles')
    .upsert({
      id: userId,
      email,
      full_name: fullName,
      role: options.role,
      org_id: options.orgId ?? null,
      is_public_profile: false,
      is_platform_admin: false,
      disclaimer_accepted_at: new Date().toISOString(),
    });

  if (profileError) {
    await serviceClient.auth.admin.deleteUser(userId);
    throw new Error(`Failed to prepare disposable MFA test profile: ${profileError.message}`);
  }

  return { userId, email, password };
}

/** Best-effort cleanup — never throws, so it is safe in a `finally` block. */
export async function deleteDisposableUser(
  serviceClient: SupabaseClient,
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;

  const { error } = await serviceClient.auth.admin.deleteUser(userId);
  if (error) {
    // Cleanup failures shouldn't fail the test, but should stay visible —
    // a swallowed cleanup failure is exactly how test data accumulates.
    console.warn(`[e2e/helpers/mfa] failed to delete disposable user ${userId}: ${error.message}`);
  }
}

/**
 * Drive the real `/login` form (not a storageState injection) — these specs
 * exercise the AuthGuard MFA gate, which only evaluates on an actual login.
 * Uses the same `#email` / `#password` ID locators as `e2e/auth.setup.ts`
 * (not `getByLabel` — see that file's header for why).
 *
 * Does not assert on the post-submit destination: depending on the scenario
 * under test, that may be the app, the `mfa-challenge` screen, or the
 * `mfa-enrollment-required` screen. The caller asserts the expected outcome.
 */
export async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * Register a non-production enforcement-date override in `localStorage`
 * BEFORE the app loads, via `page.addInitScript` (so it is present for the
 * very first navigation, not raced against app boot). Honoured by
 * `src/lib/mfaPolicy.ts` (branch `security/mfa-enforcement-3167`) only in
 * dev/CI builds — see that module for the exact gating condition.
 *
 * `iso` must be a full UTC timestamp, e.g. `2099-01-01T00:00:00Z`.
 */
export async function setEnforceDateOverride(page: Page, iso: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: MFA_ENFORCE_DATE_OVERRIDE_KEY, value: iso },
  );
}

/**
 * Read the manual-entry TOTP secret currently shown by `TwoFactorSetup`'s
 * enrollment panel at `/settings` (`data-testid="twofactor-secret"`).
 * Caller is responsible for having already navigated to `/settings` and
 * clicked the enable/add-backup button so the panel is mounted.
 */
export async function readSecretFromSettings(page: Page): Promise<string> {
  const secretLocator = page.getByTestId('twofactor-secret');
  await secretLocator.waitFor({ state: 'visible', timeout: 10_000 });
  const text = await secretLocator.innerText();
  return text.trim();
}
