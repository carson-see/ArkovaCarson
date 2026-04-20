/**
 * Migration Drift Logic Tests — SCRUM-908 (PROD-DRIFT-01)
 *
 * Unit-tests the diff logic used by .github/workflows/migration-drift.yml.
 * The workflow is a shell script inside YAML, so we mirror the core algorithm
 * as a TypeScript function and test it here.
 *
 * Covers:
 *   - Happy path: no drift
 *   - Missing migrations detected
 *   - Exempt patterns filtered (macOS duplicates, numbered gaps, deferred)
 *   - Edge cases: empty local list, empty prod list
 *   - Sanity check: real migration files can be listed and sorted
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Function under test — mirrors the shell logic in migration-drift.yml
// ---------------------------------------------------------------------------

/**
 * Finds local migration names that are NOT present in the prod applied set,
 * filtering out names that match the exempt regex.
 *
 * This is the TypeScript equivalent of:
 *   comm -23 <(local sorted) <(prod sorted) | grep -vE "$exempt_regex"
 *
 * @param localNames  - basenames (no .sql extension) from supabase/migrations/
 * @param prodNames   - names returned by Supabase Management API .[].name
 * @param exemptRegex - pattern for migrations intentionally not in prod
 * @returns sorted array of non-exempt migration names missing from prod
 * @throws if localNames is empty (indicates a repo checkout or path error)
 * @throws if prodNames is empty  (indicates an API or auth error)
 */
export function findMissingMigrations(
  localNames: string[],
  prodNames: string[],
  exemptRegex: RegExp,
): string[] {
  if (localNames.length === 0) {
    throw new Error('No local migrations found — check supabase/migrations/ path');
  }
  if (prodNames.length === 0) {
    throw new Error('Prod returned no migrations — check Supabase Management API / token');
  }

  const prodSet = new Set(prodNames);

  const missing = localNames
    .filter((name) => !prodSet.has(name))
    .filter((name) => !exemptRegex.test(name))
    .sort();

  return missing;
}

// ---------------------------------------------------------------------------
// The exempt regex from the workflow, kept in sync for testing
// ---------------------------------------------------------------------------

/**
 * Matches the `exempt_regex` variable in .github/workflows/migration-drift.yml.
 *
 * Categories:
 *   (a) 0033 / 0078 / 0162 — numbered gaps that never existed as files
 *   (b) " 2" suffix — macOS duplicate copies
 *   (c) 0186 / 0212..0216 — applied under different version strings in prod
 *   (d) 0190 / 0191 — intentionally held back for maintenance window
 */
const EXEMPT_REGEX =
  /^(0033|0078|0162|.* 2|0186_.*|0190_.*|0191_.*|0212_.*|0213_.*|0214_.*|0215_.*|0216_.*|0216b_.*)$/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SCRUM-908: findMissingMigrations — core diff logic', () => {
  it('returns empty when all local names are in prod', () => {
    const local = ['0001_enums', '0002_organizations', '0003_profiles'];
    const prod = ['0001_enums', '0002_organizations', '0003_profiles', '0004_anchors'];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('returns missing names when some are not in prod', () => {
    const local = ['0001_enums', '0002_organizations', '0217_nca03_compliance_audits', '0218_nca06_notifications'];
    const prod = ['0001_enums', '0002_organizations'];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual(['0217_nca03_compliance_audits', '0218_nca06_notifications']);
  });

  it('returns results sorted alphabetically', () => {
    const local = ['0218_nca06_notifications', '0001_enums', '0217_nca03_compliance_audits'];
    const prod = ['0001_enums'];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual(['0217_nca03_compliance_audits', '0218_nca06_notifications']);
  });
});

