/**
 * Authentication Fixtures for E2E Tests
 *
 * Provides Playwright fixtures for authenticated page contexts.
 * Uses seed users — no inline login flows in spec files.
 *
 * @updated 2026-03-10 10:30 PM EST
 */

import { test as base, type Page } from '@playwright/test';
import { SEED_USERS } from './supabase';

type SeedUserKey = keyof typeof SEED_USERS;

/**
 * Log in a seed user via the UI login form.
 * Returns the page after successful authentication.
 */
async function loginAs(page: Page, userKey: SeedUserKey): Promise<Page> {
  const user = SEED_USERS[userKey];

  await page.goto('/auth');
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for navigation away from auth page
  await page.waitForURL(
    /\/(vault|dashboard|onboarding|organization|records|settings|review-pending)/,
    { timeout: 15000 }
  );

  return page;
}

// ── Extended Test Fixtures ──────────────────────────────────────────────────

type AuthFixtures = {
  /** Page logged in as INDIVIDUAL user (no org) */
  individualPage: Page;
  /** Page logged in as ORG_ADMIN at University of Michigan */
  orgAdminPage: Page;
  /** Page logged in as ORG_ADMIN at Midwest Medical (second org) */
  orgBAdminPage: Page;
  /** Helper to log in as any seed user */
  loginAs: (page: Page, userKey: SeedUserKey) => Promise<Page>;
};

/**
 * Extended Playwright test with auth fixtures.
 * Usage: `import { test, expect } from '../fixtures';`
 */
export const test = base.extend<AuthFixtures>({
  individualPage: async ({ page }, use) => {
    await loginAs(page, 'individual');
    await use(page);
  },

  orgAdminPage: async ({ page }, use) => {
    await loginAs(page, 'orgAdmin');
    await use(page);
  },

  orgBAdminPage: async ({ page }, use) => {
    await loginAs(page, 'orgBAdmin');
    await use(page);
  },

  loginAs: async ({}, use) => {
    await use(loginAs);
  },
});
