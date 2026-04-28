/**
 * Tests for check-view-security-invoker.ts (SCRUM-1276).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'scripts/ci/check-view-security-invoker.ts');

function runIn(repoRoot: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('npx', ['tsx', SCRIPT], {
    cwd: process.cwd(),
    env: { ...process.env, VIEW_SECURITY_INVOKER_REPO_ROOT: repoRoot },
    encoding: 'utf8',
  });
  return { code: res.status ?? 0, stdout: res.stdout, stderr: res.stderr };
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'arkova-view-lint-'));
  mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true });
  return root;
}

describe('check-view-security-invoker', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeRepo();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('passes when no migrations create views', () => {
    writeFileSync(join(repoRoot, 'supabase/migrations/0001_init.sql'), 'CREATE TABLE foo (id int);');
    const { code, stdout } = runIn(repoRoot);
    expect(code).toBe(0);
    expect(stdout).toContain('No bare CREATE VIEW');
  });

  it('passes when CREATE VIEW has security_invoker=true on the same statement', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_view.sql'),
      `CREATE OR REPLACE VIEW public.foo WITH (security_invoker = true) AS SELECT 1;`,
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });

  it('passes when CREATE VIEW is followed by ALTER VIEW ... security_invoker=true in same migration', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_view.sql'),
      `CREATE OR REPLACE VIEW public.foo AS SELECT 1;
ALTER VIEW public.foo SET (security_invoker = true);`,
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });

  it('passes when CREATE VIEW carries the deliberate-definer override comment', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_view.sql'),
      `-- DELIBERATE: definer-rights view
CREATE OR REPLACE VIEW public.bar AS SELECT 1;`,
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });

  it('fails when CREATE VIEW lacks security_invoker and has no override comment', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_bad.sql'),
      `CREATE OR REPLACE VIEW public.leaky AS SELECT * FROM organizations;`,
    );
    const { code, stderr } = runIn(repoRoot);
    expect(code).toBe(1);
    expect(stderr).toContain('SCRUM-1276');
    expect(stderr).toContain('leaky');
  });

  it('ignores DO $$ template strings that programmatically build CREATE VIEW (one-shot loops)', () => {
    // 0112's `'CREATE OR REPLACE VIEW public.%I WITH (security_invoker = true) AS %s'`
    // template lives inside a quoted string, not as a top-level statement. Linter
    // must not flag it.
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_loop.sql'),
      `DO $$
BEGIN
  EXECUTE format(
    'CREATE OR REPLACE VIEW public.%I WITH (security_invoker = true) AS %s',
    v_name, v_def
  );
END $$;`,
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });

  it('finds the view name even when CREATE VIEW spans multiple lines', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_multi.sql'),
      `CREATE OR REPLACE VIEW public.multiline
AS
  SELECT 1;`,
    );
    const { code, stderr } = runIn(repoRoot);
    expect(code).toBe(1);
    expect(stderr).toContain('multiline');
  });

  it('grandfathers files listed in the snapshot baseline', () => {
    // Any migrations the script is told to grandfather are skipped.
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_grandfathered.sql'),
      `CREATE OR REPLACE VIEW public.legacy AS SELECT 1;`,
    );
    mkdirSync(join(repoRoot, 'scripts/ci/snapshots'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'scripts/ci/snapshots/view-security-invoker-baseline.json'),
      JSON.stringify({ grandfathered: ['0001_grandfathered.sql'] }),
    );
    const { code } = runIn(repoRoot);
    expect(code).toBe(0);
  });
});
