import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BUG-2026-08-22-001 — `cleanup_expired_data()` must be a singleton.
 *
 * WHY THIS RATCHET EXISTS. `arkova-worker` runs `minScale = 2`, and
 * `routes/scheduled.ts` registers `cleanup-expired-data` on `0 2 * * *` inside
 * every instance, so two callers enter the function together every night. They
 * take `audit_events` (relation) and `pg_trigger` (catalog object, class 2620)
 * in opposite orders around the `DROP TRIGGER` / `DELETE` / `CREATE TRIGGER`
 * section and deadlock — SQLSTATE 40P01, observed in prod Cloud Logging on
 * 2026-08-17/18/19/21 and reproduced on Postgres 15.18 at 24 deadlocks in 30
 * concurrent calls WITH `0411` already applied.
 *
 * `0411` is not the guard. It bounds lock WAITS (`lock_timeout`) and catches
 * `lock_not_available` (55P03); a deadlock is detected and broken before any
 * timeout elapses and raises 40P01, which that handler does not match. These
 * assertions therefore FAIL against `0411` — verified, not assumed — which is
 * what makes them a ratchet rather than a tautology.
 */

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');

function readMigration(fragment: string): string {
  const migration = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .find((file) => file.includes(fragment));

  if (!migration) {
    throw new Error(`Missing migration matching ${fragment}`);
  }

  return fs.readFileSync(path.join(migrationsDir, migration), 'utf8');
}

