/**
 * SCRUM-2535 — `validate_api_key` must reject expired and revoked keys (migration 0382).
 *
 * Static structural assertions over the migration SQL. These run in the default
 * vitest suite (no live database / no Docker) and give a runnable Red→Green TDD
 * signal for the migration's shape.
 *
 * The bug: the pre-0382 body selected `WHERE ak.key_hash = v_hash AND
 * ak.is_active = true` and never consulted `expires_at`, so an expired API key
 * still authenticated on the edge MCP path (`services/edge/src/mcp-server.ts`
 * `validateApiKey`, which delegates entirely to this RPC). Measured against
 * live production on 2026-08-01: 11 of 18 active keys were already past their
 * `expires_at` and still validating.
 *
 * The Cloud Run worker was never vulnerable — it does its own expiry check in
 * `services/worker/src/middleware/apiKeyAuth.ts`. This test pins the RPC-side
 * fix so the two paths cannot drift back apart.
 *
 * Pattern mirrored from src/tests/migrations/connector-artifact-queue-schema.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_FILE = path.join(
  process.cwd(),
  'supabase/migrations/0382_scrum2535_validate_api_key_expiry_and_revocation.sql',
);

function readMigration(): string {
  if (!fs.existsSync(MIGRATION_FILE)) {
    throw new Error(
      `Migration not found: ${MIGRATION_FILE}. ` +
        'SCRUM-2535 expects 0382_scrum2535_validate_api_key_expiry_and_revocation.sql.',
    );
  }
  return fs.readFileSync(MIGRATION_FILE, 'utf8');
}

/** The migration body with all `--` comment lines stripped. */
function executableSql(): string {
  return readMigration()
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('SCRUM-2535 — validate_api_key expiry + revocation (0382)', () => {
  it('migration file exists with the reserved 0382 numeric prefix', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  describe('the fix itself', () => {
    it('rejects expired keys, treating NULL expires_at as "never expires"', () => {
      const sql = executableSql();
      expect(sql).toMatch(/AND\s*\(\s*ak\.expires_at IS NULL OR ak\.expires_at > now\(\)\s*\)/);
    });

    it('rejects revoked keys (defense in depth alongside is_active)', () => {
      expect(executableSql()).toMatch(/AND\s+ak\.revoked_at IS NULL/);
    });

    it('keeps the pre-existing is_active predicate', () => {
      expect(executableSql()).toMatch(/ak\.is_active\s*=\s*true/);
    });

    it('applies the predicates to the api_keys lookup, not somewhere unrelated', () => {
      const sql = executableSql();
      const from = sql.indexOf('FROM public.api_keys ak');
      const limit = sql.indexOf('LIMIT 1', from);
      expect(from).toBeGreaterThan(-1);
      expect(limit).toBeGreaterThan(from);
      const whereClause = sql.slice(from, limit);
      expect(whereClause).toContain('ak.expires_at');
      expect(whereClause).toContain('ak.revoked_at');
    });
  });

  describe('invariants that must NOT regress', () => {
    it('stays SECURITY DEFINER with a pinned search_path (CLAUDE.md §1.4)', () => {
      const sql = executableSql();
      expect(sql).toMatch(/SECURITY DEFINER/);
      expect(sql).toMatch(/SET search_path TO 'public'/);
    });

    it('keeps the function signature and return type frozen', () => {
      expect(executableSql()).toMatch(
        /CREATE OR REPLACE FUNCTION public\.validate_api_key\(p_api_key text\)\s*\n\s*RETURNS jsonb/,
      );
    });

    it('still fails closed on a null/empty key and a missing HMAC secret', () => {
      const sql = executableSql();
      expect(sql).toMatch(/IF p_api_key IS NULL OR length\(p_api_key\) = 0 THEN/);
      expect(sql).toMatch(/IF v_secret IS NULL THEN/);
    });

    it('never widens grants beyond service_role', () => {
      const sql = executableSql();
      expect(sql).toMatch(
        /REVOKE ALL ON FUNCTION public\.validate_api_key\(text\) FROM PUBLIC, anon, authenticated/,
      );
      expect(sql).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.validate_api_key\(text\) TO service_role/,
      );
      expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.validate_api_key\(text\) TO [^;]*\b(anon|authenticated)\b/);
    });

    it('never returns the key hash or the HMAC secret to the caller', () => {
      const sql = executableSql();
      const returnStart = sql.indexOf('RETURN jsonb_build_object');
      expect(returnStart).toBeGreaterThan(-1);
      const returnBlock = sql.slice(returnStart, sql.indexOf('END;', returnStart));
      expect(returnBlock).not.toContain('v_hash');
      expect(returnBlock).not.toContain('v_secret');
      expect(returnBlock).not.toContain('key_hash');
    });

    it('reloads the PostgREST schema cache so the edge path picks the fix up', () => {
      expect(executableSql()).toMatch(/NOTIFY pgrst, 'reload schema'/);
    });
  });

  describe('migration hygiene (CLAUDE.md §4, supabase/migrations/agents.md)', () => {
    it('carries a -- ROLLBACK: block', () => {
      expect(readMigration()).toMatch(/^--\s*ROLLBACK:/m);
    });

    it('the rollback restores a validate_api_key definition', () => {
      const rollback = readMigration().slice(readMigration().search(/^--\s*ROLLBACK:/m));
      expect(rollback).toMatch(/CREATE OR REPLACE FUNCTION public\.validate_api_key/);
    });

    it('runs inside an explicit transaction with a lock timeout', () => {
      const sql = executableSql();
      expect(sql).toMatch(/^BEGIN;/m);
      expect(sql).toMatch(/SET LOCAL lock_timeout/);
      expect(sql).toMatch(/^COMMIT;/m);
    });

    it('documents the measured production blast radius rather than asserting none', () => {
      // The migration must not silently cut live callers: it has to name how
      // many keys stop working and how to enumerate them before applying.
      const header = readMigration();
      expect(header).toMatch(/BLAST RADIUS/);
      expect(header).toMatch(/FROM api_keys/);
    });
  });
});
