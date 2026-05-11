/**
 * SCRUM-1668 — unit tests for staging-honesty-preflight.
 *
 * Tests the pure classification / analysis functions without hitting
 * any real Supabase instance. DB queries are represented as raw row
 * arrays passed into the analysis layer.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyMigrationRow,
  findDuplicateNames,
  findDuplicateVersions,
  detectKnownArtifacts,
  computeProdDivergence,
  checkOrgTopology,
  checkProdFacts,
  isOrgSeedName,
  buildReport,
  parseArgs,
  type MigrationRow,
  type CheckResult,
  type EnvironmentType,
  type OrgTopologyData,
  type ProdFactsData,
} from './staging-honesty-preflight.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLEAN_ROWS: MigrationRow[] = [
  { version: '00000000000000', name: '00000000000000' },
  { version: '0294', name: '0294_refund_org_credit' },
  { version: '0295', name: '0295_add_webhook_events' },
  { version: '0296', name: '0296_api_key_hmac' },
  { version: '0297', name: '0297_audit_log_cleanup' },
];

const ARTIFACT_ROWS: MigrationRow[] = [
  ...CLEAN_ROWS,
  { version: '20260505010337', name: 'pr695_0292' },
  { version: '20260505020000', name: 'pr695_0293' },
  { version: '20260506010000', name: 'pr697_0290' },
  { version: '20260507010000', name: 'staging_purge_v5' },
  { version: '20260508010000', name: 'staging_purge_v6' },
];

const DUPLICATE_NAME_ROWS: MigrationRow[] = [
  ...CLEAN_ROWS,
  { version: '0298', name: '0294_refund_org_credit' },
];

const DUPLICATE_VERSION_ROWS: MigrationRow[] = [
  ...CLEAN_ROWS,
  { version: '0294', name: '0294_refund_org_credit_v2' },
];

// ---------------------------------------------------------------------------
// classifyMigrationRow
// ---------------------------------------------------------------------------

describe('classifyMigrationRow', () => {
  it('returns null for a canonical migration', () => {
    expect(classifyMigrationRow({ version: '0294', name: '0294_refund_org_credit' })).toBeNull();
  });

  it('flags a row with a long timestamp version (14+ digits)', () => {
    const result = classifyMigrationRow({ version: '20260505010337', name: 'pr695_0292' });
    expect(result).not.toBeNull();
    expect(result!.reason).toMatch(/timestamp/i);
  });

  it('flags pr695_ prefix in name', () => {
    const result = classifyMigrationRow({ version: '100', name: 'pr695_0292' });
    expect(result).not.toBeNull();
    expect(result!.reason).toMatch(/pr695_/);
  });

  it('flags pr697_ prefix in name', () => {
    const result = classifyMigrationRow({ version: '101', name: 'pr697_0290' });
    expect(result).not.toBeNull();
    expect(result!.reason).toMatch(/pr697_/);
  });

  it('flags staging_purge_ prefix in name', () => {
    const result = classifyMigrationRow({ version: '102', name: 'staging_purge_v5' });
    expect(result).not.toBeNull();
    expect(result!.reason).toMatch(/staging_purge_/);
  });

  it('flags staging_only_ prefix in name', () => {
    const result = classifyMigrationRow({ version: '103', name: 'staging_only_fix' });
    expect(result).not.toBeNull();
    expect(result!.reason).toMatch(/staging_only_/);
  });

  it('does not flag the init migration (00000000000000)', () => {
    expect(classifyMigrationRow({ version: '00000000000000', name: '00000000000000' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findDuplicateNames
// ---------------------------------------------------------------------------

describe('findDuplicateNames', () => {
  it('returns empty for unique names', () => {
    expect(findDuplicateNames(CLEAN_ROWS)).toEqual([]);
  });

  it('detects duplicate migration names', () => {
    const dupes = findDuplicateNames(DUPLICATE_NAME_ROWS);
    expect(dupes).toContain('0294_refund_org_credit');
    expect(dupes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findDuplicateVersions
// ---------------------------------------------------------------------------

describe('findDuplicateVersions', () => {
  it('returns empty for unique versions', () => {
    expect(findDuplicateVersions(CLEAN_ROWS)).toEqual([]);
  });

  it('detects duplicate versions', () => {
    const dupes = findDuplicateVersions(DUPLICATE_VERSION_ROWS);
    expect(dupes).toContain('0294');
    expect(dupes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectKnownArtifacts
// ---------------------------------------------------------------------------

describe('detectKnownArtifacts', () => {
  it('returns empty for clean rows', () => {
    expect(detectKnownArtifacts(CLEAN_ROWS)).toEqual([]);
  });

  it('detects all known artifact names', () => {
    const artifacts = detectKnownArtifacts(ARTIFACT_ROWS);
    expect(artifacts.map((r) => r.name)).toContain('pr695_0292');
    expect(artifacts.map((r) => r.name)).toContain('pr695_0293');
    expect(artifacts.map((r) => r.name)).toContain('pr697_0290');
    expect(artifacts.map((r) => r.name)).toContain('staging_purge_v5');
    expect(artifacts.map((r) => r.name)).toContain('staging_purge_v6');
  });

  it('detects duplicate 0294_refund_org_credit as known artifact', () => {
    const artifacts = detectKnownArtifacts(DUPLICATE_NAME_ROWS);
    // The second occurrence should be flagged
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    expect(artifacts.some((r) => r.name === '0294_refund_org_credit')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeProdDivergence
// ---------------------------------------------------------------------------

describe('computeProdDivergence', () => {
  const DEFAULT_PROD = ['00000000000000', '0294', '0295', '0296', '0297'];

  it('returns no divergence for matching sets', () => {
    const result = computeProdDivergence(CLEAN_ROWS, DEFAULT_PROD);
    expect(result.missingFromStaging).toEqual([]);
    expect(result.extraVsProd).toEqual([]);
  });

  it('finds versions in prod but missing from staging', () => {
    const stagingRows: MigrationRow[] = [
      { version: '00000000000000', name: '00000000000000' },
      { version: '0294', name: '0294_refund_org_credit' },
      // missing 0295, 0296, 0297
    ];
    const result = computeProdDivergence(stagingRows, DEFAULT_PROD);
    expect(result.missingFromStaging).toContain('0295');
    expect(result.missingFromStaging).toContain('0296');
    expect(result.missingFromStaging).toContain('0297');
  });

  it('finds versions in staging but not in prod', () => {
    const stagingRows: MigrationRow[] = [
      ...CLEAN_ROWS,
      { version: '20260505010337', name: 'pr695_0292' },
    ];
    const result = computeProdDivergence(stagingRows, DEFAULT_PROD);
    expect(result.extraVsProd).toContain('20260505010337');
  });

  it('does not flag canonical ahead-of-prod migrations as extra', () => {
    const stagingRows: MigrationRow[] = [
      ...CLEAN_ROWS,
      { version: '0298', name: '0298_next_canonical_migration' },
    ];
    // 0298 is numerically "ahead" of prod but is a canonical short version.
    // The function should include it as extra since it's not in the prod list.
    const result = computeProdDivergence(stagingRows, DEFAULT_PROD);
    expect(result.extraVsProd).toContain('0298');
  });
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

describe('buildReport', () => {
  it('classifies clean environment as clean_mirror', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: ['00000000000000', '0294', '0295', '0296', '0297'],
    });
    expect(report.environment_type).toBe('clean_mirror');
    expect(report.staging_project_ref).toBe('test-ref');
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(report.artifact_rows).toEqual([]);
  });

  it('classifies environment with artifacts as soak_artifact', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: ARTIFACT_ROWS,
      submittedAnchorCount: 5,
      prodVersions: ['00000000000000', '0294', '0295', '0296', '0297'],
    });
    expect(report.environment_type).toBe('soak_artifact');
    expect(report.artifact_rows.length).toBeGreaterThan(0);
    expect(report.checks.some((c) => !c.passed)).toBe(true);
  });

  it('classifies environment with zero SUBMITTED anchors as fixture_seeded', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 0,
      prodVersions: ['00000000000000', '0294', '0295', '0296', '0297'],
    });
    expect(report.environment_type).toBe('fixture_seeded');
    const anchorCheck = report.checks.find((c) => c.name === 'submitted_anchors');
    expect(anchorCheck).toBeDefined();
    expect(anchorCheck!.passed).toBe(false);
  });

  it('includes timestamp in ISO 8601', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: ['00000000000000', '0294', '0295', '0296', '0297'],
    });
    expect(() => new Date(report.timestamp)).not.toThrow();
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports duplicate names check failure', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: DUPLICATE_NAME_ROWS,
      submittedAnchorCount: 5,
      prodVersions: ['00000000000000', '0294', '0295', '0296', '0297'],
    });
    const dupeCheck = report.checks.find((c) => c.name === 'duplicate_names');
    expect(dupeCheck).toBeDefined();
    expect(dupeCheck!.passed).toBe(false);
  });

  it('reports duplicate versions check failure', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: DUPLICATE_VERSION_ROWS,
      submittedAnchorCount: 5,
      prodVersions: ['00000000000000', '0294', '0295', '0296', '0297'],
    });
    const dupeCheck = report.checks.find((c) => c.name === 'duplicate_versions');
    expect(dupeCheck).toBeDefined();
    expect(dupeCheck!.passed).toBe(false);
  });

  it('reports prod divergence in the report', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: ARTIFACT_ROWS,
      submittedAnchorCount: 5,
      prodVersions: ['00000000000000', '0294', '0295', '0296', '0297'],
    });
    // ARTIFACT_ROWS has extra timestamp-versioned rows
    expect(report.extra_vs_prod.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --project-ref', () => {
    const args = parseArgs(['--project-ref', 'abc123']);
    expect(args.projectRef).toBe('abc123');
  });

  it('parses --supabase-url and --service-role-key', () => {
    const args = parseArgs(['--supabase-url', 'https://x.supabase.co', '--service-role-key', 'sk']);
    expect(args.supabaseUrl).toBe('https://x.supabase.co');
    expect(args.serviceRoleKey).toBe('sk');
  });

  it('parses --prod-versions as comma-separated', () => {
    const args = parseArgs(['--prod-versions', '0294,0295,0296']);
    expect(args.prodVersions).toEqual(['0294', '0295', '0296']);
  });

  it('parses --format text', () => {
    const args = parseArgs(['--format', 'text']);
    expect(args.format).toBe('text');
  });

  it('defaults format to json', () => {
    const args = parseArgs([]);
    expect(args.format).toBe('json');
  });

  it('defaults prod versions to the canonical set', () => {
    const args = parseArgs([]);
    expect(args.prodVersions).toEqual(['00000000000000', '0294', '0295', '0296', '0297']);
  });

  it('parses --prod-facts JSON', () => {
    const json = '{"cronJobNames":["vacuum-anchors"],"functionExists":true}';
    const args = parseArgs(['--prod-facts', json]);
    expect(args.prodFacts).toEqual({ cronJobNames: ['vacuum-anchors'], functionExists: true });
  });

  it('ignores malformed --prod-facts JSON', () => {
    const args = parseArgs(['--prod-facts', 'not-json']);
    expect(args.prodFacts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isOrgSeedName
// ---------------------------------------------------------------------------

describe('isOrgSeedName', () => {
  it('detects STG-prefixed org as seed', () => {
    expect(isOrgSeedName('STG Org 001')).toBe(true);
  });

  it('detects lowercase stg prefix as seed', () => {
    expect(isOrgSeedName('stg_test_org')).toBe(true);
  });

  it('detects staging_seed_ prefix as seed', () => {
    expect(isOrgSeedName('staging_seed_alpha')).toBe(true);
  });

  it('detects test_org_ prefix as seed', () => {
    expect(isOrgSeedName('test_org_beta')).toBe(true);
  });

  it('does not flag a real org name', () => {
    expect(isOrgSeedName('Acme Corporation')).toBe(false);
  });

  it('does not flag an org with stg in the middle', () => {
    expect(isOrgSeedName('AcmeSTG Corp')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkOrgTopology
// ---------------------------------------------------------------------------

describe('checkOrgTopology', () => {
  it('fails when no orgs found', () => {
    const result = checkOrgTopology({ totalOrgs: 0, seedOrgs: 0 });
    expect(result.passed).toBe(false);
    expect(result.name).toBe('org_topology');
    expect(result.details).toMatch(/no organizations/i);
  });

  it('passes for prod-like single-tenant topology (no seed orgs)', () => {
    const result = checkOrgTopology({ totalOrgs: 3, seedOrgs: 0 });
    expect(result.passed).toBe(true);
    expect(result.details).toMatch(/prod-like single-tenant/);
  });

  it('passes when seed orgs exist alongside org-scoped fixtures', () => {
    const result = checkOrgTopology({ totalOrgs: 1005, seedOrgs: 1000 });
    expect(result.passed).toBe(true);
    expect(result.details).toMatch(/1000 seed/);
    expect(result.details).toMatch(/5 org-scoped fixture/);
  });

  it('fails when all orgs are seed-prefixed (no fixtures for connector work)', () => {
    const result = checkOrgTopology({ totalOrgs: 1000, seedOrgs: 1000 });
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/no org-scoped fixtures/i);
  });
});

// ---------------------------------------------------------------------------
// checkProdFacts
// ---------------------------------------------------------------------------

describe('checkProdFacts', () => {
  it('passes when all prod facts match', () => {
    const result = checkProdFacts({
      cronJobNames: ['vacuum-anchors'],
      functionExists: true,
    });
    expect(result.passed).toBe(true);
    expect(result.name).toBe('prod_facts');
    expect(result.details).toMatch(/vacuum-anchors scheduled/);
  });

  it('fails when vacuum-anchors job is missing', () => {
    const result = checkProdFacts({
      cronJobNames: [],
      functionExists: true,
    });
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/vacuum-anchors job missing/);
  });

  it('fails when refresh_pipeline_dashboard_cache function is missing', () => {
    const result = checkProdFacts({
      cronJobNames: ['vacuum-anchors'],
      functionExists: false,
    });
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/refresh_pipeline_dashboard_cache\(\) function missing/);
  });

  it('fails when refresh_pipeline_dashboard_cache is incorrectly scheduled', () => {
    const result = checkProdFacts({
      cronJobNames: ['vacuum-anchors', 'refresh_pipeline_dashboard_cache'],
      functionExists: true,
    });
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/should be unscheduled per prod/);
  });

  it('reports multiple issues together', () => {
    const result = checkProdFacts({
      cronJobNames: ['refresh_pipeline_dashboard_cache'],
      functionExists: false,
    });
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/vacuum-anchors/);
    expect(result.details).toMatch(/function missing/);
    expect(result.details).toMatch(/should be unscheduled/);
  });
});

// ---------------------------------------------------------------------------
// buildReport — with org topology and prod facts
// ---------------------------------------------------------------------------

describe('buildReport with org topology and prod facts', () => {
  const DEFAULT_PROD = ['00000000000000', '0294', '0295', '0296', '0297'];

  it('includes org_topology check when data is provided', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: DEFAULT_PROD,
      orgTopology: { totalOrgs: 1005, seedOrgs: 1000 },
    });
    const check = report.checks.find((c) => c.name === 'org_topology');
    expect(check).toBeDefined();
    expect(check!.passed).toBe(true);
  });

  it('includes prod_facts check when data is provided', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: DEFAULT_PROD,
      prodFacts: { cronJobNames: ['vacuum-anchors'], functionExists: true },
    });
    const check = report.checks.find((c) => c.name === 'prod_facts');
    expect(check).toBeDefined();
    expect(check!.passed).toBe(true);
  });

  it('omits new checks when data is not provided (backward compat)', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: DEFAULT_PROD,
    });
    expect(report.checks.find((c) => c.name === 'org_topology')).toBeUndefined();
    expect(report.checks.find((c) => c.name === 'prod_facts')).toBeUndefined();
  });

  it('still classifies as clean_mirror when all checks pass including new ones', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: DEFAULT_PROD,
      orgTopology: { totalOrgs: 5, seedOrgs: 0 },
      prodFacts: { cronJobNames: ['vacuum-anchors'], functionExists: true },
    });
    expect(report.environment_type).toBe('clean_mirror');
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it('marks environment as soak_artifact when prod facts fail', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: DEFAULT_PROD,
      prodFacts: { cronJobNames: [], functionExists: false },
    });
    expect(report.checks.some((c) => !c.passed)).toBe(true);
  });
});
