/**
 * Tests for check-rls-policy-coverage.ts (SCRUM-1275).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  runLintScript,
  makeTempMigrationsRepo,
} from './lib/migration-lint-test-helpers';

const SCRIPT = join(process.cwd(), 'scripts/ci/check-rls-policy-coverage.ts');
const ENV_VAR = 'RLS_POLICY_COVERAGE_REPO_ROOT';

const run = (repoRoot: string) => runLintScript(SCRIPT, ENV_VAR, repoRoot);

function rlsForceFor(table: string): string {
  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;\nALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`;
}

function writeMigration(repoRoot: string, name: string, sql: string): void {
  writeFileSync(join(repoRoot, 'supabase/migrations/', name), sql);
}

function writeBaseline(repoRoot: string, grandfathered: string[]): void {
  mkdirSync(join(repoRoot, 'scripts/ci/snapshots'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'scripts/ci/snapshots/rls-policy-coverage-baseline.json'),
    JSON.stringify({ grandfathered }),
  );
}

describe('check-rls-policy-coverage', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempMigrationsRepo('arkova-rls-coverage-');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('passes when no migrations enable RLS', () => {
    writeMigration(repoRoot, '0001_init.sql', 'CREATE TABLE foo (id int);');
    const { code, stdout } = run(repoRoot);
    expect(code).toBe(0);
    expect(stdout).toContain('No tables with bare ENABLE+FORCE');
  });

  it('passes when ENABLE + CREATE POLICY are in the same migration', () => {
    writeMigration(
      repoRoot,
      '0001_table.sql',
      `CREATE TABLE foo (id int);\n${rlsForceFor('foo')}\n` +
        `CREATE POLICY foo_service ON foo FOR ALL TO service_role USING (true) WITH CHECK (true);`,
    );
    expect(run(repoRoot).code).toBe(0);
  });

  it('passes when policy is in a later migration', () => {
    writeMigration(repoRoot, '0001_table.sql', `CREATE TABLE foo (id int);\n${rlsForceFor('foo')}`);
    writeMigration(
      repoRoot,
      '0002_policy.sql',
      `CREATE POLICY foo_service ON foo FOR ALL TO service_role USING (true);`,
    );
    expect(run(repoRoot).code).toBe(0);
  });

  it('passes when DELIBERATE deny-all comment is present', () => {
    writeMigration(
      repoRoot,
      '0001_quarantined.sql',
      `CREATE TABLE legacy_quarantine (id int);\n${rlsForceFor('legacy_quarantine')}\n` +
        `COMMENT ON TABLE legacy_quarantine IS 'Deny-all by design (R3-2). See SCRUM-XXXX.';`,
    );
    expect(run(repoRoot).code).toBe(0);
  });

  it('fails when ENABLE+FORCE is set with no policy and no deny-all comment', () => {
    writeMigration(repoRoot, '0001_silent.sql', `CREATE TABLE silent (id int);\n${rlsForceFor('silent')}`);
    const { code, stderr } = run(repoRoot);
    expect(code).toBe(1);
    expect(stderr).toContain('SCRUM-1275');
    expect(stderr).toContain('silent');
  });

  it('grandfathers tables in the snapshot baseline', () => {
    writeMigration(repoRoot, '0001_legacy.sql', `CREATE TABLE legacy (id int);\n${rlsForceFor('legacy')}`);
    writeBaseline(repoRoot, ['legacy']);
    expect(run(repoRoot).code).toBe(0);
  });

  it('treats only ENABLE without FORCE as a non-issue (force is what blocks service_role)', () => {
    writeMigration(
      repoRoot,
      '0001_enable_only.sql',
      `CREATE TABLE foo (id int);\nALTER TABLE foo ENABLE ROW LEVEL SECURITY;`,
    );
    expect(run(repoRoot).code).toBe(0);
  });

  it('handles schema-qualified table names', () => {
    writeMigration(repoRoot, '0001_qualified.sql', rlsForceFor('public.qualified'));
    const { code, stderr } = run(repoRoot);
    expect(code).toBe(1);
    expect(stderr).toContain('qualified');
  });
});
