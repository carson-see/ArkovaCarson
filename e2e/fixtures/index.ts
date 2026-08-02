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
  resolveSeedIndividualOrFallbackProfileId,
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

/**
 * The label the public anchor projection shows in place of the uploaded
 * filename for records with no academic credential type (migrations
 * 0385/0387/0390 — learner-PII redaction). Read from the shared contract that
 * also binds the SQL projection and the worker's CTDL PII guard, so a label
 * change cannot pass E2E while breaking the projection suites.
 *
 * Specs that seed an anchor with NO credential_type must assert THIS is
 * visible on the public verify page — never the raw uploaded filename, which
 * the projection deliberately withholds from anonymous viewers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const PUBLIC_FALLBACK_FILENAME_LABEL: string = (JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'scripts/ci/public-pii-projection-contract.json'), 'utf8'),
) as { sql_non_academic_fallback_label: string }).sql_non_academic_fallback_label;
