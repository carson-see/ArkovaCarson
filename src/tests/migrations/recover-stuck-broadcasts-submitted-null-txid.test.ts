/**
 * F-3 (docs/staging/SOAK-FINDINGS-2026-08.md) — migration 0379.
 *
 * `recover_stuck_broadcasts()` (baseline 5051 / hardened by 0358) only ever
 * queried `status = 'BROADCASTING'`. An anchor left `SUBMITTED` with a NULL
 * `chain_tx_id` — the shape a broadcast attempt produces if it fails between
 * the status write and the txid write — was structurally outside every
 * scheduled job's WHERE clause and had NO recovery path. Proven live during
 * the launch-72h-2026-08 soak (fixture `5eed0000-...-c1` sat unrecovered for
 * days).
 *
 * Static structural assertions over the migration SQL — runs in the default
 * vitest suite (no live database / no Docker required) and gives a runnable
 * Red→Green TDD signal for the migration's *shape*: both branches guarded by
 * the same stale threshold, `chain_tx_id IS NULL`, `deleted_at IS NULL`, and
 * the SCRUM-2692 `anchor_txid_journal` PENDING/HELD protection; SECURITY
 * DEFINER + `search_path`; service_role-only grant; `FOR UPDATE SKIP LOCKED`.
 *
 * The real-Postgres behavioral proof (both branches actually reclaim/skip the
 * right rows) lives in
 * services/worker/src/jobs/recover-stuck-broadcasts-submitted.local.test.ts
 * (env-gated, requires a local Supabase stack) — mirrors the
 * `proof-materializer-trigger.local.test.ts` pattern.
 *
 * Pattern mirrored from src/tests/migrations/connector-artifact-queue-schema.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_FILE = path.join(
  process.cwd(),
  'supabase/migrations/0379_f3_recover_submitted_null_txid.sql',
);

function readMigration(): string {
  if (!fs.existsSync(MIGRATION_FILE)) {
    throw new Error(
      `Migration not found: ${MIGRATION_FILE}. ` +
        'F-3 expects 0379_f3_recover_submitted_null_txid.sql.',
    );
  }
  return fs.readFileSync(MIGRATION_FILE, 'utf8');
}

describe('F-3 — recover_stuck_broadcasts SUBMITTED+NULL-chain_tx_id recovery (0379)', () => {
  it('migration file exists with the reserved 0379 numeric prefix', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it('replaces recover_stuck_broadcasts atomically (CREATE OR REPLACE, not a new function)', () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.recover_stuck_broadcasts\s*\(\s*p_stale_minutes\s+integer\s+DEFAULT\s+5\s*\)/i,
    );
  });

  it('claims both BROADCASTING and SUBMITTED cohorts in the same stale sweep', () => {
    const sql = readMigration();
    expect(sql).toMatch(/status\s+IN\s*\(\s*'BROADCASTING'\s*,\s*'SUBMITTED'\s*\)/i);
  });

  it('preserves the chain_tx_id IS NULL guard — never reclaims a row with a real broadcast fact', () => {
    const sql = readMigration();
    expect(sql).toMatch(/chain_tx_id\s+IS\s+NULL/i);
  });

  it('preserves the deleted_at IS NULL guard', () => {
    const sql = readMigration();
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it('preserves the stale-minutes threshold applied uniformly to both cohorts', () => {
    const sql = readMigration();
    expect(sql).toMatch(/updated_at\s*<\s*now\(\)\s*-\s*\(p_stale_minutes/i);
  });

  it('preserves the SCRUM-2692 anchor_txid_journal PENDING/HELD protection (NOT EXISTS guard)', () => {
    const sql = readMigration();
    expect(sql).toMatch(/NOT\s+EXISTS/i);
    expect(sql).toMatch(/anchor_txid_journal/i);
    expect(sql).toMatch(/recovery_status\s+IN\s*\(\s*'PENDING'\s*,\s*'HELD'\s*\)/i);
  });

  it('resets recovered rows to PENDING (not any other status)', () => {
    const sql = readMigration();
    expect(sql).toMatch(/SET\s+status\s*=\s*'PENDING'/i);
  });

  it('uses FOR UPDATE SKIP LOCKED so concurrent sweeps cannot double-claim', () => {
    const sql = readMigration();
    expect(sql).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
  });

  it('records a distinguishable recovery reason for the SUBMITTED branch', () => {
    const sql = readMigration();
    // Existing BROADCASTING reason string preserved verbatim for backward
    // compatibility with services/worker/src/jobs/broadcast-recovery.ts's
    // manual fallback + existing tests that assert 'stuck_broadcasting'.
    expect(sql).toContain('stuck_broadcasting');
    expect(sql).toContain('stuck_submitted_null_txid');
  });

  it('is SECURITY DEFINER with search_path pinned to public', () => {
    const sql = readMigration();
    expect(sql).toMatch(/SECURITY\s+DEFINER/i);
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public/i);
  });

  it('remains revoked from PUBLIC/anon/authenticated and granted only to service_role', () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.recover_stuck_broadcasts\s*\(\s*integer\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.recover_stuck_broadcasts\s*\(\s*integer\s*\)\s+TO\s+service_role/i,
    );
  });

  it('reloads PostgREST schema cache', () => {
    const sql = readMigration();
    expect(sql).toMatch(/NOTIFY\s+pgrst\s*,\s*'reload schema'/i);
  });

  it('carries a ROLLBACK comment (never modify an applied migration — §1.2)', () => {
    const sql = readMigration();
    expect(sql).toMatch(/--\s*ROLLBACK/i);
  });

  it('does not gate the WHERE clause on legal_hold — recovery-to-PENDING is not a delete/revoke/supersede', () => {
    // Deliberate design decision (documented in the migration header): legal
    // hold blocks deletion/revocation/supersede but not re-queuing a broadcast
    // that never happened, matching the existing BROADCASTING branch which
    // never checked legal_hold either. The prose header is allowed to mention
    // legal_hold (it explains the decision); the function body must not
    // reference the column at all.
    const sql = readMigration();
    const functionBody = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.recover_stuck_broadcasts'),
      sql.indexOf('$$;') + 3,
    );
    expect(functionBody).not.toMatch(/legal_hold/i);
  });
});
