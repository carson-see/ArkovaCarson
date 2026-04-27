/**
 * Authentication Fixtures for E2E Tests
 *
 * Provides Playwright fixtures for authenticated page contexts.
 * Uses pre-saved storageState from `e2e/auth.setup.ts` — no per-test
 * login flows. The setup project logs in each seed user once and saves
 * cookies + localStorage to `.auth/*.json`.
 *
 * For tests that need the default `individual` (carson) session, the
 * project-level `storageState` in `playwright.config.ts` handles it
 * automatically — every `page` fixture is already authenticated.
 *
 * The `individualPage` fixture is therefore just the default `page`
 * (already authenticated via project storageState).
 *
 * The `orgAdminPage` fixture is also the default `page` because
 * orgAdmin and individual are the same seed user (carson@arkova.ai).
 *
 * The `orgBAdminPage` fixture creates a new browser context with
 * sarah's storageState for cross-tenant tests.
 *
 * @updated 2026-04-26 — SCRUM-1302: storageState auth to fix timeout regression
 */

import { test as base, type Page, type BrowserContext } from '@playwright/test';

// Storage state paths (written by e2e/auth.setup.ts)
const INDIVIDUAL_STATE = '.auth/individual.json';
const ORG_B_ADMIN_STATE = '.auth/orgBAdmin.json';

// Re-export SEED_USERS keys for type safety
import { SEED_USERS } from './supabase';
type SeedUserKey = keyof typeof SEED_USERS;

// ── Extended Test Fixtures ──────────────────────────────────────────────────

type AuthFixtures = {
  /** Page logged in as INDIVIDUAL user (carson) — uses project default storageState */
  individualPage: Page;
  /** Page logged in as ORG_ADMIN (carson) — same user as individual */
  orgAdminPage: Page;
  /** Page logged in as ORG_B_ADMIN (sarah) — separate browser context */
  orgBAdminPage: Page;
  /** Helper to log in as any seed user (opens new context with saved state) */
  loginAs: (page: Page, userKey: SeedUserKey) => Promise<Page>;
};

/**
 * Map seed user keys to their storageState file paths.
 * individual and orgAdmin are the same user (carson).
 */
const STORAGE_STATE_MAP: Record<SeedUserKey, string> = {
  individual: INDIVIDUAL_STATE,
  orgAdmin: INDIVIDUAL_STATE,
  registrar: ORG_B_ADMIN_STATE,
  orgBAdmin: ORG_B_ADMIN_STATE,
};

/**
 * Extended Playwright test with auth fixtures.
 * Usage: `import { test, expect } from '../fixtures';`
 */
export const test = base.extend<AuthFixtures>({
  // individualPage: the default page is already authenticated via
  // project-level storageState (individual.json)
  individualPage: async ({ page }, use) => {
    await use(page);
  },

  // orgAdminPage: same user as individual (carson), reuse default page
  orgAdminPage: async ({ page }, use) => {
    await use(page);
  },

  // orgBAdminPage: different user (sarah) — needs its own browser context
  orgBAdminPage: async ({ browser }, use) => {
    const context: BrowserContext = await browser.newContext({
      storageState: ORG_B_ADMIN_STATE,
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  loginAs: async ({ browser }, use) => {
    await use(async (_page: Page, userKey: SeedUserKey) => {
      const statePath = STORAGE_STATE_MAP[userKey];
      const context = await browser.newContext({ storageState: statePath });
      const newPage = await context.newPage();
      return newPage;
    });
  },
});
