/**
 * Tests for check-rls-policy-coverage.ts (SCRUM-1275).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'scripts/ci/check-rls-policy-coverage.ts');

function runIn(repoRoot: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('npx', ['tsx', SCRIPT], {
    cwd: process.cwd(),
    env: { ...process.env, RLS_POLICY_COVERAGE_REPO_ROOT: repoRoot },
    encoding: 'utf8',
  });
  return { code: res.status ?? 0, stdout: res.stdout, stderr: res.stderr };
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'arkova-rls-coverage-'));
  mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true });
  return root;
}

describe('check-rls-policy-coverage', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeRepo();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('passes when no migrations enable RLS', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_init.sql'),
      'CREATE TABLE foo (id int);',
    );
    const { code, stdout } = runIn(repoRoot);
    expect(code).toBe(0);
    expect(stdout).toContain('No tables with bare ENABLE+FORCE');
  });

  it('passes when ENABLE + CREATE POLICY are in the same migration', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_table.sql'),
      `CREATE TABLE foo (id int);
ALTER TABLE foo ENABLE ROW LEVEL SECURITY;
ALTER TABLE foo FORCE ROW LEVEL SECURITY;
CREATE POLICY foo_service ON foo FOR ALL TO service_role USING (true) WITH CHECK (true);`,
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });

  it('passes when policy is in a later migration', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_table.sql'),
      `CREATE TABLE foo (id int);
ALTER TABLE foo ENABLE ROW LEVEL SECURITY;
ALTER TABLE foo FORCE ROW LEVEL SECURITY;`,
    );
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0002_policy.sql'),
      `CREATE POLICY foo_service ON foo FOR ALL TO service_role USING (true);`,
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });

  it('passes when DELIBERATE deny-all comment is present', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_quarantined.sql'),
      `CREATE TABLE legacy_quarantine (id int);
ALTER TABLE legacy_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_quarantine FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE legacy_quarantine IS 'Deny-all by design (R3-2). See SCRUM-XXXX.';`,
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });

  it('fails when ENABLE+FORCE is set with no policy and no deny-all comment', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_silent.sql'),
      `CREATE TABLE silent (id int);
ALTER TABLE silent ENABLE ROW LEVEL SECURITY;
ALTER TABLE silent FORCE ROW LEVEL SECURITY;`,
    );
    const { code, stderr } = runIn(repoRoot);
    expect(code).toBe(1);
    expect(stderr).toContain('SCRUM-1275');
    expect(stderr).toContain('silent');
  });

  it('grandfathers tables in the snapshot baseline', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_legacy.sql'),
      `CREATE TABLE legacy (id int);
ALTER TABLE legacy ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy FORCE ROW LEVEL SECURITY;`,
    );
    mkdirSync(join(repoRoot, 'scripts/ci/snapshots'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'scripts/ci/snapshots/rls-policy-coverage-baseline.json'),
      JSON.stringify({ grandfathered: ['legacy'] }),
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });

  it('treats only ENABLE without FORCE as a non-issue (force is what blocks service_role)', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_enable_only.sql'),
      `CREATE TABLE foo (id int);
ALTER TABLE foo ENABLE ROW LEVEL SECURITY;`,
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });

  it('handles schema-qualified table names', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_qualified.sql'),
      `ALTER TABLE public.qualified ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qualified FORCE ROW LEVEL SECURITY;`,
    );
    const { code, stderr } = runIn(repoRoot);
    expect(code).toBe(1);
    expect(stderr).toContain('qualified');
  });
});