/** Executable SQL only — strip `--` comment lines so the header prose (which
 *  legitimately quotes the deadlock detail and the OLD unguarded body) can
 *  never satisfy or trip an assertion about the LIVE statements. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('0417 cleanup_expired_data singleton advisory lock', () => {
  const sql = readMigration('0417_cleanup_expired_data_singleton_advisory_lock');
  const exec = executableSql(sql);

  /**
   * The `IF NOT v_got_lock THEN … END IF;` block only.
   *
   * Anchored on the guard's own start and the FIRST `END IF;` at or after it —
   * a naive `indexOf('END IF;')` finds the `auth.role()` gate's terminator,
   * which precedes the guard, and yields an empty slice that makes every
   * `not.toMatch` assertion below pass vacuously.
   */
  function skipBranch(): string {
    const start = exec.indexOf('IF NOT v_got_lock THEN');
    expect(start).toBeGreaterThan(-1);
    const end = exec.indexOf('END IF;', start);
    expect(end).toBeGreaterThan(start);
    return exec.slice(start, end);
  }

  it('takes a TRANSACTION-scoped advisory lock, in the established Arkova namespace', () => {
    // `_xact_` is load-bearing, not stylistic. The session-scoped
    // `try_advisory_lock` RPC was rejected for singleton cron work in
    // services/worker/src/jobs/run-lease.ts because its release can land on a
    // different PostgREST pool backend than its acquire and silently no-op,
    // wedging the lock until that connection recycles. A transaction-scoped
    // lock has no release call to misroute.
    expect(exec).toMatch(/pg_try_advisory_xact_lock\s*\(\s*8675309\s*,\s*2\s*\)/);
    expect(exec).not.toMatch(/\bpg_advisory_lock\s*\(/);
    expect(exec).not.toMatch(/\btry_advisory_lock\s*\(/);
  });

  it('does not collide with the pipeline-dashboard-cache lock key (8675309, 1)', () => {
    expect(exec).not.toMatch(/pg_try_advisory_xact_lock\s*\(\s*8675309\s*,\s*1\s*\)/);
  });

  it('returns early when the lock is not acquired, before any DELETE', () => {
    const guard = skipBranch();
    expect(guard).toMatch(/IF\s+NOT\s+v_got_lock\s+THEN/i);
    expect(guard).toMatch(/RETURN\s+jsonb_build_object/i);
    // Nothing destructive may appear inside the skip branch.
    expect(guard).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(guard).not.toMatch(/\bDROP\s+TRIGGER\b/i);
    expect(guard).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it('acquires the lock BEFORE the first DELETE, not after', () => {
    const lockAt = exec.indexOf('pg_try_advisory_xact_lock');
    const firstDeleteAt = exec.search(/\bDELETE\s+FROM\b/i);
    expect(lockAt).toBeGreaterThan(-1);
    expect(firstDeleteAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(firstDeleteAt);
  });

  it('writes NO audit row on the skip path — duplicate rows are half the defect', () => {
    // Prod wrote two DATA_RETENTION_CLEANUP rows for one purge on the nights
    // both instances succeeded; staging wrote four on 2026-08-22T02:00Z. An
    // audit trail that over-reports how often retention ran is worse than none.
    expect(skipBranch()).not.toMatch(/DATA_RETENTION_CLEANUP/);
  });

  it('reports the skip distinguishably, and as success rather than failure', () => {
    // A skip is the guard working. Reporting it as an error would page on
    // healthy behaviour every night.
    expect(exec).toMatch(/'skipped_concurrent_run',\s*true/);
    expect(exec).toMatch(/'skipped_concurrent_run',\s*false/);
    expect(exec).toMatch(/'success',\s*true/);
    expect(exec).not.toMatch(/'success',\s*false/);
  });

  it('uses the -1 not-measured sentinel on the skip path, never 0', () => {
    // 0 would falsely assert "we looked and there was nothing to purge".
    const skip = skipBranch();
    expect(skip).toMatch(/'webhook_delivery_logs_deleted',\s*-1/);
    expect(skip).toMatch(/'verification_events_deleted',\s*-1/);
    expect(skip).toMatch(/'ai_usage_events_deleted',\s*-1/);
    expect(skip).toMatch(/'audit_events_deleted',\s*-1/);
    expect(skip).not.toMatch(/_deleted',\s*0\b/);
  });

  it('preserves every 0411 protection it composes on top of (no silent regression)', () => {
    // This file carries 0411's body verbatim below the guard. If a future edit
    // drops one of 0411's protections while keeping the lock, that is a
    // regression this migration would be blamed for.
    expect(exec).toMatch(/SET\s+"lock_timeout"\s+TO\s+'5s'/);
    expect(exec).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'/);
    expect(exec).toMatch(/WHEN\s+lock_not_available\s+THEN/);
    expect(exec).toMatch(/CREATE\s+TRIGGER\s+reject_audit_delete/);
  });

  it('preserves the service_role authorization gate and grant hygiene', () => {
    expect(exec).toMatch(/auth\.role\(\)\s*!=\s*'service_role'/);
    expect(exec).toMatch(/insufficient_privilege/);
    // PUBLIC named explicitly — a revoke naming only anon/authenticated is
    // silently a no-op against a PUBLIC grant (the 0364 catch).
    expect(exec).toMatch(/REVOKE ALL ON FUNCTION public\.cleanup_expired_data\(\) FROM PUBLIC, anon, authenticated/);
    expect(exec).toMatch(/GRANT EXECUTE ON FUNCTION public\.cleanup_expired_data\(\) TO service_role/);
  });

  it('reloads the PostgREST schema cache and carries a ROLLBACK comment', () => {
    expect(exec).toMatch(/NOTIFY pgrst, 'reload schema'/);
    expect(sql).toMatch(/^-- ROLLBACK:/m);
  });

  it('FAILS against 0411 — proving these assertions are a ratchet, not a tautology', () => {
    // The whole point: 0411 is the immediately-preceding definition of this
    // same function and satisfies none of the singleton assertions above.
    let prior: string;
    try {
      prior = executableSql(readMigration('0411_bug019_cleanup_expired_data_lock_timeout'));
    } catch {
      // 0411 lands via PR #2235. Until it merges the file is absent here, and
      // there is nothing to compare against — the assertions above still stand
      // on their own.
      return;
    }
    expect(prior).not.toMatch(/pg_try_advisory_xact_lock/);
    expect(prior).not.toMatch(/skipped_concurrent_run/);
  });
});
