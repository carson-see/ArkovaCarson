/**
 * BUG-019 (P1, 2026-08 soak) — `cleanup_expired_data()` runs
 * DROP TRIGGER -> DELETE -> CREATE TRIGGER on `audit_events` with no bounded
 * `lock_timeout`, on a daily cron, from inside a SECURITY DEFINER body.
 *
 * That is the CLAUDE.md §1.2 shape that took `/api/v1/verify` down for 11m39s
 * on 2026-08-11: Postgres lock queues are FIFO, so an unbounded
 * `AccessExclusiveLock` request that blocks on a long reader becomes a barrier
 * in front of every later lock request, PostgREST's schema-cache introspection
 * included.
 *
 * Two things are asserted here, and the second is the one that matters:
 *
 *   1. Migration 0411 carries the guard (content assertions on the file).
 *   2. The CI linter — run over the REAL baseline body, not a synthetic — flags
 *      the pre-fix statements, and reports the post-fix file clean.
 *
 * (2) is the ratchet. The linter shipped after the P0 and still missed this
 * because it read a migration as a flat statement list; a `SET LOCAL` in a
 * migration guards the `CREATE FUNCTION` statement, never the body, which
 * executes later in a cron's session. A test that only pinned the migration
 * text would have let the next author reintroduce the class in a different
 * function with nothing to catch it.
 *
 * @see memory/feedback_lint_rule_beats_human_census.md
 * @see memory/feedback_verification_must_outrank_the_claim.md
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanFiles, RUNTIME_DDL_TABLES } from '../../scripts/ci/check-hot-table-ddl-lock-timeout';

const MIGRATION = 'supabase/migrations/0411_bug019_cleanup_expired_data_lock_timeout.sql';
const BASELINE = 'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/** Slice one `CREATE OR REPLACE FUNCTION ... $$ ... $$;` statement out of a file. */
function routine(sql: string, fnName: string): string {
  const header = sql.indexOf(`FUNCTION "public"."${fnName}"`);
  expect(header, `header for ${fnName}`).toBeGreaterThan(-1);
  // Back up to the CREATE that owns this header so the routine's SET clauses
  // are inside the slice.
  const create = sql.lastIndexOf('CREATE', header);
  const bodyStart = sql.indexOf('AS $$', header);
  expect(bodyStart, `AS $$ for ${fnName}`).toBeGreaterThan(header);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  expect(bodyEnd, `closing $$; for ${fnName}`).toBeGreaterThan(bodyStart);
  return sql.slice(create, bodyEnd + 3);
}

function lintViolations(name: string, body: string) {
  return scanFiles([{ name, body }]).map((v) => `${v.table}:${v.kind}:${v.context}`);
}

describe('BUG-019: the linter catches in-function DDL without a lock_timeout', () => {
  it('flags the REAL pre-fix cleanup_expired_data body from the baseline', () => {
    const before = routine(read(BASELINE), 'cleanup_expired_data');

    // Sanity: this is genuinely the unguarded body, not a stale slice.
    expect(before).toContain('DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events');
    expect(before).not.toMatch(/lock_timeout/i);

    expect(lintViolations('baseline-slice.sql', before)).toEqual([
      'audit_events:DROP TRIGGER:function-body',
      'audit_events:CREATE TRIGGER:function-body',
    ]);
  });

  it('still flags that body when the migration sets a file-level lock_timeout', () => {
    // The false negative the pre-BUG-019 linter had. A file-level SET LOCAL runs
    // at apply time and is gone by the time the cron calls the function, so it
    // must not count as a guard for anything in the body.
    const before = routine(read(BASELINE), 'cleanup_expired_data');
    const withFileGuard = `SET LOCAL lock_timeout = '5s';\n${before}`;

    expect(lintViolations('baseline-slice.sql', withFileGuard)).toEqual([
      'audit_events:DROP TRIGGER:function-body',
      'audit_events:CREATE TRIGGER:function-body',
    ]);
  });

  it('reports migration 0411 clean', () => {
    expect(lintViolations(MIGRATION, read(MIGRATION))).toEqual([]);
  });

  it('covers audit_events for runtime DDL', () => {
    expect(RUNTIME_DDL_TABLES).toContain('audit_events');
  });
});

