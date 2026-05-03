/**
 * Migration Drift Logic Tests — SCRUM-908 (PROD-DRIFT-01)
 *
 * Unit-tests the diff logic used by .github/workflows/migration-drift.yml.
 * The workflow is a shell script inside YAML, so we mirror the core algorithm
 * as a TypeScript function and test it here.
 *
 * Covers:
 *   - Happy path: no drift
 *   - Supabase API response normalization
 *   - Missing migrations detected
 *   - Exempt patterns filtered (macOS duplicates, numbered gaps, verified successors)
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
 * Supabase Management API returns `version` and `name` separately, and `name`
 * may appear as a full local basename, a description suffix, or an
 * operator-applied Jira prefix. The workflow emits all supported identities and
 * compares them against local basenames such as `0001_enums`.
 */
interface SupabaseMigration {
  version: string | number;
  name?: string | null;
}

export function normalizeProdMigrationKeys(migration: SupabaseMigration): string[] {
  const version = String(migration.version);
  const name = migration.name ? String(migration.name) : '';
  if (!name || name === 'null') return [version];

  const versionAndName = name.startsWith(`${version}_`) ? name : `${version}_${name}`;
  const withoutScrumPrefix = name.replace(/^scrum_[0-9]+_/, '');

  return [...new Set([name, versionAndName, withoutScrumPrefix])];
}

/**
 * Finds local migration names that are NOT present in the normalized prod
 * applied set, filtering out names that match the exempt regex.
 *
 * This is the TypeScript equivalent of:
 *   comm -23 <(local sorted) <(prod sorted) | grep -vE "$exempt_regex"
 *
 * @param localNames  - basenames (no .sql extension) from supabase/migrations/
 * @param prodMigrations - rows returned by Supabase Management API
 * @param exemptRegex - pattern for migrations intentionally not in prod
 * @returns sorted array of non-exempt migration names missing from prod
 * @throws if localNames is empty (indicates a repo checkout or path error)
 * @throws if prodMigrations is empty  (indicates an API or auth error)
 */
export function findMissingMigrations(
  localNames: string[],
  prodMigrations: SupabaseMigration[],
  exemptRegex: RegExp,
): string[] {
  if (localNames.length === 0) {
    throw new Error('No local migrations found — check supabase/migrations/ path');
  }
  if (prodMigrations.length === 0) {
    throw new Error('Prod returned no migrations — check Supabase Management API / token');
  }

  const prodSet = new Set(prodMigrations.flatMap(normalizeProdMigrationKeys));

  const missing = localNames
    .filter((name) => {
      const canonicalSuffix = name.replace(/^[0-9]{4}[a-z]?_/, '');
      return !prodSet.has(name) && !prodSet.has(canonicalSuffix);
    })
    .filter((name) => !exemptRegex.test(name))
    .sort((a, b) => a.localeCompare(b));

  return missing;
}

export function migrationNameFromPath(filePath: string): string | null {
  const prefix = 'supabase/migrations/';
  if (!filePath.startsWith(prefix) || !filePath.endsWith('.sql')) return null;
  return filePath.slice(prefix.length, -'.sql'.length);
}

