/**
 * Tests for check-views-security-invoker.ts (SCRUM-1276).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  runLintScript,
  makeTempMigrationsRepo,
} from './lib/migration-lint-test-helpers';

const SCRIPT = join(process.cwd(), 'scripts/ci/check-views-security-invoker.ts');
const ENV_VAR = 'VIEW_SECURITY_INVOKER_REPO_ROOT';

const run = (repoRoot: string) => runLintScript(SCRIPT, ENV_VAR, repoRoot);

function writeMigration(repoRoot: string, file: string, sql: string): void {
  writeFileSync(join(repoRoot, `supabase/migrations/${file}`), sql);
}

function expectBareViewFailure(repoRoot: string, file: string, sql: string, view = 'leaky'): void {
  writeMigration(repoRoot, file, sql);
  const { code, stderr } = run(repoRoot);
  expect(code).toBe(1);
  expect(stderr).toContain(view);
}

function writeBaseline(repoRoot: string, grandfathered: string[]): void {
  mkdirSync(join(repoRoot, 'scripts/ci/snapshots'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'scripts/ci/snapshots/views-security-invoker-baseline.json'),
    JSON.stringify({ grandfathered }),
  );
}

describe('check-views-security-invoker', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempMigrationsRepo('arkova-view-lint-');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('passes when no migrations create views', () => {
    writeFileSync(join(repoRoot, 'supabase/migrations/0001_init.sql'), 'CREATE TABLE foo (id int);');
    const { code, stdout } = run(repoRoot);
    expect(code).toBe(0);
    expect(stdout).toContain('no new bare CREATE VIEW');
  });

  it('passes when CREATE VIEW has security_invoker=true on the same statement', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_view.sql'),
      `CREATE OR REPLACE VIEW public.foo WITH (security_invoker = true) AS SELECT 1;`,
    );
    expect(run(repoRoot).code).toBe(0);
  });

  it('passes when CREATE VIEW is followed by ALTER VIEW ... security_invoker=true in same migration', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_view.sql'),
      `CREATE OR REPLACE VIEW public.foo AS SELECT 1;
ALTER VIEW public.foo SET (security_invoker = true);`,
    );
    expect(run(repoRoot).code).toBe(0);
  });

  it('passes when CREATE VIEW carries the deliberate-definer override comment', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_view.sql'),
      `-- DELIBERATE: definer-rights view
CREATE OR REPLACE VIEW public.bar AS SELECT 1;`,
    );
    expect(run(repoRoot).code).toBe(0);
  });

  it('fails when CREATE VIEW lacks security_invoker and has no override comment', () => {
    expectBareViewFailure(
      repoRoot,
      '0001_bad.sql',
      `CREATE OR REPLACE VIEW public.leaky AS SELECT * FROM organizations;`,
    );
  });

  it('ignores DO $$ template strings that programmatically build CREATE VIEW', () => {
    writeFileSync(
      join(repoRoot, 'supabase/migrations/0001_loop.sql'),
      `DO $$
BEGIN
  EXECUTE format(
    'CREATE OR REPLACE VIEW public.%I AS %s',
    v_name, v_def
  );
END $$;`,
    );
    expect(run(repoRoot).code).toBe(0);
  });

  it('does not accept security_invoker text from a later unrelated statement', () => {
    expectBareViewFailure(
      repoRoot,
      '0001_bad_nearby_text.sql',
      `CREATE OR REPLACE VIEW public.leaky AS SELECT 1;
COMMENT ON VIEW public.leaky IS 'security_invoker = true';`,
    );
  });

  it('does not accept security_invoker text from a same-statement string literal', () => {
    expectBareViewFailure(
      repoRoot,
      '0001_bad_same_statement_text.sql',
      `CREATE OR REPLACE VIEW public.leaky AS
  SELECT 'WITH (security_invoker = true)' AS fake_option;`,
    );
  });

  it('does not accept ALTER VIEW text from a later string literal', () => {
    expectBareViewFailure(
      repoRoot,
      '0001_bad_later_text.sql',
      `CREATE OR REPLACE VIEW public.leaky AS SELECT 1;
SELECT 'ALTER VIEW public.leaky SET (security_invoker = true);';`,
    );
  });

  it('does not accept the deliberate-definer override text from a string literal', () => {
    expectBareViewFailure(
      repoRoot,
      '0001_bad_fake_override.sql',
      `SELECT '
-- DELIBERATE: definer-rights view
';
CREATE OR REPLACE VIEW public.leaky AS SELECT 1;`,
    );
  });

  it('finds the view name even when CREATE VIEW spans multiple lines', () => {
    expectBareViewFailure(
      repoRoot,
      '0001_multi.sql',
      `CREATE OR REPLACE VIEW public.multiline
AS
  SELECT 1;`,
      'multiline',
    );
  });

  it('grandfathers files or views listed in the snapshot baseline', () => {
    writeMigration(repoRoot, '0001_grandfathered.sql', `CREATE OR REPLACE VIEW public.legacy AS SELECT 1;`);
    writeBaseline(repoRoot, ['0001_grandfathered.sql']);
    expect(run(repoRoot).code).toBe(0);
  });

  it('grandfathers bare views listed by normalized view name', () => {
    writeMigration(repoRoot, '0001_legacy_view.sql', `CREATE OR REPLACE VIEW public.legacy_view AS SELECT 1;`);
    writeBaseline(repoRoot, ['legacy_view']);
    expect(run(repoRoot).code).toBe(0);
  });
});
