/**
 * SEC / migration 0406 — content-guard for the grants on
 * `public.proof_coverage_window(integer)`.
 *
 * WHY THIS FILE EXISTS
 *   `REVOKE ALL ... FROM PUBLIC` does NOT make a function service_role-only on
 *   Supabase. `ALTER DEFAULT PRIVILEGES` grants `anon` and `authenticated`
 *   EXECUTE *directly* at CREATE time, and revoking from `PUBLIC` never removes
 *   a direct role grant. 0406 shipped with only the PUBLIC revoke, so the
 *   post-apply prod ACL was
 *
 *     {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
 *
 *   i.e. a SECURITY DEFINER function that bypasses RLS, reachable by `anon`
 *   over PostgREST. It was revoked in prod on 2026-08-11; the live ACL is now
 *   {postgres=X/postgres,service_role=X/postgres}. This guard stops the FILE
 *   from re-opening it: the function uses CREATE OR REPLACE, which re-triggers
 *   default privileges on every replay.
 *
 *   This is the FIFTH occurrence of the class (0364, 0377, 0378, 0388 precede
 *   it), which is why `scripts/ci/check-secdef-function-grants.ts` now enforces
 *   it repo-wide as a ratchet. This file is the targeted guard for 0406.
 *
 * TWO-LAYER CONVENTION (same as 0388 / SCRUM-2905):
 *   This half is static and runs in ordinary CI with no database. The live ACL
 *   proof — has_function_privilege('anon', ...) = false — lives in
 *   src/tests/rls/proof-coverage-window-revoke.test.ts and runs under
 *   `npm run test:rls` against a seeded DB.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations',
  '0406_proof_coverage_window_and_reconstruction_classes.sql',
);

const TARGET = 'public.proof_coverage_window(integer)';

/** Strip SQL comment lines so header prose and the ROLLBACK block never match. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

let cache: string | null = null;
function migration(): string {
  if (cache === null) cache = fs.readFileSync(MIGRATION_PATH, 'utf8');
  return cache;
}

describe('0406: proof_coverage_window is service_role-only', () => {
  it('migration 0406 exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('REVOKEs from anon and authenticated BY NAME, not merely from PUBLIC', () => {
    // The whole defect: `FROM PUBLIC` alone leaves the direct grants that
    // ALTER DEFAULT PRIVILEGES handed to anon/authenticated at CREATE time.
    const sql = executableSql(migration());
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${TARGET} FROM PUBLIC, anon, authenticated;`);
  });

  it('retains EXECUTE for service_role', () => {
    expect(executableSql(migration())).toContain(
      `GRANT EXECUTE ON FUNCTION ${TARGET} TO service_role;`,
    );
  });

  it('does NOT grant EXECUTE to anon or authenticated', () => {
    // Non-vacuous by construction: assert the expected grant count BEFORE
    // inspecting what the grants say, so an empty match set cannot pass.
    const normalized = executableSql(migration()).replace(/\s+/g, ' ');
    const grants = [
      ...normalized.matchAll(
        /GRANT (?:EXECUTE|ALL) ON FUNCTION public\.proof_coverage_window\(integer\) TO ([^;]+);/g,
      ),
    ].map((m) => m[1]);

    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('service_role');
    expect(grants[0]).not.toMatch(/\banon\b/);
    expect(grants[0]).not.toMatch(/\bauthenticated\b/);
  });

  it('every REVOKE precedes every GRANT (order is load-bearing)', () => {
    // A REVOKE placed after the GRANT would strip service_role's EXECUTE and
    // break the worker's rpc() call instead of closing the anon hole.
    const sql = executableSql(migration());
    const lastRevoke = sql.lastIndexOf('REVOKE ALL ON FUNCTION');
    const firstGrant = sql.indexOf('GRANT EXECUTE ON FUNCTION');
    expect(lastRevoke).toBeGreaterThan(-1);
    expect(firstGrant).toBeGreaterThan(-1);
    expect(lastRevoke).toBeLessThan(firstGrant);
  });

  it('declares the function SECURITY DEFINER with SET search_path = public (CLAUDE.md §1.4)', () => {
    const sql = executableSql(migration());
    expect(sql).toMatch(/SECURITY\s+DEFINER/i);
    expect(sql).not.toMatch(/SECURITY\s+INVOKER/i);
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public/i);
  });

  it("reloads the PostgREST schema cache (the function is called via db.rpc)", () => {
    expect(executableSql(migration())).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('carries a ROLLBACK comment', () => {
    expect(migration()).toContain('-- ROLLBACK:');
  });
});