describe('SCRUM-908: findMissingMigrations — exempt pattern filtering', () => {
  it('filters out macOS duplicate names with " 2" suffix', () => {
    const local = [
      '0100_some_migration',
      '0100_some_migration 2',
      '0101_another_migration',
      '0101_another_migration 2',
    ];
    const prod = ['0100_some_migration', '0101_another_migration'];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('filters out numbered gap migrations (0033, 0078, 0162)', () => {
    // These numbers never had files, but if they somehow appeared they should be exempt
    const local = ['0001_enums', '0033', '0078', '0162'];
    const prod = ['0001_enums'];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('filters out deferred migrations 0190 and 0191', () => {
    const local = [
      '0001_enums',
      '0190_rls_subquery_caching',
      '0191_brin_indexes_timeseries',
      '0192_enable_pg_stat_statements',
    ];
    const prod = ['0001_enums', '0192_enable_pg_stat_statements'];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('filters out version-string-mismatch migrations (0186, 0212-0216)', () => {
    const local = [
      '0001_enums',
      '0186_some_migration',
      '0212_nph01_accreditation_credential_type',
      '0213_gre01_credential_sub_type',
      '0214_drop_unused_indexes',
      '0215_emergency_dashboard_performance',
      '0216_nca01_jurisdiction_rules_expansion',
      '0216b_some_variant',
    ];
    const prod = ['0001_enums'];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('does NOT filter non-exempt migrations that are missing', () => {
    const local = [
      '0001_enums',
      '0190_rls_subquery_caching',  // exempt
      '0219_nca_fu3_tier2_regulations',  // NOT exempt
      '0220_usage_widget_rpc',  // NOT exempt
    ];
    const prod = ['0001_enums'];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual(['0219_nca_fu3_tier2_regulations', '0220_usage_widget_rpc']);
  });

  it('handles mix of exempt and non-exempt missing migrations', () => {
    const local = [
      '0001_enums',
      '0033',                           // exempt gap
      '0100_real_migration 2',          // exempt macOS dup
      '0190_rls_subquery_caching',      // exempt deferred
      '0212_nph01_accreditation_credential_type',  // exempt version mismatch
      '0217_nca03_compliance_audits',   // NOT exempt — real drift
      '0218_nca06_notifications',       // NOT exempt — real drift
    ];
    const prod = ['0001_enums'];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual(['0217_nca03_compliance_audits', '0218_nca06_notifications']);
  });
});

describe('SCRUM-908: findMissingMigrations — error cases', () => {
  it('throws when local list is empty', () => {
    expect(() =>
      findMissingMigrations([], ['0001_enums'], EXEMPT_REGEX),
    ).toThrow('No local migrations found');
  });

  it('throws when prod list is empty', () => {
    expect(() =>
      findMissingMigrations(['0001_enums'], [], EXEMPT_REGEX),
    ).toThrow('Prod returned no migrations');
  });
});

describe('SCRUM-908: migration files sanity check', () => {
  const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');

  it('supabase/migrations/ directory exists and contains .sql files', () => {
    const exists = fs.existsSync(migrationsDir);
    expect(exists).toBe(true);

    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(100);
  });

  it('migration filenames can be listed and sorted deterministically', () => {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();

    // Sorted list should start with 0000 and end with a high number
    expect(files[0]).toMatch(/^0000/);
    expect(files[files.length - 1]).toMatch(/^0[12]\d\d/);

    // No duplicates after sort (each basename is unique)
    const unique = [...new Set(files)];
    expect(unique.length).toBe(files.length);
  });

  it('migration filenames match the expected naming pattern', () => {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''));

    // Every file should start with a 4-digit number, with possible 'a'/'b'
    // suffix for splits like 0068a/0088b. scripts/ci-supabase-start.sh
    // renames a handful of files to a 5-digit form (e.g. 0068a -> 00680,
    // 0088 -> 00880) so they sort before the `_`-prefixed siblings in the
    // Supabase CLI's migration order; accept those as a second valid shape.
    const pattern = /^(\d{4}[a-z]?|\d{5})_/;
    for (const name of files) {
      expect(name, `"${name}" does not match migration naming pattern`).toMatch(pattern);
    }
  });
});