describe('BUG-019: migration 0411 content', () => {
  const sql = () => read(MIGRATION);
  const fn = () => routine(sql(), 'cleanup_expired_data');

  it('bounds the routine itself with a non-zero lock_timeout', () => {
    expect(fn()).toMatch(/SET\s+"?lock_timeout"?\s+TO\s+'5s'/i);
  });

  it('sets a bounded SET LOCAL immediately before the audit_events DDL', () => {
    const body = fn();
    const guard = body.search(/SET LOCAL lock_timeout = '5s';/);
    const drop = body.indexOf('DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events');
    const create = body.indexOf('CREATE TRIGGER reject_audit_delete BEFORE DELETE ON audit_events');
    expect(guard).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(guard);
    expect(create).toBeGreaterThan(guard);
  });

  it('never sets lock_timeout to 0 — 0 is Postgres for "wait forever"', () => {
    expect(sql().replace(/^\s*--.*$/gm, '')).not.toMatch(/lock_timeout\s*(?:=|TO)\s*'?0/i);
  });

  it('catches lock_not_available so a timeout does not discard the other purges', () => {
    expect(fn()).toMatch(/EXCEPTION\s+WHEN lock_not_available THEN/);
  });

  it('re-creates the append-only trigger inside the same subtransaction as the DROP', () => {
    // The rollback on a caught timeout is what restores reject_audit_delete. If
    // the CREATE ever moved outside the block, a timeout would leave
    // audit_events writable.
    const body = fn();
    const blockStart = body.indexOf("SET LOCAL lock_timeout = '5s';");
    const blockEnd = body.indexOf('WHEN lock_not_available THEN');
    const create = body.indexOf('CREATE TRIGGER reject_audit_delete');
    expect(create).toBeGreaterThan(blockStart);
    expect(create).toBeLessThan(blockEnd);
  });

  it('resets the count and the skip flag in the handler', () => {
    // PL/pgSQL does not roll back variable assignments with the subtransaction,
    // so a ROW_COUNT captured before a failing CREATE TRIGGER would otherwise
    // report a DELETE that did not survive.
    const handler = fn().slice(fn().indexOf('WHEN lock_not_available THEN'));
    expect(handler).toMatch(/v_audit_count\s*:=\s*-1;/);
    expect(handler).toMatch(/v_audit_purge_skipped\s*:=\s*true;/);
  });

  it('reports a skipped purge distinguishably from "nothing to purge"', () => {
    const body = fn();
    expect(body).toContain("'audit_events_purge_skipped', v_audit_purge_skipped");
    expect(body).toMatch(/v_audit_count integer := -1;/);
  });

  it('keeps SECURITY DEFINER + search_path and the service_role guard', () => {
    const body = fn();
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toMatch(/SET\s+"?search_path"?\s+TO\s+'public'/i);
    expect(body).toContain("auth.role() != 'service_role'");
  });

  it('preserves the legal_hold carve-out on the audit purge', () => {
    expect(fn()).toContain('anchors.legal_hold = true');
  });

  it('carries a ROLLBACK comment and reloads the PostgREST schema cache', () => {
    expect(sql()).toMatch(/^-- ROLLBACK:/m);
    expect(sql()).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('revokes from PUBLIC, anon AND authenticated, after the definition', () => {
    // `REVOKE ... FROM PUBLIC` alone does not remove the EXECUTE that
    // ALTER DEFAULT PRIVILEGES gives anon/authenticated DIRECTLY at CREATE time
    // (0364 / 0388 / 0396), and a revoke written above the CREATE OR REPLACE is
    // undone by it. Both are enforced repo-wide by
    // scripts/ci/feedback-rules/secdef-function-grants.ts.
    const s = sql();
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.cleanup_expired_data\(\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(s).toMatch(/GRANT EXECUTE ON FUNCTION public\.cleanup_expired_data\(\) TO service_role;/);
    expect(s.indexOf('REVOKE ALL ON FUNCTION')).toBeGreaterThan(s.indexOf('CREATE OR REPLACE FUNCTION'));
  });

  it('writes the grant statements unquoted so the ratchet can see them', () => {
    // `"public"."f"()` matches neither `schema.name` nor the `name (` fallback
    // in secdef-function-grants.ts `statementTargets`, so a quoted revoke reads
    // as no revoke at all. This cost a red build once already.
    expect(sql()).not.toMatch(/REVOKE[^;]*"public"\."cleanup_expired_data"/);
  });
});
