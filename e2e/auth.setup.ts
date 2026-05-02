/**
 * Authentication Setup — Playwright Global Setup Project
 *
 * Runs once before all test projects. Logs in each seed user via the UI
 * and saves the authenticated browser state (cookies + localStorage) to
 * JSON files under `.auth/`. Test projects then reuse these files via
 * `storageState`, eliminating the per-test login overhead that caused
 * the SCRUM-1302 timeout regression.
 *
 * @created 2026-04-26
 */

import { test as setup, expect } from '@playwright/test';
import { getServiceClient, SEED_USERS } from './fixtures/supabase';
import { acceptDisclaimerIfVisible } from './helpers/dashboard';
import fs from 'fs';

const STORAGE_DIR = '.auth';
const serviceClient = getServiceClient();

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

/**
 * Shared login helper — navigates to /auth, fills credentials, waits
 * for redirect, then saves storageState to the given path.
 */
async function loginAndSave(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
  storagePath: string,
) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for navigation away from auth page
  await page.waitForURL(
    /\/(vault|dashboard|onboarding|organization|records|settings|review-pending)/,
    { timeout: 30_000 },
  );

  // Verify we are actually authenticated before saving state
  await expect(page).not.toHaveURL(/\/auth/);
  await acceptDisclaimerIfVisible(page);

  await page.context().storageState({ path: storagePath });
}

// ── Setup tests — one per distinct seed user ──────────────────────────

setup('authenticate as individual (demo-user)', async ({ page }) => {
  await markDisclaimerAccepted(SEED_USERS.individual.id);
  await loginAndSave(
    page,
    SEED_USERS.individual.email,
    SEED_USERS.individual.password,
    `${STORAGE_DIR}/individual.json`,
  );
});

setup('authenticate as orgAdmin (demo-admin)', async ({ page }) => {
  await markDisclaimerAccepted(SEED_USERS.orgAdmin.id);
  await loginAndSave(
    page,
    SEED_USERS.orgAdmin.email,
    SEED_USERS.orgAdmin.password,
    `${STORAGE_DIR}/orgAdmin.json`,
  );
});

setup('authenticate as orgBAdmin (sarah)', async ({ page }) => {
  await markDisclaimerAccepted(SEED_USERS.orgBAdmin.id);
  await loginAndSave(
    page,
    SEED_USERS.orgBAdmin.email,
    SEED_USERS.orgBAdmin.password,
    `${STORAGE_DIR}/orgBAdmin.json`,
  );
});
