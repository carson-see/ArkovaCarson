/**
 * DRIVE-02 / DRIVE-06 (SCRUM-2367 / SCRUM-2371) — regression: the
 * `upsert_drive_watch_state` RPC (migration 0351) MUST accept
 * `p_last_renewal_error` and persist it to `last_renewal_error` on BOTH the
 * INSERT and the ON CONFLICT UPDATE legs.
 *
 * The bootstrap `persist()` helper (drive-watch-bootstrap.ts) forwards
 * `p_last_renewal_error: s.lastError` into the RPC. Before this fix the SQL
 * function had NO such parameter, so PostgREST rejected the call at runtime
 * ("function ... does not exist" — no matching overload) and every watch-state
 * upsert that carried a renewal error blew up. This is a SQL-contract test: it
 * parses the shipped migration + the generated types so the mismatch can never
 * silently regress (the injected-DB bootstrap tests mock the interface and
 * cannot catch a real RPC signature drift).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../../../supabase/migrations/0351_drive_watch_state.sql',
);
const WORKER_TYPES_PATH = resolve(
  __dirname,
  '../../types/database.types.ts',
);
const FRONTEND_TYPES_PATH = resolve(
  __dirname,
  '../../../../../src/types/database.types.ts',
);

const migrationSql = readFileSync(MIGRATION_PATH, 'utf-8');

/** Extract the body of the CREATE OR REPLACE FUNCTION upsert_drive_watch_state. */
function fnBody(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.upsert_drive_watch_state');
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start);
}

describe('upsert_drive_watch_state RPC — p_last_renewal_error contract (0351)', () => {
  it('declares p_last_renewal_error as a text parameter (DEFAULT NULL)', () => {
    const body = fnBody(migrationSql);
    expect(body).toMatch(/p_last_renewal_error\s+text\s+DEFAULT\s+NULL/i);
  });

  it('writes last_renewal_error on the INSERT column list and VALUES', () => {
    const body = fnBody(migrationSql);
    const insertBlock = body.slice(
      body.indexOf('INSERT INTO public.drive_watch_state'),
      body.indexOf('ON CONFLICT'),
    );
    // Column appears in the INSERT column list.
    expect(insertBlock).toMatch(/last_renewal_error/);
    // The bound parameter is supplied in the VALUES clause.
    expect(insertBlock).toMatch(/p_last_renewal_error/);
  });

  it('writes last_renewal_error on the ON CONFLICT UPDATE leg', () => {
    const body = fnBody(migrationSql);
    const updateBlock = body.slice(body.indexOf('ON CONFLICT'));
    expect(updateBlock).toMatch(/last_renewal_error\s*=\s*EXCLUDED\.last_renewal_error/);
  });

  it('keeps the DROP FUNCTION rollback signature in sync with the new arg count', () => {
    // Rollback drops the function by its full arg-type signature; adding a
    // parameter without updating the ROLLBACK comment would leave a dangling
    // (un-droppable) overload. The new signature carries 15 types.
    const rollbackLine = migrationSql
      .split('\n')
      .find((l) => l.includes('DROP FUNCTION IF EXISTS public.upsert_drive_watch_state'));
    expect(rollbackLine).toBeTruthy();
    const argCount = (rollbackLine as string)
      .slice((rollbackLine as string).indexOf('(') + 1, (rollbackLine as string).lastIndexOf(')'))
      .split(',').length;
    expect(argCount).toBe(15);
  });

  it('exposes p_last_renewal_error in BOTH generated database.types.ts Args', () => {
    for (const p of [WORKER_TYPES_PATH, FRONTEND_TYPES_PATH]) {
      const types = readFileSync(p, 'utf-8');
      const idx = types.indexOf('upsert_drive_watch_state: {');
      expect(idx).toBeGreaterThanOrEqual(0);
      const block = types.slice(idx, idx + 800);
      const argsBlock = block.slice(0, block.indexOf('Returns:'));
      expect(argsBlock).toMatch(/p_last_renewal_error\?:\s*string/);
    }
  });
});

/**
 * DRIVE-06 (SCRUM-2371) — regression for the [P1] status-vocabulary drift:
 * `renewDriveWatchChannels()` persists `status:'degraded'` at three sites
 * (token-revoked + two renewal-failed paths), and `bootstrapDriveWatch()`
 * persists `active | permission_denied | failed`. Before this fix the
 * `drive_watch_state_status_check` CHECK constraint omitted `degraded`, so the
 * FIRST renewal-failure UPDATE would violate the constraint at the DB and leave
 * the watch without the `last_renewal_error` ops need. The injected-DB renewal
 * tests mock the interface and cannot catch a real CHECK-constraint mismatch —
 * this is a SQL-contract test that parses the shipped constraint against the
 * exact status literals the code writes, so the vocabulary can never drift apart
 * again.
 */
describe('drive_watch_state status CHECK — code↔DB vocabulary (0351)', () => {
  /** Extract the quoted status values inside the drive_watch_state_status_check CHECK IN (...). */
  function statusCheckValues(sql: string): string[] {
    const marker = 'drive_watch_state_status_check';
    const start = sql.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    // The CHECK IN (...) list follows the constraint name on the next line(s).
    const inStart = sql.indexOf('IN (', start);
    expect(inStart).toBeGreaterThanOrEqual(0);
    const inEnd = sql.indexOf(')', inStart);
    const list = sql.slice(inStart + 'IN ('.length, inEnd);
    return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  // Every status literal the worker persists into drive_watch_state:
  //   - bootstrapDriveWatch(): 'active' | 'permission_denied' | 'failed'
  //   - renewDriveWatchChannels(): 'active' | 'degraded' | 'stopped' | 'expired'
  const CODE_STATUSES = [
    'active',
    'permission_denied',
    'failed',
    'degraded',
    'stopped',
    'expired',
  ];

  it('allows every status the worker writes (incl. degraded)', () => {
    const allowed = statusCheckValues(migrationSql);
    for (const s of CODE_STATUSES) {
      expect(allowed, `status '${s}' must be permitted by the CHECK constraint`).toContain(s);
    }
  });

  it('specifically permits degraded (the renewal-failure ops status)', () => {
    expect(statusCheckValues(migrationSql)).toContain('degraded');
  });

  it('does not permit statuses the code never writes (constraint stays tight)', () => {
    const allowed = statusCheckValues(migrationSql);
    for (const s of allowed) {
      expect(CODE_STATUSES, `CHECK permits '${s}' but no code path writes it`).toContain(s);
    }
  });

  it('documents degraded in the status COLUMN comment', () => {
    const commentStart = migrationSql.indexOf('COMMENT ON COLUMN public.drive_watch_state.status');
    expect(commentStart).toBeGreaterThanOrEqual(0);
    const comment = migrationSql.slice(commentStart, migrationSql.indexOf(';', commentStart));
    expect(comment).toMatch(/degraded/);
  });
});
