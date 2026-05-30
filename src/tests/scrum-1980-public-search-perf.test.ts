/**
 * SCRUM-1980: public-search RPC timeouts.
 *
 * Production EXPLAIN evidence:
 *  - search_public_credentials with a 2-char query cannot use the trigram GIN
 *    indexes (pg_trgm needs 3-char trigrams), so the planner falls back to an
 *    idx_anchors_status_secured_submitted scan (cost ~2.3M) that filters ILIKE
 *    row-by-row over the ~3.3M-row anchors table → 5s statement_timeout.
 *    3+ char queries already use the fast BitmapOr-over-trigram plan.
 *    Fix: require length >= 3 (the trigram floor).
 *  - search_public_record_embeddings has no ANN index (exact-KNN full scan)
 *    and no statement_timeout → unbounded. search_public_credential_embeddings
 *    has HNSW but is also unbounded. Add a defensive statement_timeout to both.
 *
 * These assertions read migration 0323 directly, mirroring the baseline-content
 * test convention in rls-performance.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0325_public_search_min_length_and_timeouts.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

function functionBlock(sql: string, fnName: string): string {
  const start = sql.indexOf(`FUNCTION public.${fnName}`);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('SCRUM-1980: public search performance', () => {
  it('migration 0323 redefines the three public search functions', () => {
    const sql = migration();
    expect(sql).toContain('FUNCTION public.search_public_credentials');
    expect(sql).toContain('FUNCTION public.search_public_credential_embeddings');
    expect(sql).toContain('FUNCTION public.search_public_record_embeddings');
  });

  describe('search_public_credentials min-length floor', () => {
    it('requires at least 3 characters (the pg_trgm trigram floor)', () => {
      const block = functionBlock(migration(), 'search_public_credentials');
      expect(block).toMatch(/length\(trim\(p_query\)\)\s*<\s*3/);
    });

    it('no longer accepts 2-char queries (the timeout case)', () => {
      const block = functionBlock(migration(), 'search_public_credentials');
      expect(block).not.toMatch(/length\(trim\(p_query\)\)\s*<\s*2/);
    });

    it('still substring-searches filename and description via ILIKE', () => {
      const block = functionBlock(migration(), 'search_public_credentials');
      expect(block).toContain('a.filename    ILIKE v_pattern');
      expect(block).toContain('a.description ILIKE v_pattern');
    });

    it('preserves the frozen result keys', () => {
      const block = functionBlock(migration(), 'search_public_credentials');
      for (const key of ['public_id', 'title', 'credential_type', 'status']) {
        expect(block).toContain(`'${key}'`);
      }
    });
  });

  describe('embedding functions are time-bounded', () => {
    it('search_public_credential_embeddings sets a statement_timeout', () => {
      const block = functionBlock(
        migration(),
        'search_public_credential_embeddings',
      );
      expect(block).toMatch(/SET statement_timeout TO '\d+s'/);
    });

    it('search_public_record_embeddings sets a statement_timeout', () => {
      const block = functionBlock(
        migration(),
        'search_public_record_embeddings',
      );
      expect(block).toMatch(/SET statement_timeout TO '\d+s'/);
    });
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:/i);
  });
});
