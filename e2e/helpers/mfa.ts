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
import { totp } from './totp';
import { MFA_ENFORCE_FROM_OVERRIDE_KEY } from '../../src/lib/mfaPolicy';

/**
 * R14 (PR #2637 review round 2): re-exported from `src/lib/mfaPolicy.ts`'s
 * own constant instead of a locally-duplicated string literal, so this
 * helper and the app can never drift on the key name.
 */
export const MFA_ENFORCE_DATE_OVERRIDE_KEY = MFA_ENFORCE_FROM_OVERRIDE_KEY;

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

/**
 * Create a throwaway `organizations` row for a disposable ORG_ADMIN.
 *
 * `RouteGuard` (`src/components/auth/RouteGuard.tsx`) sends ORG_ADMIN with a
 * NULL `org_id` to `/onboarding/org`, never `/dashboard` — so any spec that
 * needs a disposable ORG_ADMIN to actually land in the main app (not just
 * clear the AuthGuard/MFA gate) must give it a real org. Only `display_name`
 * / `legal_name` are NOT NULL with no default on `organizations`
 * (`supabase/migrations/00000000000000_baseline_at_main_HEAD.sql`); every
 * other column defaults safely (`hipaa_mfa_required` defaults `false`, so
 * this never triggers org-level MFA enforcement — Amendment A4-3 dropped
 * that from Phase 1 regardless).
 */
export async function createDisposableOrg(
  serviceClient: SupabaseClient,
  options: { namePrefix?: string } = {},
): Promise<{ orgId: string }> {
  const name = uniqueTestId(options.namePrefix ?? 'e2e-mfa-org');

  const { data, error } = await serviceClient
    .from('organizations')
    .insert({ display_name: name, legal_name: name })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create disposable MFA test org: ${error?.message}`);
  }

  return { orgId: data.id as string };
}

/**
 * Best-effort cleanup — never throws. Call AFTER `deleteDisposableUser` for
 * any user that referenced this org: `profiles.id` cascades on
 * `auth.users` delete (`profiles_id_fkey ... ON DELETE CASCADE`), so the
 * referencing profile row is already gone by the time this runs.
 */
export async function deleteDisposableOrg(
  serviceClient: SupabaseClient,
  orgId: string | null | undefined,
): Promise<void> {
  if (!orgId) return;

  const { error } = await serviceClient.from('organizations').delete().eq('id', orgId);
  if (error) {
    console.warn(`[e2e/helpers/mfa] failed to delete disposable org ${orgId}: ${error.message}`);
  }
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

// Item 23/A2-6 (PR #2637 review) — the RFC 6238 30-second step boundary is
// a real flake vector: a code computed right at the edge of a step can be
// stale by the time Playwright's fill()+click() round trip reaches the
// server, and GoTrue rejects it with `mfa_verification_failed`.
const TOTP_STEP_MS = 30_000;
const BOUNDARY_SAFETY_MARGIN_MS = 3_000;

/**
 * Compute a TOTP code for `secret`, nudging forward exactly one step if
 * "now" is within `BOUNDARY_SAFETY_MARGIN_MS` of the current step
 * boundary — a code computed that close to the edge is the one most likely
 * to go stale mid-submit. Deterministic (no randomness, no clock wait):
 * either the current step's code, or the NEXT step's, decided purely by
 * where "now" falls in the current 30s window.
 */
function computeTotpAvoidingBoundary(secret: string): string {
  const now = Date.now();
  const msIntoStep = now % TOTP_STEP_MS;
  const msUntilBoundary = TOTP_STEP_MS - msIntoStep;
  const effectiveNow = msUntilBoundary < BOUNDARY_SAFETY_MARGIN_MS ? now + TOTP_STEP_MS : now;
  return totp(secret, { now: effectiveNow });
}

/**
 * Fill a 6-digit TOTP code input and submit, guarding the 30s RFC 6238
 * step-boundary flake vector: computes the code as late as possible (right
 * before fill+submit) via `computeTotpAvoidingBoundary`, and if the server
 * still rejects it as a wrong code, retries EXACTLY ONCE — waiting out a
 * full step first so the freshly-computed retry code cannot straddle the
 * same boundary again. A second failure is treated as a real defect, not a
 * flake: it is left to fail the test rather than looping.
 */
export async function submitTotpCodeWithBoundaryRetry(
  page: Page,
  secret: string,
  opts: { codeTestId: string; submitTestId: string; errorTestId: string },
): Promise<void> {
  await page.getByTestId(opts.codeTestId).fill(computeTotpAvoidingBoundary(secret));
  await page.getByTestId(opts.submitTestId).click();

  const failed = await page
    .getByTestId(opts.errorTestId)
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
  if (!failed) return;

  // One deterministic retry: wait out a full step so the freshly computed
  // code cannot straddle the same boundary the first attempt did, then
  // resubmit. Bounded to exactly one retry — see the doc comment above.
  await page.waitForTimeout(TOTP_STEP_MS);
  await page.getByTestId(opts.codeTestId).fill(totp(secret, { now: Date.now() }));
  await page.getByTestId(opts.submitTestId).click();
}
