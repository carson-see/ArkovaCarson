/**
 * SEC / migration 0408 — content-guard for the grants on the five SECURITY
 * DEFINER functions behind the supplementary proof anchor backfill.
 *
 * WHY THIS IS A SECURITY TEST AND NOT A STYLE TEST
 *   `REVOKE ALL ... FROM PUBLIC` does NOT make a function service_role-only on
 *   Supabase. `ALTER DEFAULT PRIVILEGES` grants `anon` and `authenticated`
 *   EXECUTE **directly** at CREATE time, and revoking from `PUBLIC` never
 *   removes a direct role grant. 0408 originally shipped only the PUBLIC
 *   revoke on all five functions, so on apply each would have been callable by
 *   `anon` over PostgREST — and each is SECURITY DEFINER, so each bypasses RLS.
 *
 *   Note 0408 already revoked anon/authenticated correctly on the two TABLES
 *   (supplementary_anchor_runs, supplementary_anchor_journal). The functions
 *   were the gap. That asymmetry is the tell for this whole defect class.
 *
 * WHAT IS ACTUALLY AT RISK
 *   `persist_supplementary_journal` and `resolve_supplementary_journal` are the
 *   anti-double-broadcast journal primitives. The subsystem's safety argument is
 *   sign -> journal -> broadcast, never reordered, with unique constraints making
 *   a live txid unrepeatable. An unauthenticated caller able to write or resolve
 *   journal rows perturbs exactly the state that decides whether a transaction
 *   gets re-signed and re-broadcast. `claim_supplementary_proof_cohort` claims
 *   work units, so anon execution alone allows starving the run by pre-claiming
 *   cohorts. This guards a backfill that spends real mainnet BTC from the
 *   production treasury.
 *
 *   Caught before 0408 was ever applied: none of these five functions existed in
 *   prod at the time of this commit (verified via MCP against the prod project).
 *
 * TWO-LAYER CONVENTION (same as 0388 / 0406):
 *   This half is static and runs in ordinary CI with no database. The live ACL
 *   proof — has_function_privilege('anon', ...) = false — lives in
 *   tests/rls/supplementary-proof-anchor-revokes.test.ts under `npm run test:rls`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations',
  '0408_supplementary_proof_anchor.sql',
);

/** Every SECURITY DEFINER function 0408 defines, with its EXACT signature. */
const FUNCTIONS = [
  {
    name: 'persist_supplementary_journal',
    args: 'text, text, text, uuid[], jsonb, uuid',
    why: 'writes the anti-double-broadcast journal row BEFORE broadcast',
  },
  {
    name: 'resolve_supplementary_journal',
    args: 'uuid, text, text',
    why: 'resolves a journal row after broadcast; HOLD vs REVERT lives here',
  },
  {
    name: 'claim_supplementary_proof_cohort',
    args: 'integer, uuid[], text[]',
    why: 'claims work units — anon execution allows starving the run',
  },
  {
    name: 'insert_supplementary_proofs',
    args: 'jsonb',
    why: 'writes proof rows',
  },
  {
    name: 'supplementary_proof_backlog_count',
    args: 'integer',
    why: 'counts remaining backlog',
  },
] as const;

/** Strip SQL comment lines so header prose and ROLLBACK blocks never match. */
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

describe('0408: supplementary proof anchor functions are service_role-only', () => {
  it('migration 0408 exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('the sweep is non-vacuous — all five functions are still defined here', () => {
    // If a function is renamed or moved out, the per-function assertions below
    // would pass vacuously against a file that no longer defines it.
    const sql = executableSql(migration());
    for (const fn of FUNCTIONS) {
      expect(sql, `${fn.name} must be defined in 0408`).toMatch(
        new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn.name}\\b`, 'i'),
      );
    }
  });

  it.each(FUNCTIONS)(
    'public.$name REVOKEs from anon and authenticated BY NAME ($why)',
    ({ name, args }) => {
      const sql = executableSql(migration());
      const target = `public.${name}(${args})`;
      // The defect: `FROM PUBLIC` alone leaves the direct grants that ALTER
      // DEFAULT PRIVILEGES handed anon/authenticated at CREATE time.
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${target} FROM PUBLIC, anon, authenticated;`);
    },
  );

  it.each(FUNCTIONS)('public.$name retains EXECUTE for service_role', ({ name, args }) => {
    expect(executableSql(migration())).toContain(
      `GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO service_role;`,
    );
  });

  it.each(FUNCTIONS)('public.$name grants EXECUTE to nobody else', ({ name }) => {
    // Non-vacuous by construction: assert the grant count BEFORE inspecting
    // what the grants say, so an empty match set cannot pass.
    const normalized = executableSql(migration()).replace(/\s+/g, ' ');
    const grants = [
      ...normalized.matchAll(
        new RegExp(
          `GRANT (?:EXECUTE|ALL) ON FUNCTION public\\.${name}\\([^)]*\\) TO ([^;]+);`,
          'g',
        ),
      ),
    ].map((m) => m[1]);

    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('service_role');
    expect(grants[0]).not.toMatch(/\banon\b/);
    expect(grants[0]).not.toMatch(/\bauthenticated\b/);
  });

  it.each(FUNCTIONS)(
    'public.$name is SECURITY DEFINER with SET search_path = public (CLAUDE.md §1.4)',
    ({ name }) => {
      const sql = executableSql(migration());
      const start = sql.search(
        new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\b`, 'i'),
      );
      expect(start).toBeGreaterThan(-1);
      // Bound the window to this definition's body delimiter so a neighbouring
      // function's modifiers cannot satisfy the assertion.
      const decl = sql.slice(start, sql.indexOf('$$', start));
      expect(decl).toMatch(/SECURITY\s+DEFINER/i);
      expect(decl).not.toMatch(/SECURITY\s+INVOKER/i);
      expect(decl).toMatch(/SET\s+search_path\s*=\s*public/i);
    },
  );

  it.each(FUNCTIONS)('public.$name REVOKEs before it GRANTs', ({ name, args }) => {
    // A REVOKE after the GRANT would strip service_role's EXECUTE and break the
    // worker instead of closing the anon hole.
    const sql = executableSql(migration());
    const revoke = sql.indexOf(`REVOKE ALL ON FUNCTION public.${name}(${args})`);
    const grant = sql.indexOf(`GRANT EXECUTE ON FUNCTION public.${name}(${args})`);
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(-1);
    expect(revoke).toBeLessThan(grant);
  });

  it('reloads the PostgREST schema cache (all five are called via db.rpc)', () => {
    expect(executableSql(migration())).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('still revokes anon/authenticated on the two tables (no regression)', () => {
    const sql = executableSql(migration());
    for (const table of ['supplementary_anchor_runs', 'supplementary_anchor_journal']) {
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM anon, authenticated;`);
    }
  });
});