export function findPrBlockingMissingMigrations(
  missingMigrations: string[],
  changedFiles: string[],
): string[] {
  const changedMigrationNames = new Set(
    changedFiles
      .map(migrationNameFromPath)
      .filter((name): name is string => Boolean(name)),
  );
  return missingMigrations
    .filter((name) => changedMigrationNames.has(name))
    .sort((a, b) => a.localeCompare(b));
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
 *   (c) verified historical ledger mismatches whose effects are present in prod
 */
const EXEMPT_REGEX =
  /^(0033|0078|0162|.* 2|0022_seed_schema_alignment|0023_is_public_profile|0024_fix_search_path_revoke_anchor|0068b_submitted_status_and_confirmations|0088b_cle_templates|0135_ats_integrations|0175_fix_pipeline_stats_timeout|0180_fix_public_issuer_perf|0258_ark112_queue_public_id)$/;

function applied(...migrationNames: string[]): SupabaseMigration[] {
  return migrationNames.map((migrationName) => {
    const [version, ...nameParts] = migrationName.split('_');
    return { version, name: nameParts.join('_') };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SCRUM-908: findMissingMigrations — core diff logic', () => {
  it('returns empty when all local names are in prod', () => {
    const local = ['0001_enums', '0002_organizations', '0003_profiles'];
    const prod = applied('0001_enums', '0002_organizations', '0003_profiles', '0004_anchors');
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('normalizes Supabase version and name before diffing', () => {
    const local = [
      '0000_ensure_http_extension',
      '0001_enums',
      '0279_x402_payments_org_scoping',
      '0280_rls_auth_uid_subquery_wrap',
    ];
    const prod = [
      { version: '0000', name: 'ensure_http_extension' },
      { version: '0001', name: '0001_enums' },
      { version: '20260429123456', name: 'x402_payments_org_scoping' },
      { version: '0280', name: 'rls_auth_uid_subquery_wrap' },
    ];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('normalizes null migration names to the version fallback identity', () => {
    expect(normalizeProdMigrationKeys({ version: '0001', name: null })).toEqual(['0001']);
  });

  it('normalizes operator-applied SCRUM prefixes to canonical suffixes', () => {
    const local = ['1170_org_credits_and_allocations'];
    const prod = [{ version: '20260418120000', name: 'scrum_1170_org_credits_and_allocations' }];
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('returns missing names when some are not in prod', () => {
    const local = ['0001_enums', '0002_organizations', '0217_nca03_compliance_audits', '0218_nca06_notifications'];
    const prod = applied('0001_enums', '0002_organizations');
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual(['0217_nca03_compliance_audits', '0218_nca06_notifications']);
  });

  it('returns results sorted alphabetically', () => {
    const local = ['0218_nca06_notifications', '0001_enums', '0217_nca03_compliance_audits'];
    const prod = applied('0001_enums');
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
    const prod = applied('0100_some_migration', '0101_another_migration');
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('filters out numbered gap migrations (0033, 0078, 0162)', () => {
    // These numbers never had files, but if they somehow appeared they should be exempt
    const local = ['0001_enums', '0033', '0078', '0162'];
    const prod = applied('0001_enums');
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('filters out verified historical ledger exceptions', () => {
    const local = [
      '0001_enums',
      '0022_seed_schema_alignment',
      '0023_is_public_profile',
      '0024_fix_search_path_revoke_anchor',
      '0068b_submitted_status_and_confirmations',
      '0088b_cle_templates',
      '0135_ats_integrations',
      '0175_fix_pipeline_stats_timeout',
      '0180_fix_public_issuer_perf',
      '0258_ark112_queue_public_id',
    ];
    const prod = applied('0001_enums');
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([]);
  });

  it('does NOT filter non-exempt migrations that are missing', () => {
    const local = [
      '0001_enums',
      '0190_rls_subquery_caching',  // NOT exempt
      '0219_nca_fu3_tier2_regulations',  // NOT exempt
      '0220_usage_widget_rpc',  // NOT exempt
    ];
    const prod = applied('0001_enums');
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual([
      '0190_rls_subquery_caching',
      '0219_nca_fu3_tier2_regulations',
      '0220_usage_widget_rpc',
    ]);
  });

  it('handles mix of exempt and non-exempt missing migrations', () => {
    const local = [
      '0001_enums',
      '0033',                           // exempt gap
      '0100_real_migration 2',          // exempt macOS dup
      '0022_seed_schema_alignment',     // exempt verified successor
      '0217_nca03_compliance_audits',   // NOT exempt — real drift
      '0218_nca06_notifications',       // NOT exempt — real drift
    ];
    const prod = applied('0001_enums');
    const result = findMissingMigrations(local, prod, EXEMPT_REGEX);
    expect(result).toEqual(['0217_nca03_compliance_audits', '0218_nca06_notifications']);
  });
});

describe('SCRUM-908: findMissingMigrations — error cases', () => {
  it('throws when local list is empty', () => {
    expect(() =>
      findMissingMigrations([], applied('0001_enums'), EXEMPT_REGEX),
    ).toThrow('No local migrations found');
  });

  it('throws when prod list is empty', () => {
    expect(() =>
      findMissingMigrations(['0001_enums'], [], EXEMPT_REGEX),
    ).toThrow('Prod returned no migrations');
  });
});

describe('SCRUM-908: PR drift blocking logic', () => {
  it('does not block workflow-only PRs on baseline production drift', () => {
    const missing = ['0279_x402_payments_org_scoping', '0280_rls_auth_uid_subquery_wrap'];
    const changedFiles = ['.github/workflows/migration-drift.yml'];
    expect(findPrBlockingMissingMigrations(missing, changedFiles)).toEqual([]);
  });

  it('blocks PRs that add or modify a missing migration', () => {
    const missing = ['0279_x402_payments_org_scoping', '0280_rls_auth_uid_subquery_wrap'];
    const changedFiles = [
      'docs/runbooks/migration-drift-playbook.md',
      'supabase/migrations/0280_rls_auth_uid_subquery_wrap.sql',
    ];
    expect(findPrBlockingMissingMigrations(missing, changedFiles)).toEqual(['0280_rls_auth_uid_subquery_wrap']);
  });

  it('ignores non-SQL files under the migrations directory', () => {
    const missing = ['0280_rls_auth_uid_subquery_wrap'];
    const changedFiles = ['supabase/migrations/README.md'];
    expect(findPrBlockingMissingMigrations(missing, changedFiles)).toEqual([]);
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
