import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = readFileSync(resolve(process.cwd(), 'scripts/ci-supabase-start.sh'), 'utf8');
const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

describe('ci-supabase-start registry fallbacks', () => {
  it('pre-seeds the postgres-meta image used by generated types from GHCR before Supabase starts', () => {
    expect(script).toContain('seed_supabase_ecr_image_from_ghcr');
    expect(script).toContain('public.ecr.aws/supabase/postgres-meta:v0.96.1');
    expect(script).toContain('ghcr.io/supabase/postgres-meta:v0.96.1');

    const seedIndex = script.indexOf('seed_supabase_ecr_image_from_ghcr');
    const startIndex = script.indexOf('echo "Starting Supabase..."');
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(seedIndex).toBeLessThan(startIndex);
  });
});

describe('aggregate test Supabase runtime', () => {
  it('uses a CLI that applies the MFA and custom access token hook config', () => {
    const testJob = workflow.match(/^[ ]{2}test:\n(?<body>[\s\S]*?)(?=^[ ]{2}[a-z][\w-]*:\n)/m)?.groups?.body;

    expect(testJob).toBeDefined();
    expect(testJob).toContain('version: 2.98.2');
    expect(testJob).toContain("CI_SUPABASE_STRIP_CONCURRENTLY: '1'");
    expect(testJob).toContain('test "${CI:-}" = "true"');
    expect(testJob).toContain('git diff --exit-code -- supabase/migrations');
    expect(testJob).toContain('git clean -fd -- supabase/migrations');

    const resetIndex = testJob!.indexOf('run: supabase db reset');
    const restoreIndex = testJob!.indexOf('git restore --source=HEAD --worktree -- supabase/migrations');
    const coverageIndex = testJob!.indexOf('run: npm run test:coverage');
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(resetIndex);
    expect(coverageIndex).toBeGreaterThan(restoreIndex);
  });

  it('restores edits and deletions and removes only renamed migration artifacts', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arkova-ci-migrations-'));
    const migrations = join(fixture, 'supabase', 'migrations');
    const original = join(migrations, '0068a_original.sql');
    const retained = join(migrations, '0451_retained.sql');
    const renamed = join(migrations, '00680_original.sql');

    try {
      mkdirSync(migrations, { recursive: true });
      execFileSync('git', ['init', '--quiet'], { cwd: fixture });
      execFileSync('git', ['config', 'user.email', 'ci-fixture@example.invalid'], { cwd: fixture });
      execFileSync('git', ['config', 'user.name', 'CI fixture'], { cwd: fixture });
      writeFileSync(original, 'original lettered migration\n');
      writeFileSync(retained, 'committed production DDL\n');
      execFileSync('git', ['add', 'supabase/migrations'], { cwd: fixture });
      execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: fixture });

      renameSync(original, renamed);
      writeFileSync(retained, 'CI-rewritten DDL\n');
      writeFileSync(join(migrations, '99999_untracked.sql'), 'temporary migration\n');

      execFileSync('git', ['restore', '--source=HEAD', '--worktree', '--', 'supabase/migrations'], { cwd: fixture });
      execFileSync('git', ['clean', '-fd', '--', 'supabase/migrations'], { cwd: fixture });

      expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'supabase/migrations'], {
        cwd: fixture, encoding: 'utf8',
      })).toBe('');
      expect(readFileSync(original, 'utf8')).toBe('original lettered migration\n');
      expect(readFileSync(retained, 'utf8')).toBe('committed production DDL\n');
      expect(existsSync(renamed)).toBe(false);
      expect(existsSync(join(migrations, '99999_untracked.sql'))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
