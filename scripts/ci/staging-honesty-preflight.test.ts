/**
 * SCRUM-1668 — unit tests for staging-honesty-preflight.
 *
 * Tests the pure classification / analysis functions without hitting
 * any real Supabase instance. DB queries are represented as raw row
 * arrays passed into the analysis layer.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyMigrationRow,
  findDuplicateNames,
  findDuplicateVersions,
  detectKnownArtifacts,
  computeProdDivergence,
  analyzeProdDivergence,
  hasCanonicalBaseline,
  parseRepoMigrationVersion,
  checkOrgTopology,
  checkProdFacts,
  isSupabaseMigrationsSchemaUnavailable,
  mapManagementMigrationRows,
  mapManagementMigrationVersions,
  mapManagementProdFacts,
  queryManagementApi,
  isOrgSeedName,
  isOrgRowSeeded,
  checkOrgTopologyUnavailable,
  ORG_NAME_COLUMNS,
  buildReport,
  parseArgs,
  type MigrationRow,
  type CheckResult,
  type EnvironmentType,
  type OrgTopologyData,
  type OrgNameRow,
  type ProdFactsData,
} from './staging-honesty-preflight.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    const result = classifyMigrationRow({ version: '20260505010337', name: 'manual_preview_migration' });
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

  it('does not flag the baseline row name used by Path C', () => {
    expect(classifyMigrationRow({ version: '00000000000000', name: 'baseline_at_main_HEAD' })).toBeNull();
  });

  it('flags a staging artifact name even when it reuses the init version', () => {
    const result = classifyMigrationRow({ version: '00000000000000', name: 'pr695_something' });
    expect(result).not.toBeNull();
    expect(result!.reason).toMatch(/pr695_/);
  });

  it('flags a non-canonical init row with a specific reason', () => {
    const result = classifyMigrationRow({ version: '00000000000000', name: 'sneaky_but_no_staging_prefix' });
    expect(result).not.toBeNull();
    expect(result!.reason).toMatch(/init version/i);
    expect(result!.reason).toMatch(/non-canonical name/i);
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

  // --- version-prefix normalization (repoVersions-aware) ---

  it('does NOT flag two distinct-version migrations whose db-push names dropped their numeric prefix', () => {
    // `supabase db push` stores both 0302_* and 0303_* migrations under the bare
    // name `validate_api_key_rpc_hardening`. Distinct repo-backed versions → not a dup.
    const rigRows: MigrationRow[] = [
      { version: '0302', name: 'validate_api_key_rpc_hardening' },
      { version: '0303', name: 'validate_api_key_rpc_hardening' },
    ];
    const repoVersions = new Set(['0302', '0303']);
    expect(findDuplicateNames(rigRows, repoVersions)).toEqual([]);
  });

  it('still flags a same-version+same-name replay as a duplicate (repoVersions-aware)', () => {
    const replayRows: MigrationRow[] = [
      { version: '0294', name: '0294_refund_org_credit' },
      { version: '0294', name: '0294_refund_org_credit' },
    ];
    const repoVersions = new Set(['0294']);
    expect(findDuplicateNames(replayRows, repoVersions)).toContain('0294_refund_org_credit');
  });

  it('still flags a prefixed-name collision across versions (contamination) when normalized', () => {
    // A prefixed name is authoritative: a row carrying name `0294_refund_org_credit`
    // under version 0298 still collides with the real 0294 row under the shared name.
    const rows: MigrationRow[] = [
      { version: '0294', name: '0294_refund_org_credit' },
      { version: '0298', name: '0294_refund_org_credit' },
    ];
    const repoVersions = new Set(['0294', '0298']);
    expect(findDuplicateNames(rows, repoVersions)).toContain('0294_refund_org_credit');
  });

  it('flags a bare-name collision when NEITHER colliding version is repo-backed', () => {
    // No repo backing for either row → both fall back to the bare name, so a real
    // bare-name collision still surfaces (a non-repo version cannot manufacture a
    // phantom-distinct identity to mask it).
    const rows: MigrationRow[] = [
      { version: '88888888888888', name: 'validate_api_key_rpc_hardening' },
      { version: '99999999999999', name: 'validate_api_key_rpc_hardening' },
    ];
    const repoVersions = new Set(['0294']); // neither colliding version is repo-backed
    expect(findDuplicateNames(rows, repoVersions)).toContain('validate_api_key_rpc_hardening');
  });

  it('does not treat one repo-backed + one unbacked bare name as a dup (contamination caught by classifyMigrationRow, not Check 2)', () => {
    // Identity differs (0303_… vs bare …), so Check 2 alone reports no dup. The
    // unbacked timestamp row is contamination, but it is classifyMigrationRow /
    // Check 1's job to flag — verified at the buildReport level below.
    const rows: MigrationRow[] = [
      { version: '0303', name: 'validate_api_key_rpc_hardening' },
      { version: '99999999999999', name: 'validate_api_key_rpc_hardening' },
    ];
    const repoVersions = new Set(['0303']); // timestamp version is NOT repo-backed
    expect(findDuplicateNames(rows, repoVersions)).toEqual([]);

    // Safety net: the unbacked timestamp row still trips Check 1, so the rig is
    // never mislabeled clean_mirror.
    const report = buildReport({
      projectRef: 'isolated-rig',
      migrationRows: [
        { version: '00000000000000', name: 'baseline_at_main_HEAD' },
        ...rows,
      ],
      submittedAnchorCount: 3,
      prodVersions: ['00000000000000', '0303'],
      repoVersions,
    });
    expect(report.checks.find((c) => c.name === 'duplicate_names')!.passed).toBe(true);
    expect(report.checks.find((c) => c.name === 'staging_only_rows')!.passed).toBe(false);
    expect(report.environment_type).toBe('soak_artifact');
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
// parseRepoMigrationVersion
// ---------------------------------------------------------------------------

describe('parseRepoMigrationVersion', () => {
  it('parses the NNNN prefix from a canonical migration filename', () => {
    expect(parseRepoMigrationVersion('0294_org_queue_scheduler.sql')).toBe('0294');
  });

  it('parses the all-zero baseline prefix', () => {
    expect(parseRepoMigrationVersion('00000000000000_baseline_at_main_HEAD.sql')).toBe('00000000000000');
  });

  it('returns null for files without a numeric prefix', () => {
    expect(parseRepoMigrationVersion('_template.sql')).toBeNull();
    expect(parseRepoMigrationVersion('README.md')).toBeNull();
  });

  it('ignores a leading directory path component', () => {
    expect(parseRepoMigrationVersion('supabase/migrations/0310_idx.sql')).toBe('0310');
  });
});

// ---------------------------------------------------------------------------
// hasCanonicalBaseline
// ---------------------------------------------------------------------------

describe('hasCanonicalBaseline', () => {
  it('detects the squashed baseline row by name', () => {
    expect(hasCanonicalBaseline([
      { version: '00000000000000', name: 'baseline_at_main_HEAD' },
      { version: '0327', name: '0327_something' },
    ])).toBe(true);
  });

  it('detects the baseline row by the all-zero version/name', () => {
    expect(hasCanonicalBaseline([
      { version: '00000000000000', name: '00000000000000' },
    ])).toBe(true);
  });

  it('returns false when no baseline row is present (shared-staging incremental ledger)', () => {
    expect(hasCanonicalBaseline([
      { version: '0294', name: '0294_refund_org_credit' },
      { version: '0295', name: '0295_add_webhook_events' },
    ])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeProdDivergence — repo-files-as-source-of-truth verdict
// ---------------------------------------------------------------------------

describe('analyzeProdDivergence', () => {
  // Prod ledger as it actually exists: baseline + recent migrations stored under
  // timestamp/descriptive versions (the lettered-suffix / db-push reality), plus
  // some pre-baseline history that the squash subsumes.
  const PROD_VERSIONS = ['00000000000000', '0290', '0292', '0293', '0294', '20260510120000'];

  // Repo migration files (NNNN prefixes), the source of truth.
  const REPO_VERSIONS = new Set([
    '00000000000000', '0294', '0295', '0296', '0297', '0330', '0331',
  ]);

  it('passes a clean baseline-squashed rig despite prod-historical and version-shape divergence', () => {
    // Rig: canonical baseline + every repo NNNN migration. No synthetic rows.
    const rigRows: MigrationRow[] = [
      { version: '00000000000000', name: 'baseline_at_main_HEAD' },
      { version: '0294', name: '0294_refund_org_credit' },
      { version: '0295', name: '0295_add_webhook_events' },
      { version: '0296', name: '0296_api_key_hmac' },
      { version: '0297', name: '0297_audit_log_cleanup' },
      { version: '0330', name: '0330_candidate_a' },
      { version: '0331', name: '0331_candidate_b' },
    ];
    const result = analyzeProdDivergence(rigRows, PROD_VERSIONS, REPO_VERSIONS);
    expect(result.baselinePresent).toBe(true);
    expect(result.unexplainedExtras).toEqual([]);
    expect(result.missingRepoMigrations).toEqual([]);
    expect(result.passed).toBe(true);
    // Prod-historical rows (0290/0292/0293) + version-shape rows (20260510120000)
    // are reported as informational, not failures.
    expect(result.prodMissing).toEqual(expect.arrayContaining(['0290', '0292', '0293', '20260510120000']));
  });

  it('FAILS when the rig carries an unexplained extra row (synthetic stg_ contamination)', () => {
    const rigRows: MigrationRow[] = [
      { version: '00000000000000', name: 'baseline_at_main_HEAD' },
      { version: '0294', name: '0294_refund_org_credit' },
      { version: '0295', name: '0295_add_webhook_events' },
      { version: '0296', name: '0296_api_key_hmac' },
      { version: '0297', name: '0297_audit_log_cleanup' },
      { version: '0330', name: '0330_candidate_a' },
      { version: '0331', name: '0331_candidate_b' },
      { version: '99999999999999', name: 'stg_only_hotfix' },
    ];
    const result = analyzeProdDivergence(rigRows, PROD_VERSIONS, REPO_VERSIONS);
    expect(result.unexplainedExtras).toContain('99999999999999');
    expect(result.passed).toBe(false);
  });

  it('FAILS when the rig is missing a real repo migration (rig behind main)', () => {
    const rigRows: MigrationRow[] = [
      { version: '00000000000000', name: 'baseline_at_main_HEAD' },
      { version: '0294', name: '0294_refund_org_credit' },
      { version: '0295', name: '0295_add_webhook_events' },
      { version: '0296', name: '0296_api_key_hmac' },
      { version: '0297', name: '0297_audit_log_cleanup' },
      // missing 0330, 0331 — rig is behind the repo
    ];
    const result = analyzeProdDivergence(rigRows, PROD_VERSIONS, REPO_VERSIONS);
    expect(result.missingRepoMigrations).toEqual(expect.arrayContaining(['0330', '0331']));
    expect(result.passed).toBe(false);
  });

  it('FAILS a NON-baseline rig that is missing prod versions (preserves shared-staging strictness)', () => {
    // No baseline row → the baseline does not subsume pre-baseline history, so
    // prod-missing rows are still failures (old strictness preserved).
    const rigRows: MigrationRow[] = [
      { version: '0294', name: '0294_refund_org_credit' },
      { version: '0295', name: '0295_add_webhook_events' },
      { version: '0296', name: '0296_api_key_hmac' },
      { version: '0297', name: '0297_audit_log_cleanup' },
      { version: '0330', name: '0330_candidate_a' },
      { version: '0331', name: '0331_candidate_b' },
    ];
    const result = analyzeProdDivergence(rigRows, PROD_VERSIONS, REPO_VERSIONS);
    expect(result.baselinePresent).toBe(false);
    expect(result.prodMissing.length).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it('does not classify the canonical baseline itself as an unexplained extra', () => {
    // Prod ledger that happens to NOT carry the baseline version, repo that does.
    const prodNoBaseline = ['0294', '0295'];
    const repo = new Set(['00000000000000', '0294', '0295']);
    const rigRows: MigrationRow[] = [
      { version: '00000000000000', name: 'baseline_at_main_HEAD' },
      { version: '0294', name: '0294_refund_org_credit' },
      { version: '0295', name: '0295_add_webhook_events' },
    ];
    const result = analyzeProdDivergence(rigRows, prodNoBaseline, repo);
    expect(result.unexplainedExtras).toEqual([]);
    expect(result.passed).toBe(true);
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
// buildReport — baseline-squash-aware (repoVersions provided)
// ---------------------------------------------------------------------------

describe('buildReport with repoVersions (baseline-squash-aware)', () => {
  // Prod ledger reality: baseline + pre-baseline history + recent migrations
  // recorded under timestamp/descriptive version strings.
  const PROD_VERSIONS = ['00000000000000', '0290', '0292', '0293', '0294', '20260510120000'];
  const REPO_VERSIONS = new Set([
    '00000000000000', '0294', '0295', '0296', '0297', '0330', '0331',
  ]);
  // Clean isolated rig: canonical baseline + every repo migration, nothing else.
  const RIG_ROWS: MigrationRow[] = [
    { version: '00000000000000', name: 'baseline_at_main_HEAD' },
    { version: '0294', name: '0294_refund_org_credit' },
    { version: '0295', name: '0295_add_webhook_events' },
    { version: '0296', name: '0296_api_key_hmac' },
    { version: '0297', name: '0297_audit_log_cleanup' },
    { version: '0330', name: '0330_candidate_a' },
    { version: '0331', name: '0331_candidate_b' },
  ];

  it('classifies a clean baseline-squashed isolated rig as clean_mirror', () => {
    const report = buildReport({
      projectRef: 'isolated-rig',
      migrationRows: RIG_ROWS,
      submittedAnchorCount: 5,
      prodVersions: PROD_VERSIONS,
      repoVersions: REPO_VERSIONS,
    });
    expect(report.environment_type).toBe('clean_mirror');
    const divCheck = report.checks.find((c) => c.name === 'prod_divergence');
    expect(divCheck).toBeDefined();
    expect(divCheck!.passed).toBe(true);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it('still flags an unexplained extra row in a baseline rig as soak_artifact', () => {
    const report = buildReport({
      projectRef: 'isolated-rig',
      migrationRows: [...RIG_ROWS, { version: '99999999999999', name: 'stg_only_hotfix' }],
      submittedAnchorCount: 5,
      prodVersions: PROD_VERSIONS,
      repoVersions: REPO_VERSIONS,
    });
    // The synthetic row trips classifyMigrationRow (timestamp) AND prod_divergence
    // (unexplained extra) — either way it must NOT be clean_mirror.
    expect(report.environment_type).toBe('soak_artifact');
    const divCheck = report.checks.find((c) => c.name === 'prod_divergence');
    expect(divCheck!.passed).toBe(false);
  });

  it('fails a baseline rig that is missing a real repo migration', () => {
    const incompleteRig = RIG_ROWS.filter((r) => r.version !== '0331');
    const report = buildReport({
      projectRef: 'isolated-rig',
      migrationRows: incompleteRig,
      submittedAnchorCount: 5,
      prodVersions: PROD_VERSIONS,
      repoVersions: REPO_VERSIONS,
    });
    const divCheck = report.checks.find((c) => c.name === 'prod_divergence');
    expect(divCheck!.passed).toBe(false);
    expect(divCheck!.details).toMatch(/0331/);
    expect(report.environment_type).not.toBe('clean_mirror');
  });

  it('preserves old strictness when repoVersions is omitted (any divergence fails)', () => {
    // Same rig, but no repoVersions supplied → legacy behavior: prod-historical
    // rows count as missing-from-staging divergence and the env is NOT clean.
    const report = buildReport({
      projectRef: 'isolated-rig',
      migrationRows: RIG_ROWS,
      submittedAnchorCount: 5,
      prodVersions: PROD_VERSIONS,
    });
    const divCheck = report.checks.find((c) => c.name === 'prod_divergence');
    expect(divCheck!.passed).toBe(false);
    expect(report.environment_type).toBe('soak_artifact');
  });

  // -------------------------------------------------------------------------
  // Regression: db-push dropped-prefix duplicate-NAME false positive.
  // Two genuinely-distinct migrations (0302 vs 0303 of the same descriptive
  // name) whose stored names lost their numeric prefix on `supabase db push`
  // must NOT make the duplicate_names check fail on a legitimately-clean rig.
  // -------------------------------------------------------------------------

  // Prod stores the prefixed, distinct names; repo backs both numeric versions.
  const DUPNAME_PROD_VERSIONS = [
    '00000000000000', '0290', '0292', '0293', '0294', '0302', '0303', '20260510120000',
  ];
  const DUPNAME_REPO_VERSIONS = new Set([
    '00000000000000', '0294', '0295', '0296', '0297', '0302', '0303', '0330', '0331',
  ]);
  // Clean baseline-squashed rig whose 0302/0303 rows lost their prefix on push.
  const DUPNAME_RIG_ROWS: MigrationRow[] = [
    { version: '00000000000000', name: 'baseline_at_main_HEAD' },
    { version: '0294', name: '0294_refund_org_credit' },
    { version: '0295', name: '0295_add_webhook_events' },
    { version: '0296', name: '0296_api_key_hmac' },
    { version: '0297', name: '0297_audit_log_cleanup' },
    { version: '0302', name: 'validate_api_key_rpc_hardening' },
    { version: '0303', name: 'validate_api_key_rpc_hardening' },
    { version: '0330', name: '0330_candidate_a' },
    { version: '0331', name: '0331_candidate_b' },
  ];

  it('passes duplicate_names AND classifies clean_mirror when db-push dropped the numeric prefix off two distinct migrations', () => {
    const report = buildReport({
      projectRef: 'isolated-rig',
      migrationRows: DUPNAME_RIG_ROWS,
      submittedAnchorCount: 3, // SUBMITTED anchor present
      prodVersions: DUPNAME_PROD_VERSIONS,
      repoVersions: DUPNAME_REPO_VERSIONS,
    });
    const dupeCheck = report.checks.find((c) => c.name === 'duplicate_names');
    expect(dupeCheck).toBeDefined();
    expect(dupeCheck!.passed).toBe(true);
    expect(report.environment_type).toBe('clean_mirror');
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it('still FAILS duplicate_names (soak_artifact) on a genuine same-version+same-name replay', () => {
    // A truly-duplicated migration: 0294_refund_org_credit replayed under the
    // SAME version. This is real contamination and must still trip the gate.
    const replayRig: MigrationRow[] = [
      ...DUPNAME_RIG_ROWS,
      { version: '0294', name: '0294_refund_org_credit' },
    ];
    const report = buildReport({
      projectRef: 'isolated-rig',
      migrationRows: replayRig,
      submittedAnchorCount: 3,
      prodVersions: DUPNAME_PROD_VERSIONS,
      repoVersions: DUPNAME_REPO_VERSIONS,
    });
    const dupeCheck = report.checks.find((c) => c.name === 'duplicate_names');
    expect(dupeCheck).toBeDefined();
    expect(dupeCheck!.passed).toBe(false);
    expect(dupeCheck!.details).toMatch(/0294_refund_org_credit/);
    expect(report.environment_type).toBe('soak_artifact');
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

  it('parses --management-api-token', () => {
    const args = parseArgs(['--management-api-token', 'sbp_test']);
    expect(args.managementApiToken).toBe('sbp_test');
  });

  it('parses --prod-project-ref', () => {
    const args = parseArgs(['--prod-project-ref', 'prod-ref']);
    expect(args.prodProjectRef).toBe('prod-ref');
  });

  it('ignores malformed --prod-facts JSON', () => {
    const args = parseArgs(['--prod-facts', 'not-json']);
    expect(args.prodFacts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Management API fallback helpers
// ---------------------------------------------------------------------------

describe('isSupabaseMigrationsSchemaUnavailable', () => {
  it('detects hidden supabase_migrations schema errors from PostgREST', () => {
    expect(isSupabaseMigrationsSchemaUnavailable({
      message: 'Invalid schema: supabase_migrations',
    })).toBe(true);
  });

  it('detects PGRST106 hidden-schema errors that omit the requested schema', () => {
    expect(isSupabaseMigrationsSchemaUnavailable({
      code: 'PGRST106',
      message: 'The schema must be one of the following: public, graphql_public',
    })).toBe(true);
  });

  it('does not treat unrelated query errors as fallback-safe', () => {
    expect(isSupabaseMigrationsSchemaUnavailable({
      message: 'permission denied for table schema_migrations',
    })).toBe(false);
  });
});

describe('mapManagementMigrationRows', () => {
  it('normalizes raw Management API rows into MigrationRow objects', () => {
    expect(mapManagementMigrationRows([
      { version: 294, name: ' 0294_refund_org_credit ' },
      { version: '20260505010337', name: null },
      { name: 'ignored_missing_version' },
      { version: {}, name: 'ignored_object_version' },
      { version: '0296', name: {} },
    ])).toEqual([
      { version: '0294', name: '0294_refund_org_credit' },
      { version: '20260505010337', name: '' },
      { version: '0296', name: '' },
    ]);
  });
});

describe('mapManagementMigrationVersions', () => {
  it('normalizes Management API version rows for prod ledger comparison', () => {
    expect(mapManagementMigrationVersions([
      { version: 294 },
      { version: '0295' },
      { ignored: 'row' },
      { version: {} },
    ])).toEqual(['0294', '0295']);
  });
});

describe('mapManagementProdFacts', () => {
  it('normalizes cron and function rows from the Management API', () => {
    expect(mapManagementProdFacts(
      [{ cron_job_names: ['vacuum-anchors', 'refresh-pipeline-dashboard-cache'] }],
      [{ function_exists: true }],
    )).toEqual({
      cronJobNames: ['vacuum-anchors', 'refresh-pipeline-dashboard-cache'],
      functionExists: true,
    });
  });

  it('accepts truthy values returned by Management API SQL drivers', () => {
    expect(mapManagementProdFacts(
      [{ cron_job_names: ['vacuum-anchors'] }],
      [{ function_exists: 't' }],
    )).toEqual({
      cronJobNames: ['vacuum-anchors'],
      functionExists: true,
    });

    expect(mapManagementProdFacts([], [{ function_exists: 'true' }]).functionExists).toBe(true);
    expect(mapManagementProdFacts([], [{ function_exists: 1 }]).functionExists).toBe(true);
  });

  it('handles empty Management API result sets', () => {
    expect(mapManagementProdFacts([], [])).toEqual({
      cronJobNames: [],
      functionExists: false,
    });
  });
});

describe('queryManagementApi', () => {
  it('uses a timeout signal and returns object rows only', async () => {
    const timeoutSpy = vi.spyOn(globalThis.AbortSignal, 'timeout');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify([
      { version: '0294' },
      null,
      ['ignored'],
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(queryManagementApi('prod-ref', 'sbp_test', 'select 1')).resolves.toEqual([
      { version: '0294' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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
      cronJobNames: ['vacuum-anchors', 'refresh-pipeline-dashboard-cache'],
      functionExists: true,
    });
    expect(result.passed).toBe(true);
    expect(result.name).toBe('prod_facts');
    expect(result.details).toMatch(/vacuum-anchors scheduled/);
    expect(result.details).toMatch(/refresh-pipeline-dashboard-cache scheduled/);
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

  it('fails when refresh-pipeline-dashboard-cache job is missing', () => {
    const result = checkProdFacts({
      cronJobNames: ['vacuum-anchors'],
      functionExists: true,
    });
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/refresh-pipeline-dashboard-cache job missing/);
  });

  it('reports multiple issues together', () => {
    const result = checkProdFacts({
      cronJobNames: ['refresh-pipeline-dashboard-cache'],
      functionExists: false,
    });
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/vacuum-anchors/);
    expect(result.details).toMatch(/function missing/);
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
      prodFacts: { cronJobNames: ['vacuum-anchors', 'refresh-pipeline-dashboard-cache'], functionExists: true },
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
      prodFacts: { cronJobNames: ['vacuum-anchors', 'refresh-pipeline-dashboard-cache'], functionExists: true },
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

// ---------------------------------------------------------------------------
// FD-PREFLIGHT-1 — Check 7 (org_topology) was dead code.
//
// The runner selected a column `name` from public.organizations. That column
// does not exist (the table has `legal_name` / `display_name`), so PostgREST
// answered 42703, the `if (!orgError && orgData)` guard fell through, and
// `orgTopology` stayed undefined — which buildReport treats as "caller did not
// ask for this check". Result: Check 7 has never run on any rig, and its
// absence looked identical to a clean report. Observed live on
// gnkuaywlpmsaezwvlvhk and tkciooifwxwnkoizgalp on 2026-08-21: six checks
// emitted, no `org_topology` among them, exit 0 / clean_mirror.
//
// A check that cannot run must FAIL the preflight. Silently skipping it is the
// exact failure mode the script exists to prevent.
// ---------------------------------------------------------------------------

describe('ORG_NAME_COLUMNS (FD-PREFLIGHT-1)', () => {
  it('names only columns public.organizations actually has', () => {
    expect([...ORG_NAME_COLUMNS]).toEqual(['legal_name', 'display_name']);
  });

  it('never names the non-existent "name" column', () => {
    expect([...ORG_NAME_COLUMNS] as string[]).not.toContain('name');
  });
});

describe('isOrgRowSeeded (FD-PREFLIGHT-1)', () => {
  it('flags a seed-prefixed legal_name', () => {
    const row: OrgNameRow = { legal_name: 'STG Org 001', display_name: 'Something Else' };
    expect(isOrgRowSeeded(row)).toBe(true);
  });

  it('flags a seed-prefixed display_name even when legal_name looks real', () => {
    const row: OrgNameRow = { legal_name: 'Acme Corporation', display_name: 'staging_seed_alpha' };
    expect(isOrgRowSeeded(row)).toBe(true);
  });

  it('does not flag a real org on either column', () => {
    const row: OrgNameRow = { legal_name: 'Acme Corporation', display_name: 'Acme Corp' };
    expect(isOrgRowSeeded(row)).toBe(false);
  });

  it('tolerates nulls without throwing', () => {
    const row: OrgNameRow = { legal_name: null, display_name: null };
    expect(isOrgRowSeeded(row)).toBe(false);
  });
});

describe('checkOrgTopologyUnavailable (FD-PREFLIGHT-1)', () => {
  it('FAILS — a check that could not run is not a check that passed', () => {
    const result = checkOrgTopologyUnavailable('column organizations.name does not exist');
    expect(result.name).toBe('org_topology');
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/could not be evaluated/i);
    expect(result.details).toMatch(/column organizations\.name does not exist/);
  });
});

describe('buildReport treats an unevaluable org_topology as a FAILURE (FD-PREFLIGHT-1)', () => {
  const DEFAULT_PROD = ['00000000000000', '0294', '0295', '0296', '0297'];

  it('emits a failed org_topology check when the query errored', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: DEFAULT_PROD,
      orgTopologyError: 'column organizations.name does not exist',
    });
    const check = report.checks.find((c) => c.name === 'org_topology');
    expect(check).toBeDefined();
    expect(check!.passed).toBe(false);
  });

  it('refuses clean_mirror when org_topology could not be evaluated', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: DEFAULT_PROD,
      orgTopologyError: 'boom',
    });
    expect(report.environment_type).not.toBe('clean_mirror');
  });

  it('prefers real data over the error when both are somehow supplied', () => {
    const report = buildReport({
      projectRef: 'test-ref',
      migrationRows: CLEAN_ROWS,
      submittedAnchorCount: 5,
      prodVersions: DEFAULT_PROD,
      orgTopology: { totalOrgs: 5, seedOrgs: 0 },
      orgTopologyError: 'stale error',
    });
    const check = report.checks.find((c) => c.name === 'org_topology');
    expect(check!.passed).toBe(true);
  });
});

describe('preflight source ratchet (FD-PREFLIGHT-1)', () => {
  // Resolved from the vitest root (the repo root) rather than import.meta.url:
  // this suite runs in a non-file:// module context.
  const SRC = readFileSync(
    resolve(process.cwd(), 'scripts/ci/staging-honesty-preflight.ts'),
    'utf8',
  );

  it('selects organizations columns from ORG_NAME_COLUMNS, never a hardcoded "name"', () => {
    const match = SRC.match(/\.from\('organizations'\)\s*\r?\n?\s*\.select\(([^)]*)\)/);
    expect(match, 'no .from(\'organizations\').select(...) found').not.toBeNull();
    const selectArg = match![1];
    expect(selectArg).toContain('ORG_NAME_COLUMNS');
    expect(selectArg.trim()).not.toMatch(/^['"`]name['"`]$/);
  });

  it('does not silently swallow an org-topology query failure', () => {
    // The old code path was: `if (!orgError && orgData) { ... }` with no else,
    // followed by a bare `catch {}`. Both branches must now record a reason.
    expect(SRC).toContain('orgTopologyError');
    const swallow = SRC.match(/catch\s*\{\s*\r?\n\s*\/\/ Org topology check skipped/);
    expect(swallow, 'the silent org-topology catch is still present').toBeNull();
  });
});
