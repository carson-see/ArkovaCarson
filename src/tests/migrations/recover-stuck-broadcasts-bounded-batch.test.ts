/**
 * SCRUM-4520 — migration 0441: bound `recover_stuck_broadcasts()` to a batch.
 *
 * On staging rig `txvvrxngyfnnqahujbld` (2026-09-07) a Cloud Run SIGTERM left
 * 10,000 anchors BROADCASTING with a NULL `chain_tx_id`. The recovery RPC
 * selected `FOR UPDATE SKIP LOCKED` but took no LIMIT, so a single call tried
 * to claim all 10,000 rows and died on its own 60s `statement_timeout`
 * (SQLSTATE 57014) on every pass. The rows had to be deleted by hand.
 *
 * A stuck BROADCASTING cohort head-of-line blocks batch anchoring, so an
 * unbounded recovery function is a liveness bug: the queue never drains.
 *
 * Static structural assertions over the migration SQL — runs in the default
 * vitest suite (no live database / no Docker required) and gives a runnable
 * Red→Green TDD signal for the migration's *shape*. The behavioural proof of
 * the caller-side loop lives in
 * services/worker/src/jobs/broadcast-recovery.test.ts; the real-Postgres
 * proof of this SQL lives in
 * services/worker/src/jobs/recover-stuck-broadcasts-submitted.local.test.ts
 * (env-gated).
 *
 * Pattern mirrored from recover-stuck-broadcasts-submitted-null-txid.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_FILE = path.join(
  process.cwd(),
  'supabase/migrations/0441_scrum4520_recover_stuck_broadcasts_bounded_batch.sql',
);

function readMigration(): string {
  if (!fs.existsSync(MIGRATION_FILE)) {
    throw new Error(
      `Migration not found: ${MIGRATION_FILE}. ` +
        'SCRUM-4520 expects 0441_scrum4520_recover_stuck_broadcasts_bounded_batch.sql.',
    );
  }
  return fs.readFileSync(MIGRATION_FILE, 'utf8');
}

/** The function body only — prose headers and the ROLLBACK comment excluded. */
function readFunctionBody(): string {
  const sql = readMigration();
  const start = sql.indexOf('CREATE FUNCTION public.recover_stuck_broadcasts');
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start) + 3);
}

describe('SCRUM-4520 — recover_stuck_broadcasts bounded batch (0441)', () => {
  it('migration file exists with the reserved 0441 numeric prefix', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it('takes a p_limit argument with a safe default', () => {
    expect(readFunctionBody()).toMatch(/p_limit\s+integer\s+DEFAULT\s+\d+/i);
  });

  it('BOUNDS the claim query with a LIMIT — the whole point of the fix', () => {
    const body = readFunctionBody();
    expect(body).toMatch(/LIMIT\s+/i);
    expect(body).toMatch(/LIMIT[^;]*p_limit/i);
  });

  it('clamps p_limit server-side so a caller cannot restore the unbounded sweep', () => {
    const body = readFunctionBody();
    expect(body).toMatch(/LEAST\s*\(\s*GREATEST\s*\(\s*COALESCE\s*\(\s*p_limit/i);
  });

  it('claims oldest-first so head-of-line blockers clear first', () => {
    expect(readFunctionBody()).toMatch(/ORDER\s+BY\s+a2\.updated_at\s+ASC/i);
  });

  it('drops the old one-argument signature so the two never coexist as ambiguous overloads', () => {
    const sql = readMigration();
    expect(sql).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.recover_stuck_broadcasts\s*\(\s*integer\s*\)/i);
  });

  it('re-establishes the grant state on the NEW two-argument signature (DROP discards it)', () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.recover_stuck_broadcasts\s*\(\s*integer\s*,\s*integer\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.recover_stuck_broadcasts\s*\(\s*integer\s*,\s*integer\s*\)\s+TO\s+service_role/i,
    );
  });

  it('bounds the DDL lock so the DROP cannot camp a lock queue (§1.2)', () => {
    expect(readMigration()).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'[1-9]/i);
  });

  // ── Everything below is a regression guard: 0379/0358 semantics preserved ──

  it('still claims both the BROADCASTING and SUBMITTED cohorts (F-3, 0379)', () => {
    expect(readFunctionBody()).toMatch(/status\s+IN\s*\(\s*'BROADCASTING'\s*,\s*'SUBMITTED'\s*\)/i);
  });

  it('preserves the chain_tx_id IS NULL double-broadcast guard', () => {
    expect(readFunctionBody()).toMatch(/chain_tx_id\s+IS\s+NULL/i);
  });

  it('preserves the deleted_at IS NULL guard', () => {
    expect(readFunctionBody()).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it('preserves the stale-minutes threshold', () => {
    expect(readFunctionBody()).toMatch(/updated_at\s*<\s*now\(\)\s*-\s*\(p_stale_minutes/i);
  });

  it('preserves the SCRUM-2692 anchor_txid_journal PENDING/HELD protection', () => {
    const body = readFunctionBody();
    expect(body).toMatch(/NOT\s+EXISTS/i);
    expect(body).toMatch(/anchor_txid_journal/i);
    expect(body).toMatch(/recovery_status\s+IN\s*\(\s*'PENDING'\s*,\s*'HELD'\s*\)/i);
  });

  it('preserves FOR UPDATE SKIP LOCKED alongside the new LIMIT', () => {
    expect(readFunctionBody()).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
  });

  it('resets recovered rows to PENDING with both recovery reasons intact', () => {
    const body = readFunctionBody();
    expect(body).toMatch(/SET\s+status\s*=\s*'PENDING'/i);
    expect(body).toContain('stuck_broadcasting');
    expect(body).toContain('stuck_submitted_null_txid');
    expect(body).toContain('_recovered_from_status');
  });

  it('keeps the RETURNS TABLE row shape the worker maps', () => {
    const body = readFunctionBody();
    for (const col of ['anchor_id uuid', 'anchor_fingerprint text', 'claimed_by text', 'stuck_since timestamptz']) {
      expect(body).toContain(col);
    }
  });

  it('is SECURITY DEFINER with search_path pinned to public and a bounded statement_timeout', () => {
    const body = readFunctionBody();
    expect(body).toMatch(/SECURITY\s+DEFINER/i);
    expect(body).toMatch(/SET\s+search_path\s*=\s*public/i);
    expect(body).toMatch(/SET\s+statement_timeout\s*=\s*'60s'/i);
  });

  it('does not gate the WHERE clause on legal_hold (unchanged from 0379)', () => {
    expect(readFunctionBody()).not.toMatch(/legal_hold/i);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(readMigration()).toMatch(/NOTIFY\s+pgrst\s*,\s*'reload schema'/i);
  });

  it('carries a ROLLBACK comment (never modify an applied migration — §1.2)', () => {
    expect(readMigration()).toMatch(/--\s*ROLLBACK/i);
  });
});
