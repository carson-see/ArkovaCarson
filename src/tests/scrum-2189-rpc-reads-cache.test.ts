/**
 * SCRUM-2189: get_anchor_status_counts_fast() must read the
 * pipeline_dashboard_cache instead of doing live per-status count(*).
 *
 * Root cause: on the ~3.3M-row anchors table the function's 1s per-status
 * count budget always times out, so PENDING/SUBMITTED/BROADCASTING/REVOKED
 * return the -1 sentinel. The SCRUM-1708 cron already maintains correct
 * counts in pipeline_dashboard_cache (key 'anchor_status_counts'), so the
 * fix redefines the RPC to read that cache.
 *
 * These assertions read migration 0322 directly (the compensating migration),
 * mirroring the baseline-content test convention in rls-performance.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0324_anchor_status_counts_read_cache.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

function functionBlock(sql: string): string {
  const start = sql.indexOf('get_anchor_status_counts_fast');
  expect(start).toBeGreaterThan(-1);
  // Body runs to the closing $$; of the function definition.
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('SCRUM-2189: get_anchor_status_counts_fast reads the cache', () => {
  it('migration 0322 redefines the function', () => {
    const sql = migration();
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION[\s\S]*get_anchor_status_counts_fast/,
    );
  });

  it('reads from pipeline_dashboard_cache with key anchor_status_counts', () => {
    const block = functionBlock(migration());
    expect(block).toContain('pipeline_dashboard_cache');
    expect(block).toContain("'anchor_status_counts'");
  });

  it('no longer runs live per-status count(*) on anchors', () => {
    const block = functionBlock(migration());
    expect(block).not.toMatch(/count\(\*\)\s+INTO[\s\S]*FROM\s+anchors/i);
    // The per-status 1s budget loop is what timed out — it must be gone.
    expect(block).not.toMatch(/SET LOCAL statement_timeout\s*=\s*'1s'/i);
  });

  it('preserves the platform-admin / service_role access guard', () => {
    const block = functionBlock(migration());
    expect(block).toContain('get_caller_role()');
    expect(block).toContain('is_platform_admin');
    expect(block).toMatch(/RAISE EXCEPTION/i);
  });

  it('returns the frozen JSON shape (all six keys)', () => {
    const block = functionBlock(migration());
    for (const key of [
      'PENDING',
      'SUBMITTED',
      'BROADCASTING',
      'SECURED',
      'REVOKED',
      'total',
    ]) {
      expect(block).toContain(`'${key}'`);
    }
  });

  it('falls back to -1 sentinels when the cache row is absent', () => {
    const block = functionBlock(migration());
    expect(block).toContain('-1');
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:/i);
  });
});
