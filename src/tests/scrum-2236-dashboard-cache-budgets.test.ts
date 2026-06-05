/**
 * SCRUM-2236 (HARDEN-1): the four remaining unhardened dashboard cache
 * sub-refreshers must apply the SCRUM-1256 budget+sentinel pattern so a slow
 * full scan on the ~3M-row anchors / public_records tables cancels its own
 * statement (1s budget) and degrades gracefully instead of aborting the whole
 * refresh_pipeline_dashboard_cache() transaction.
 *
 * Root cause: refresh_pipeline_dashboard_cache() averaged ~55s over 22,686 cron
 * calls (every 2 min) and threw recurring prod statement-timeout ERRORs because
 * refresh_cache_anchor_status_counts / _anchor_type_counts / _by_source /
 * _record_types ran unbudgeted full scans under a coarse 60s statement_timeout.
 *
 * These assertions read migration 0335 directly, mirroring the baseline-content
 * test convention in scrum-2189-rpc-reads-cache.test.ts and rls-performance.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0335_scrum2236_dashboard_cache_budgets.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

/** Slice from a CREATE OR REPLACE FUNCTION header to its closing `$$;`. */
function functionBlock(sql: string, fnName: string): string {
  const header = sql.indexOf(`FUNCTION "public"."${fnName}"`);
  expect(header, `header for ${fnName}`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $$', header);
  expect(bodyStart, `AS $$ for ${fnName}`).toBeGreaterThan(header);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  expect(bodyEnd, `closing $$; for ${fnName}`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, bodyEnd);
}

const HARDENED = [
  'refresh_cache_anchor_status_counts',
  'refresh_cache_anchor_type_counts',
  'refresh_cache_by_source',
  'refresh_cache_record_types',
] as const;

// Sub-refreshers that, on a budget hit, must PRESERVE the prior value and tag it
// stale rather than overwrite with an empty/zero result.
const STALE_PRESERVING = [
  'refresh_cache_anchor_type_counts',
  'refresh_cache_by_source',
  'refresh_cache_record_types',
] as const;

describe('SCRUM-2236: dashboard cache refreshers are budgeted', () => {
  it('migration redefines all four slow sub-refreshers', () => {
    const sql = migration();
    for (const fn of HARDENED) {
      expect(sql).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION "public"."${fn}"`),
      );
    }
  });

  describe.each(HARDENED)('%s', (fn) => {
    it('budgets its scan with SET LOCAL statement_timeout = 1s', () => {
      const block = functionBlock(migration(), fn);
      expect(block).toMatch(/SET LOCAL statement_timeout\s*=\s*'1s'/i);
    });

    it('catches query_canceled (SQLSTATE 57014) explicitly, not just WHEN OTHERS', () => {
      const block = functionBlock(migration(), fn);
      // The explicit 57014 handler is mandatory — WHEN OTHERS does not catch it.
      expect(block).toMatch(/EXCEPTION[\s\S]*WHEN query_canceled/i);
    });

    it('still writes its cache row (does not bubble the cancel up)', () => {
      const block = functionBlock(migration(), fn);
      expect(block).toContain('INSERT INTO pipeline_dashboard_cache');
      expect(block).toContain('ON CONFLICT (cache_key) DO UPDATE');
    });

    it('preserves SECURITY DEFINER + search_path = public', () => {
      const sql = migration();
      const header = sql.slice(
        sql.indexOf(`FUNCTION "public"."${fn}"`),
        sql.indexOf('AS $$', sql.indexOf(`FUNCTION "public"."${fn}"`)),
      );
      expect(header).toContain('SECURITY DEFINER');
      expect(header).toMatch(/SET "search_path" TO 'public'/);
    });

    it('drops the coarse 60s table-level timeout in favour of a tight budget', () => {
      const sql = migration();
      const header = sql.slice(
        sql.indexOf(`FUNCTION "public"."${fn}"`),
        sql.indexOf('AS $$', sql.indexOf(`FUNCTION "public"."${fn}"`)),
      );
      expect(header).not.toMatch(/SET "statement_timeout" TO '60s'/);
    });
  });

  it('anchor_status_counts writes the -1 sentinel for a cancelled bucket', () => {
    const block = functionBlock(migration(), 'refresh_cache_anchor_status_counts');
    // Each per-status branch resets to -1 on cancel.
    expect(block).toMatch(/WHEN query_canceled THEN v_pending := -1/);
    expect(block).toMatch(/WHEN query_canceled THEN v_revoked := -1/);
    // SECURED is derived and degrades to -1 when any bucket was cancelled.
    expect(block).toMatch(/v_secured := -1/);
    // total still comes from the cheap pg_class.reltuples estimate.
    expect(block).toMatch(/reltuples/);
  });

  describe.each(STALE_PRESERVING)('%s stale-marker on cancel', (fn) => {
    it('marks the cache row stale instead of wiping it with an empty result', () => {
      const block = functionBlock(migration(), fn);
      expect(block).toMatch(/'stale_reason'\s*,\s*'budget'/);
      expect(block).toMatch(/'stale'\s*,\s*true/);
      // On conflict it preserves the prior value, never blindly EXCLUDED-overwrites.
      expect(block).toMatch(
        /COALESCE\(pipeline_dashboard_cache\.cache_value/,
      );
    });
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path with the prior function bodies', () => {
    const sql = migration();
    expect(sql).toMatch(/--\s*ROLLBACK:/i);
    for (const fn of HARDENED) {
      expect(sql).toContain(fn);
    }
  });

  it('carries the JIRA id in the header', () => {
    expect(migration()).toMatch(/SCRUM-2236/);
  });
});
