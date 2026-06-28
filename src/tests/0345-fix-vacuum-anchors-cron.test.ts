import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');

function readVacuumCronMigration(): string {
  const migration = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .find((file) => file.includes('0345_fix_vacuum_anchors_cron'));

  if (!migration) {
    throw new Error('Missing 0345 fix-vacuum-anchors-cron migration');
  }

  return fs.readFileSync(path.join(migrationsDir, migration), 'utf8');
}

/** Executable SQL only — strip `--` comment lines so prose in the header/ROLLBACK
 *  block (which legitimately quotes the OLD multi-statement command) can never
 *  satisfy or trip an assertion about the LIVE statements. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('0345 fix vacuum-anchors cron migration', () => {
  const sql = readVacuumCronMigration();
  const exec = executableSql(sql);

  it('points the cron job command at a SINGLE-statement top-level VACUUM', () => {
    // The corrected command is exactly the single statement — no SET prefixes,
    // which is what forced the implicit transaction and broke VACUUM.
    expect(exec).toMatch(/command\s*=>\s*'VACUUM \(ANALYZE\) public\.anchors'/);
  });

  it('does NOT re-inline SET statement_timeout / maintenance_work_mem into the job command', () => {
    // The only place those GUCs may appear in *executable* SQL is the ALTER ROLE
    // lines (asserted below) and a `command =>` that re-introduces them would
    // re-create the multi-statement transaction bug. Assert no executable
    // `command =>` value carries a SET … VACUUM multi-statement.
    expect(exec).not.toMatch(/command\s*=>\s*'[^']*SET[^']*VACUUM/i);
  });

  it('preserves both maintenance GUCs at the role level (ALTER ROLE)', () => {
    expect(exec).toMatch(/ALTER ROLE postgres SET statement_timeout\s*=\s*'0'/);
    expect(exec).toMatch(/ALTER ROLE postgres SET maintenance_work_mem\s*=\s*'1GB'/);
  });

  it('alters the existing job by id via cron.alter_job, guarded on the known jobname', () => {
    expect(exec).toMatch(/cron\.alter_job/);
    expect(exec).toMatch(/job_id\s*=>\s*2/);
    // Idempotency/safety guard: only touch jobid=2 when it is `vacuum-anchors`.
    expect(exec).toMatch(/jobid\s*=\s*2\s+AND\s+jobname\s*=\s*'vacuum-anchors'/);
  });

  it('runs inside a single transaction (BEGIN/COMMIT) — safe because ALTER ROLE + alter_job are transactional', () => {
    expect(exec).toContain('BEGIN;');
    expect(exec).toContain('COMMIT;');
    // The migration must NOT itself run a top-level VACUUM (that would fail inside
    // the migration transaction). VACUUM only ever appears as the QUOTED cron
    // command string, never as a bare executable statement.
    expect(exec).not.toMatch(/^\s*VACUUM\b/im);
  });

  it('provides a ROLLBACK block that restores the prior command and resets the role GUCs', () => {
    expect(sql).toContain('-- ROLLBACK:');
    expect(sql).toMatch(/ALTER ROLE postgres RESET statement_timeout/);
    expect(sql).toMatch(/ALTER ROLE postgres RESET maintenance_work_mem/);
    // Rollback restores the original multi-statement command (documented in the
    // comment block).
    expect(sql).toMatch(/SET statement_timeout = 0; SET maintenance_work_mem = '1GB'; VACUUM \(ANALYZE\) public\.anchors;/);
  });

  it('documents the bug it fixes (VACUUM-in-transaction) and the root cause', () => {
    expect(sql).toMatch(/VACUUM cannot run inside a transaction block/);
    expect(sql).toMatch(/jobid=2/);
    expect(sql).toMatch(/vacuum-anchors/);
  });
});
