/**
 * SCRUM-3031: batch_insert_anchors burns ~106s/call inserting ZERO rows on
 * repeat calls, holding RowExclusiveLock on `anchors` (~2.97M rows) near
 * continuously — suspected root cause of the 259k pending-anchoring backlog
 * never draining; blocked the 0365/0366 prod DDL apply for ~15min on
 * 2026-07-27 (CTO ruling R15).
 *
 * ROOT CAUSE — CONFIRMED IN THE RPC, via a local Postgres repro at
 * representative scale (200,011-row `anchors` table, all rows owned by the
 * single pipeline-owner user_id that `publicRecordAnchor.ts` actually uses —
 * matching prod's real skew where one owner holds the bulk of pipeline
 * anchors — plus a 1000-row all-conflicting `p_anchors` batch, the exact
 * shape of the "repeat call, zero rows inserted" wedge):
 *
 *   `anchors.fingerprint` is `character(64)` (fixed-length bpchar; CHECK
 *   `fingerprint ~ '^[A-Fa-f0-9]{64}$'`). The pre-0370 `batch_insert_anchors`
 *   built its `input_data` CTE with `(elem->>'fingerprint')::text` — a
 *   `text`, not `character(64)`. The dedup ("existing") CTE then joined
 *   `a.fingerprint = d.fingerprint` (bpchar = text). Postgres resolves that
 *   cross-type comparison by implicitly casting the *indexed* column
 *   (`(a.fingerprint)::text = d.fingerprint`), which makes
 *   `idx_anchors_user_fingerprint_unique` / `idx_anchors_fingerprint_lookup`
 *   unusable for that predicate. The planner fell back to a full
 *   `Seq Scan on anchors` + an external-merge disk-spilling sort to Merge
 *   Join — a cost proportional to the TOTAL anchors table size, not to how
 *   many rows in the batch actually conflict. That is exactly why it fires
 *   on every call, including "zero rows inserted" repeats: the cost doesn't
 *   depend on the batch's own conflict rate at all.
 *
 *   Local EXPLAIN (ANALYZE, BUFFERS) transcript, 200,011-row anchors table
 *   (1/15th of prod's ~2.97M — prod cost scales considerably worse):
 *     BEFORE (pre-0370 body): Merge Join, actual time 530.263..532.237 ms
 *       -> Seq Scan on public.anchors (200,011 rows, ~49ms)
 *       -> Sort Method: external merge  Disk: 33680kB
 *       Execution Time: 533.834 ms
 *     AFTER (0370 body, split-cast version — see below): Nested Loop Anti
 *     Join, actual time 0.031..33.149 ms for the dedup join itself
 *       -> Index Scan using idx_anchors_fingerprint_lookup on anchors a
 *          Index Cond: (fingerprint = (d.fingerprint)::character(64))
 *       Total function call (1000-row all-conflicting batch, real
 *       `SELECT batch_insert_anchors(...)`, auto_explain nested-statement
 *       capture): Execution Time 78.570 ms end to end at 200,011-row scale.
 *   O(batch_size * log(N)) index probes instead of O(N) full scan + sort,
 *   so the win widens (not narrows) at prod's full 2.97M-row table.
 *   Correctness re-verified post-fix with a mixed batch (500 pre-existing +
 *   500 genuinely-new fingerprints): `total_returned=1000`, exactly 500 new
 *   rows landed.
 *
 * REVIEW FOLLOW-UP — CORRECTNESS REGRESSION CAUGHT AND FIXED (same PR, pre-
 * apply; 0370 was never applied to prod/rig per supabase/migrations/
 * agents.md, so it was safe to correct in place rather than compensate):
 * the *first cut* of this fix cast the whole `input_data.fingerprint`
 * column to `character(64)`. Verified empirically on real Postgres 17: an
 * EXPLICIT cast `(<66-char string>)::character(64)` silently TRUNCATES with
 * no error (two different 66-char strings sharing a 64-char prefix compare
 * EQUAL after truncation), whereas the target column's IMPLICIT assignment
 * cast used by a bare INSERT (`value too long for type character(64)`,
 * SQLSTATE 22001) correctly raises. Since `public_records.content_hash`
 * (the value that becomes `fingerprint` — see
 * `services/worker/src/jobs/publicRecordAnchor.ts`) has no CHECK constraint
 * and is computed by 20+ independent fetchers, this was reachable: a
 * malformed/overlong fingerprint would have silently become a
 * valid-looking-but-wrong fingerprint (or a false dedup match) on
 * `anchors.fingerprint`, the product's integrity-critical dedup key.
 *
 * Fix (this version): split the cast by role instead of casting the whole
 * CTE column.
 *   - `input_data.fingerprint` stays `::text` (restores the pre-0370 INSERT
 *     path exactly), so the `inserted` CTE's `INSERT INTO anchors` still
 *     goes through the target column's implicit assignment cast, which
 *     RAISES loudly on any overlong fingerprint in the batch, before the
 *     `existing` CTE (or anything downstream) runs.
 *   - The `existing` CTE's dedup JOIN casts explicitly instead, but only on
 *     the NON-indexed side: `a.fingerprint = d.fingerprint::character(64)`.
 *     `a.fingerprint` (indexed) stays untouched, so the native
 *     `bpchar = bpchar` operator still drives the index scan — same
 *     mechanism, same performance win, just relocated. This cast can never
 *     silently truncate a bad value, because by the time `existing` runs,
 *     `inserted`'s implicit-cast raise has already proven every fingerprint
 *     in the batch is <= 64 characters.
 *   - Empirically re-verified (this session, real Postgres 17, same
 *     200,011-row/1000-row-batch setup): the split-cast version still gets
 *     `Index Scan using idx_anchors_fingerprint_lookup` (see EXPLAIN excerpt
 *     above), AND a direct call to the fixed function with a 66-char
 *     fingerprint now raises `value too long for type character(64)`
 *     (22001) with nothing inserted — matching pre-0370 safe behavior. The
 *     unfixed first-cut version, tested side by side, silently inserted the
 *     truncated 64-char value with no error — confirming the regression and
 *     the fix.
 *
 * Also swaps `a.id NOT IN (SELECT id FROM inserted)` for
 * `NOT EXISTS (SELECT 1 FROM inserted i WHERE i.id = a.id)` — defensive
 * parity with the NOT-IN -> NOT-EXISTS anti-join convention established by
 * migration 0330 (SCRUM-2203) elsewhere in this codebase; no behavioral
 * change here since `inserted.id` can never be NULL, but it avoids the
 * NOT-IN/NULL footgun if that ever changes and matches house style.
 *
 * These assertions read migration 0370 directly, mirroring the
 * baseline-content test convention used by scrum-1980-public-search-perf,
 * scrum-2203-unembedded-query-perf, and rls-performance.test.ts — the
 * EXPLAIN evidence above is the behavioral proof (obtained locally this
 * session, not inferred from prod), this file is the content guard that
 * keeps the type-correct split-cast (and the anti-join form) from
 * regressing back to either the pre-0370 wedge OR the first-cut
 * silent-truncation bug.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0370_scrum3031_batch_insert_anchors_fix.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

function functionBlock(sql: string): string {
  const start = sql.indexOf('FUNCTION "public"."batch_insert_anchors"');
  expect(start).toBeGreaterThan(-1);
  // There are two occurrences: the CREATE OR REPLACE block and the ALTER
  // FUNCTION OWNER TO line further down. Grab through the first `$$;`.
  const bodyEnd = sql.indexOf('$$;', start);
  expect(bodyEnd).toBeGreaterThan(start);
  return sql.slice(start, bodyEnd + 3);
}

describe('SCRUM-3031: batch_insert_anchors wedge fix (migration 0370)', () => {
  it('migration 0370 redefines batch_insert_anchors', () => {
    const sql = migration();
    expect(sql).toContain('FUNCTION "public"."batch_insert_anchors"');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION');
  });

  describe('the pathological type-mismatch cast is gone (index stays usable)', () => {
    it('casts to character(64) ONLY at the existing-CTE join predicate, on the non-indexed side', () => {
      const block = functionBlock(migration());
      // a.fingerprint (indexed) must appear bare, cast applied to d.fingerprint only.
      expect(block).toMatch(/a\.fingerprint\s*=\s*d\.fingerprint::"?character"?\(64\)/i);
    });

    it('the existing-anchors dedup join still compares on (user_id, fingerprint)', () => {
      const block = functionBlock(migration());
      expect(block).toMatch(/a\.user_id\s*=\s*d\.user_id/i);
      expect(block).toMatch(/a\.fingerprint\s*=\s*d\.fingerprint/i);
    });
  });

  describe('correctness regression guard: no silent-truncation cast on the INSERT path', () => {
    // A reviewer caught that an earlier version of this migration cast
    // input_data.fingerprint itself to character(64) — an EXPLICIT cast,
    // which silently truncates an overlong value instead of raising
    // (verified empirically on real Postgres 17; see the file-header
    // docstring and the migration's own REVIEW FOLLOW-UP comment). These
    // assertions guard against that regression coming back.
    it('input_data.fingerprint stays ::text — NOT ::character(64) — so the INSERT path keeps its loud implicit-cast validation', () => {
      const block = functionBlock(migration());
      expect(block).toMatch(/\(elem->>'fingerprint'\)::text/i);
      expect(block).not.toMatch(/\(elem->>'fingerprint'\)::"?character"?\(64\)/i);
    });

    it('the migration file documents the silent-truncation-vs-loud-raise distinction for future readers', () => {
      const sql = migration();
      expect(sql).toMatch(/silently truncat/i);
      expect(sql.toLowerCase()).toContain('value too long for type character(64)'.toLowerCase());
    });
  });

  describe('anti-join hardening (NOT IN -> NOT EXISTS)', () => {
    it('uses NOT EXISTS for the pre-existing-anchor anti-join', () => {
      const block = functionBlock(migration());
      expect(block).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM inserted/i);
    });

    it('no longer uses the NOT IN (SELECT id FROM inserted) anti-join form', () => {
      const block = functionBlock(migration());
      expect(block).not.toMatch(/NOT IN\s*\(\s*SELECT id FROM inserted\s*\)/i);
    });
  });

  it('preserves the ON CONFLICT dedup semantics (DO NOTHING, partial-index arbiter)', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/ON CONFLICT\s*\(\s*user_id\s*,\s*fingerprint\s*\)\s*WHERE deleted_at IS NULL/i);
    expect(block).toContain('DO NOTHING');
  });

  it('preserves both newly-inserted and pre-existing rows in the return set', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/SELECT id, fingerprint FROM inserted\s*UNION ALL\s*SELECT id, fingerprint FROM existing/i);
  });

  it('preserves SECURITY DEFINER + search_path + the 120s statement_timeout backstop', () => {
    const sql = migration();
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION "public"."batch_insert_anchors"');
    const headerEnd = sql.indexOf('AS $$', start);
    const header = sql.slice(start, headerEnd);
    expect(header).toContain('SECURITY DEFINER');
    expect(header).toMatch(/SET\s+"?search_path"?\s+TO\s+'public'/i);
    expect(header).toMatch(/SET\s+"?statement_timeout"?\s+TO\s+'120s'/i);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:/i);
  });

  it('documents the confirmed-in-RPC root cause for future readers', () => {
    const sql = migration();
    expect(sql).toMatch(/ROOT CAUSE/i);
    expect(sql).toMatch(/implicit cast/i);
  });
});
