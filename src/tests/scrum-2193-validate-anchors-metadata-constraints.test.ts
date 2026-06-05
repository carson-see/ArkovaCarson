import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');

function readValidateConstraintsMigration(): string {
  const migration = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .find((file) => file.includes('0333_scrum2193_validate_anchors_metadata_constraints'));

  if (!migration) {
    throw new Error('Missing 0333 SCRUM-2193 validate-anchors-metadata-constraints migration');
  }

  return fs.readFileSync(path.join(migrationsDir, migration), 'utf8');
}

describe('SCRUM-2193 validate anchors CPE/CLE metadata constraints migration', () => {
  const sql = readValidateConstraintsMigration();

  it('validates both NOT VALID constraints with separate VALIDATE CONSTRAINT statements', () => {
    expect(sql).toContain(
      'ALTER TABLE public.anchors VALIDATE CONSTRAINT anchors_cpe_metadata_is_object;',
    );
    expect(sql).toContain(
      'ALTER TABLE public.anchors VALIDATE CONSTRAINT anchors_cle_metadata_is_object;',
    );
  });

  it('disables statement_timeout (scoped LOCAL) for the ~22 GB full-table validation scan', () => {
    expect(sql).toContain('SET LOCAL statement_timeout = 0;');
  });

  it('guards each VALIDATE behind an existence + still-NOT-VALID idempotency check', () => {
    // convalidated = false guard makes a clean DB (constraints already VALID) a no-op.
    const guardMatches = sql.match(/c\.convalidated = false/g) ?? [];
    expect(guardMatches.length).toBe(2);
    expect(sql).toContain("c.conname = 'anchors_cpe_metadata_is_object'");
    expect(sql).toContain("c.conname = 'anchors_cle_metadata_is_object'");
    expect(sql).toContain("t.relname = 'anchors'");
    expect(sql).toContain("n.nspname = 'public'");
    expect(sql).toContain("c.contype = 'c'");
  });

  it('documents the repo<->prod drift, the pre-check, and online-safe locking', () => {
    expect(sql).toContain('SCRUM-2193');
    expect(sql).toMatch(/convalidated = false/);
    expect(sql).toContain('SHARE UPDATE EXCLUSIVE');
    expect(sql).toMatch(/PRE-CHECK/);
    expect(sql).toMatch(/jsonb_typeof\(cpe_metadata\) <> 'object'/);
    expect(sql).toMatch(/jsonb_typeof\(cle_metadata\) <> 'object'/);
  });

  it('documents that rollback is a one-way no-op (does not re-mark NOT VALID)', () => {
    expect(sql).toContain('-- ROLLBACK:');
    expect(sql).toMatch(/one-way/i);
    // No EXECUTABLE statement re-marks the constraints NOT VALID. Strip SQL
    // comment lines first so the rollback prose explaining why we don't do it
    // doesn't trip this guard; then assert no live SQL contains 'NOT VALID'.
    const executableSql = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(executableSql).not.toMatch(/NOT VALID/i);
    expect(executableSql).not.toMatch(/ADD CONSTRAINT/i);
  });

  it('runs inside a single transaction (BEGIN/COMMIT) so SET LOCAL is scoped', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });
});
