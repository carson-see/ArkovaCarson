/**
 * SCRUM-2203: production embed-public-records cron times out every ~2 minutes.
 *
 * Root cause (confirmed via prod EXPLAIN on ref vzwyaatejekddvltxyye):
 *   get_unembedded_public_records used a LEFT JOIN public_record_embeddings ...
 *   WHERE pre.id IS NULL anti-join + ORDER BY created_at over a 3.03M-row /
 *   6.3 GB public_records table. The planner chose a Parallel Seq Scan +
 *   Parallel Hash Left Join + Sort (total cost ~861549), scanning and sorting
 *   the entire table before LIMIT could apply → canceling statement due to
 *   statement timeout, so the Cloud Scheduler job 500s every 2 minutes.
 *
 *   Rewriting the body to NOT EXISTS lets the planner pick a
 *   Nested Loop Anti Join driven by the ordered idx_public_records_created_at
 *   index (Index Only Scan on idx_pre_record_id for the probe) and stop after
 *   p_limit rows — the Seq Scan and the Sort both disappear (prod EXPLAIN:
 *   Limit cost 0.85..170.94 for 100 rows).
 *
 * These assertions read migration 0330 directly (the compensating migration),
 * mirroring the baseline-content test convention in rls-performance.test.ts and
 * scrum-1980-public-search-perf.test.ts. There is no local DB; the prod EXPLAIN
 * plan diff in the PR body is the behavioral evidence, this file is the content
 * guard that the migration keeps the rewrite + preserves the contract.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0330_scrum2203_unembedded_records_query_perf.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

function functionBlock(sql: string): string {
  const start = sql.indexOf('FUNCTION public.get_unembedded_public_records');
  expect(start).toBeGreaterThan(-1);
  // Body runs to the closing $$; of the function definition.
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('SCRUM-2203: get_unembedded_public_records query performance', () => {
  it('migration 0330 redefines the function', () => {
    const sql = migration();
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION[\s\S]*get_unembedded_public_records/,
    );
  });

  it('uses a NOT EXISTS anti-join against public_record_embeddings', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(
      /NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public_record_embeddings/i,
    );
    expect(block).toContain('pre.public_record_id = pr.id');
  });

  it('drops the LEFT JOIN ... IS NULL anti-join that forced the seq scan + sort', () => {
    const block = functionBlock(migration());
    expect(block).not.toMatch(/LEFT\s+JOIN\s+public_record_embeddings/i);
    expect(block).not.toMatch(/WHERE\s+pre\.id\s+IS\s+NULL/i);
  });

  it('preserves the exact signature (p_limit default 100) and return columns', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/get_unembedded_public_records\(p_limit integer DEFAULT 100\)/);
    expect(block).toMatch(
      /RETURNS TABLE\(id uuid, title text, source text, record_type text, metadata jsonb\)/,
    );
    // Same projected columns, in order, from public_records.
    expect(block).toContain('pr.id, pr.title, pr.source, pr.record_type, pr.metadata');
    expect(block).toContain('FROM public_records pr');
  });

  it('preserves created_at ASC ordering and the LIMIT p_limit bound', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/ORDER BY\s+pr\.created_at\s+ASC/i);
    expect(block).toMatch(/LIMIT\s+p_limit/i);
  });

  it('stays STABLE SECURITY DEFINER with search_path pinned to public', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/LANGUAGE sql/i);
    expect(block).toMatch(/STABLE\s+SECURITY DEFINER/i);
    expect(block).toMatch(/SET search_path TO 'public'/i);
  });

  it('documents the supporting (created_at, id) index for the operator', () => {
    // The concurrent index cannot run inside the migration txn (supabase db
    // push wraps migrations); it is documented for standalone operator apply,
    // mirroring the 0313 convention.
    const sql = migration();
    expect(sql).toMatch(/idx_public_records_created_at_id/);
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY/i);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:/i);
  });
});
