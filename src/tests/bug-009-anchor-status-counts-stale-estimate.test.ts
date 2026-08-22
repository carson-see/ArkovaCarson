/**
 * BUG-009 (P1, 2026-08 soak) — an un-analysed `anchors` table published
 * `{"total": 0, "SECURED": 0}` to the admin dashboards as a measured count.
 *
 * `refresh_cache_anchor_status_counts()` took `total` from
 * `pg_class.reltuples` — a planner estimate, `-1` when the relation has never
 * been vacuumed/analysed (PG14+) and `0` when freshly loaded — and laundered it
 * through `GREATEST(reltuples, 0)`. 0335 gave every per-status bucket a `-1`
 * sentinel for the timed-out case and gave the estimate none, so "no statistics"
 * became "zero rows". SECURED is derived by subtraction, so it went to 0 too.
 *
 * Observed on the 2026-08 rig: that cache row read `{"total":0,"SECURED":0}`
 * while `anchor_type_counts` — same cron, same table, direct `count(*)` —
 * correctly reported 12, and `POST /jobs/smoke-test` failed its `anchor-count`
 * check. Prod was only correct because autovacuum kept its estimate warm.
 *
 * These assertions read migration 0412 directly, mirroring the content-guard
 * convention in scrum-2236-dashboard-cache-budgets.test.ts. They pin the
 * DISTINCTION (estimate vs exact vs unavailable), not the arithmetic — the
 * arithmetic is Postgres's.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION = 'supabase/migrations/0412_bug009_anchor_status_counts_stale_estimate_sentinel.sql';
const PRIOR = 'supabase/migrations/0335_scrum2236_dashboard_cache_budgets.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/** Body of `refresh_cache_anchor_status_counts` in a given migration file. */
function body(sql: string): string {
  const header = sql.indexOf('FUNCTION "public"."refresh_cache_anchor_status_counts"');
  expect(header).toBeGreaterThan(-1);
  const start = sql.indexOf('AS $$', header);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** Comment lines are prose, not behaviour — strip them before asserting on SQL. */
function code(sql: string): string {
  return sql.replace(/^\s*--.*$/gm, '');
}

describe('BUG-009: the defect this migration fixes', () => {
  it('0335 laundered a non-positive reltuples into 0 (the bug, pinned)', () => {
    const before = code(body(read(PRIOR)));
    expect(before).toMatch(/GREATEST\(\s*reltuples::bigint\s*,\s*0\s*\)/);
    // ...and had no way back from there: no exact fallback, no trust check.
    expect(before).not.toMatch(/count\(\*\)\s+INTO\s+v_total/);
  });
});

describe('BUG-009: migration 0412', () => {
  const sql = () => read(MIGRATION);
  const fn = () => code(body(sql()));

  it('never launders a non-positive estimate through GREATEST(..., 0)', () => {
    expect(fn()).not.toMatch(/GREATEST\(\s*(?:c\.)?reltuples[^)]*,\s*0\s*\)/);
  });

  it('reads reltuples raw so the "unknown" signal survives', () => {
    expect(fn()).toMatch(/SELECT\s+c\.reltuples\s+INTO\s+v_reltuples/);
  });

  it('trusts the estimate only when it is strictly positive', () => {
    expect(fn()).toMatch(/v_reltuples\s+IS NOT NULL/);
    expect(fn()).toMatch(/v_reltuples\s*>\s*0/);
  });

  it('rejects an estimate smaller than the buckets it just counted', () => {
    // The cross-check that catches a stale-but-positive estimate: we cannot
    // have counted more live rows in four statuses than exist in the table.
    expect(fn()).toMatch(/v_reltuples::bigint\s*<\s*v_bucket_sum/);
  });

  it('resolves an untrusted estimate with an exact count under a 1s budget', () => {
    const b = fn();
    const branch = b.slice(b.indexOf('ELSE', b.indexOf('IF v_estimate_trusted')));
    expect(branch).toMatch(/SET LOCAL statement_timeout = '1s';/);
    expect(branch).toMatch(/SELECT count\(\*\) INTO v_total FROM anchors;/);
    expect(branch).toMatch(/v_total_source := 'exact';/);
  });

  it('counts the same population the estimate would have (no deleted_at filter)', () => {
    // reltuples is physical rows. An exact fallback filtered to deleted_at IS
    // NULL would silently change what `total` means between the two paths.
    expect(fn()).toMatch(/SELECT count\(\*\) INTO v_total FROM anchors;/);
    expect(fn()).not.toMatch(/SELECT count\(\*\) INTO v_total FROM anchors WHERE/);
  });

  it('falls to the -1 sentinel — never 0 — when the exact count cannot finish', () => {
    const b = fn();
    const handler = b.slice(b.indexOf('WHEN query_canceled THEN v_total := -1'));
    expect(handler).toMatch(/v_total := -1;\s*v_total_source := 'unavailable';/);
    expect(b).toMatch(/WHEN OTHERS THEN v_total := -1;/);
  });

  it('initialises total and its source to the unavailable state', () => {
    // Fail-closed: any path that forgets to assign leaves a sentinel, not a 0.
    expect(fn()).toMatch(/v_total bigint := -1;/);
    expect(fn()).toMatch(/v_total_source text := 'unavailable';/);
  });

  it('derives SECURED only from a trustworthy total AND complete buckets', () => {
    const b = fn();
    expect(b).toMatch(/IF v_total >= 0 AND v_buckets_known THEN/);
    expect(b).toMatch(/v_secured := GREATEST\(v_total - v_bucket_sum, 0\);/);
    expect(b).toMatch(/ELSE\s*v_secured := -1;/);
  });

  it('publishes total_source so the raw cache row is self-describing', () => {
    expect(fn()).toContain("'total_source', v_total_source");
    for (const source of ["'exact'", "'estimate'", "'unavailable'"]) {
      expect(fn()).toContain(`v_total_source := ${source};`);
    }
  });

  it('keeps every pre-existing key in the same flat shape', () => {
    // The readers (get_anchor_status_counts_fast / get_anchor_status_counts)
    // consume this object directly; a wrapper or a renamed key breaks them.
    const b = fn();
    for (const key of ['PENDING', 'SUBMITTED', 'BROADCASTING', 'SECURED', 'REVOKED', 'total']) {
      expect(b).toContain(`'${key}',`);
    }
    expect(b).toMatch(/INSERT INTO pipeline_dashboard_cache \(cache_key, cache_value, updated_at\)/);
    expect(b).toContain("VALUES ('anchor_status_counts', jsonb_build_object(");
    expect(b).toMatch(/ON CONFLICT \(cache_key\) DO UPDATE/);
  });

  it('keeps all four per-status buckets budgeted with the query_canceled sentinel', () => {
    const b = fn();
    // WHEN OTHERS does not catch QUERY_CANCELED — both handlers are required.
    expect(b.match(/WHEN query_canceled THEN v_(?:pending|submitted|broadcasting|revoked) := -1;/g))
      .toHaveLength(4);
    expect(b.match(/SET LOCAL statement_timeout = '1s';/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps SECURITY DEFINER, search_path and the 10s outer budget', () => {
    const header = sql().slice(
      sql().indexOf('CREATE OR REPLACE FUNCTION "public"."refresh_cache_anchor_status_counts"'),
      sql().indexOf('AS $$'),
    );
    expect(header).toContain('SECURITY DEFINER');
    expect(header).toMatch(/SET "search_path" TO 'public'/);
    expect(header).toMatch(/SET "statement_timeout" TO '10s'/);
  });

  it('carries a ROLLBACK comment and reloads the PostgREST schema cache', () => {
    expect(sql()).toMatch(/^-- ROLLBACK:/m);
    expect(sql()).toContain("NOTIFY pgrst, 'reload schema';");
  });

  /**
   * Found while writing this migration, by
   * scripts/ci/feedback-rules/secdef-function-grants.ts going red on it.
   *
   * The baseline grants this SECURITY DEFINER refresher to `anon` AND
   * `authenticated` (baseline:14236-14237), so an unauthenticated PostgREST
   * caller could make the database run four count(*) scans over ~3.5M rows and
   * write a `pipeline_dashboard_cache` row — on an account-free endpoint the
   * worker's §1.10 limiter never sees. `CREATE OR REPLACE` preserves the ACL, so
   * redefining the body does not close it.
   */
  describe('SEC: anon/authenticated EXECUTE revoked', () => {
    it('revokes from PUBLIC, anon and authenticated', () => {
      expect(sql()).toMatch(
        /REVOKE ALL ON FUNCTION public\.refresh_cache_anchor_status_counts\(\) FROM PUBLIC, anon, authenticated;/,
      );
    });

    it('keeps service_role, the only real caller', () => {
      expect(sql()).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.refresh_cache_anchor_status_counts\(\) TO service_role;/,
      );
    });

    it('places the revoke AFTER the definition', () => {
      // A revoke above the CREATE OR REPLACE is undone the moment the
      // definition runs — ALTER DEFAULT PRIVILEGES re-grants at CREATE time.
      const s = sql();
      expect(s.indexOf('REVOKE ALL ON FUNCTION')).toBeGreaterThan(
        s.indexOf('CREATE OR REPLACE FUNCTION'),
      );
    });

    it('hands nothing back to a browser role afterwards', () => {
      const after = sql().slice(sql().indexOf('REVOKE ALL ON FUNCTION'));
      expect(code(after)).not.toMatch(/GRANT[^;]*\b(?:anon|authenticated)\b/);
    });
  });

  it('touches only its own refresher, not the three siblings', () => {
    for (const sibling of [
      'refresh_cache_anchor_type_counts',
      'refresh_cache_by_source',
      'refresh_cache_record_types',
    ]) {
      expect(code(sql())).not.toContain(`FUNCTION "public"."${sibling}"`);
    }
  });
});
