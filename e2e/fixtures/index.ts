/**
 * E2E Test Fixtures — Barrel Export
 *
 * Import { test, expect } from this file in all E2E specs.
 * Provides authenticated page fixtures + Supabase helpers.
 *
 * @updated 2026-03-10 10:30 PM EST
 */

export { test } from './auth';
export { expect } from '@playwright/test';
export {
  getServiceClient,
  getSeedUserOrgId,
  SEED_USERS,
  createTestAnchor,
  deleteTestAnchor,
} from './supabase';
export {
  seedAnchors,
  cleanupSeedAnchors,
  type SeedAnchorSet,
  type SeedAnchor,
} from './seed-anchors';
