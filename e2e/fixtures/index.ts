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
 *
 * Resolved from `import.meta.url`, NOT `__dirname`: the root package is
 * `"type": "module"`, so Playwright transpiles this barrel to ESM where
 * `__dirname` is undefined. Because every spec imports from this barrel, a
 * `__dirname` here is not a local defect — it throws at module load and takes
 * the WHOLE Playwright suite down before a single test is listed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const PUBLIC_FALLBACK_FILENAME_LABEL: string = (JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../scripts/ci/public-pii-projection-contract.json', import.meta.url)),
    'utf8',
  ),
) as { sql_non_academic_fallback_label: string }).sql_non_academic_fallback_label;
