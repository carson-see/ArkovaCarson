/**
 * F-5 (docs/staging/SOAK-FINDINGS-2026-08.md, MEDIUM) — ownership-gate
 * get_org_anchor_stats(uuid) / get_user_anchor_stats(uuid).
 *
 * THE HOLE THIS CLOSES:
 *   Both functions are SECURITY DEFINER (RLS-bypassing) and accepted a
 *   caller-supplied p_org_id / p_user_id with NO check against the
 *   caller's actual identity (auth.uid() / their own org). Migration 0378
 *   explicitly deferred fixing this (kept the `authenticated` grant)
 *   because the live dashboard (src/lib/dashboardStats.ts →
 *   src/pages/DashboardPage.tsx:213) is a real caller and revoking the
 *   grant would have broken it with no soak time to validate a body-level
 *   fix in the same emergency change. Any authenticated caller could pass
 *   another org's/user's id and read their anchor counts — cross-tenant
 *   stats disclosure.
 *
 * TWO LAYERS OF ASSERTION (same convention as
 * sec-recon-unguarded-rpc-family-revokes.test.ts / scrum-2905-security-
 * advisor-revokes.test.ts):
 *   (1) CONTENT-GUARD (always runs, no DB): reads the baseline (pre-fix)
 *       and migration 0380 (fix) SQL directly and asserts on the exact
 *       function bodies. THIS is the TDD proof: written before 0380
 *       existed, it failed (RED — no migration file, no guard in the only
 *       definition that existed); it passes now that 0380 exists (GREEN).
 *   (2) LIVE RLS INTEGRATION (opt-in via RUN_LIVE_RLS=1 against a
 *       throwaway DB with 0380 applied): actually invokes both RPCs
 *       cross-tenant and same-tenant and asserts the real Postgres/
 *       PostgREST behavior. Gated OFF by default — this session did not
 *       run it (the shared local Supabase instance used by other parallel
 *       worktree sessions this window is not a clean/isolated DB safe to
 *       mutate for this proof; see PR body for the isolated-rig plan).
 *       Never runs in default CI; NOT run against prod (0380 is NOT
 *       applied to prod in this PR).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASELINE_PATH = path.join(
  process.cwd(),
  'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
);
const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0380_f5_anchor_stats_fn_ownership_guard.sql',
);

let baselineCache: string | null = null;
function baseline(): string {
  if (baselineCache === null) {
    baselineCache = fs.readFileSync(BASELINE_PATH, 'utf8');
  }
  return baselineCache;
}

let migrationCache: string | null = null;
function migration(): string {
  if (migrationCache === null) {
    migrationCache = fs.readFileSync(MIGRATION_PATH, 'utf8');
  }
  return migrationCache;
}

/** Strip SQL comment lines so grants/bodies in header/ROLLBACK prose don't match. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Extract a `CREATE OR REPLACE FUNCTION "public"."<name>"...$$;` block. */
function extractFunctionBlock(sql: string, fnName: string): string {
  const marker = `FUNCTION "public"."${fnName}"`;
  const start = sql.indexOf(marker);
  if (start === -1) return '';
  const end = sql.indexOf('$$;', start);
  if (end === -1) return '';
  return sql.slice(start, end + 3);
}

describe('F-5: baseline (pre-fix) get_org_anchor_stats/get_user_anchor_stats have NO ownership guard', () => {
  it('documents the vulnerability: baseline get_org_anchor_stats body has no auth.uid()/get_user_org_id() gate', () => {
    const block = extractFunctionBlock(baseline(), 'get_org_anchor_stats');
    expect(block).toContain('SECURITY DEFINER');
    expect(block).not.toMatch(/get_user_org_id\(\)/);
    expect(block).not.toMatch(/auth\.uid\(\)/);
    expect(block).not.toMatch(/RAISE EXCEPTION/);
  });

  it('documents the vulnerability: baseline get_user_anchor_stats body has no auth.uid() gate', () => {
    const block = extractFunctionBlock(baseline(), 'get_user_anchor_stats');
    expect(block).toContain('SECURITY DEFINER');
    expect(block).not.toMatch(/auth\.uid\(\)/);
    expect(block).not.toMatch(/RAISE EXCEPTION/);
  });

  it('baseline still grants both functions to authenticated (why 0378 could not just REVOKE)', () => {
    const sql = baseline();
    expect(sql).toMatch(
      /GRANT[^;]+ON\s+FUNCTION\s+"public"\."get_org_anchor_stats"[^;]*TO\s+"?authenticated"?/i,
    );
    expect(sql).toMatch(
      /GRANT[^;]+ON\s+FUNCTION\s+"public"\."get_user_anchor_stats"[^;]*TO\s+"?authenticated"?/i,
    );
  });
});

describe('F-5: migration 0380 exists and is transactional', () => {
  it('migration 0380 exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('is transactional and reloads the PostgREST schema cache', () => {
    const sql = executableSql(migration());
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('carries a ROLLBACK comment block restoring the original ungated bodies', () => {
    const sql = migration();
    expect(sql).toContain('-- ROLLBACK:');
    expect(sql).toMatch(/--\s+SELECT jsonb_build_object\(/);
    expect(sql).toContain("--   NOTIFY pgrst, 'reload schema';");
  });
});

describe('F-5: get_org_anchor_stats(uuid) — fixed body', () => {
  it('is still SECURITY DEFINER with SET search_path = public', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_org_anchor_stats');
    expect(block).toContain('SECURITY DEFINER');
    expect(block).toMatch(/SET\s+"search_path"\s+TO\s+'public'/);
  });

  it('gates p_org_id against get_user_org_id()', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_org_anchor_stats');
    expect(block).toMatch(/p_org_id\s+IS\s+DISTINCT\s+FROM\s+get_user_org_id\(\)/);
  });

  it('raises 42501 (insufficient_privilege) on mismatch, not a silent empty result', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_org_anchor_stats');
    expect(block).toMatch(/RAISE EXCEPTION[^;]*unauthorized/i);
    expect(block).toContain("USING ERRCODE = '42501'");
  });

  it('exempts service_role via get_caller_role() (worker/admin bypass)', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_org_anchor_stats');
    expect(block).toMatch(/get_caller_role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/);
  });

  it('preserves the original stats shape (total/secured/pending over non-deleted, non-pipeline anchors)', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_org_anchor_stats');
    expect(block).toContain("'total', COUNT(*) FILTER (WHERE TRUE)");
    expect(block).toContain("'secured', COUNT(*) FILTER (WHERE status = 'SECURED')");
    expect(block).toContain("'pending', COUNT(*) FILTER (WHERE status = 'PENDING')");
    expect(block).toContain('WHERE org_id = p_org_id');
    expect(block).toContain('AND deleted_at IS NULL');
    expect(block).toContain("AND (metadata->>'pipeline_source') IS NULL");
  });
});

describe('F-5: get_user_anchor_stats(uuid) — fixed body', () => {
  it('is still SECURITY DEFINER with SET search_path = public', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_user_anchor_stats');
    expect(block).toContain('SECURITY DEFINER');
    expect(block).toMatch(/SET\s+"search_path"\s+TO\s+'public'/);
  });

  it('gates p_user_id against (SELECT auth.uid()) — wrapped per SCRUM-1278 (same convention as get_user_monthly_anchor_count, plus the initplan wrap)', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_user_anchor_stats');
    expect(block).toMatch(/p_user_id\s+IS\s+DISTINCT\s+FROM\s+\(SELECT\s+auth\.uid\(\)\)/);
  });

  it('raises 42501 (insufficient_privilege) on mismatch, not a silent empty result', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_user_anchor_stats');
    expect(block).toMatch(/RAISE EXCEPTION[^;]*unauthorized/i);
    expect(block).toContain("USING ERRCODE = '42501'");
  });

  it('exempts service_role via get_caller_role() (worker/admin bypass)', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_user_anchor_stats');
    expect(block).toMatch(/get_caller_role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/);
  });

  it('preserves the original stats shape', () => {
    const block = extractFunctionBlock(executableSql(migration()), 'get_user_anchor_stats');
    expect(block).toContain("'total', COUNT(*) FILTER (WHERE TRUE)");
    expect(block).toContain('WHERE user_id = p_user_id');
    expect(block).toContain('AND deleted_at IS NULL');
  });
});

describe('F-5: does not widen or narrow grants (authorization tightening only, in-body)', () => {
  it('migration 0380 contains no REVOKE/GRANT statements', () => {
    const sql = executableSql(migration());
    expect(sql).not.toMatch(/\bREVOKE\b/);
    expect(sql).not.toMatch(/\bGRANT\b/);
  });
});

describe('F-5: confirmed dashboard call site always passes the caller\'s own identity', () => {
  it('resolveDashboardStatsRequest sources p_org_id from the caller\'s own profile.org_id', async () => {
    const { resolveDashboardStatsRequest } = await import('@/lib/dashboardStats');
    const req = resolveDashboardStatsRequest({
      userId: 'user-1',
      profileLoading: false,
      profileRole: 'ORG_ADMIN',
      profileOrgId: 'org-owned-by-user-1',
    });
    expect(req).toEqual({
      rpcName: 'get_org_anchor_stats',
      rpcParam: { p_org_id: 'org-owned-by-user-1' },
      requestKey: 'get_org_anchor_stats:org-owned-by-user-1',
    });
  });

  it('resolveDashboardStatsRequest sources p_user_id from the caller\'s own auth user id', async () => {
    const { resolveDashboardStatsRequest } = await import('@/lib/dashboardStats');
    const req = resolveDashboardStatsRequest({
      userId: 'user-1',
      profileLoading: false,
      profileRole: 'INDIVIDUAL',
      profileOrgId: null,
    });
    expect(req).toEqual({
      rpcName: 'get_user_anchor_stats',
      rpcParam: { p_user_id: 'user-1' },
      requestKey: 'get_user_anchor_stats:user-1',
    });
  });

  it('DashboardPage.tsx has exactly one .rpc() call site for these functions, and it uses the resolved request unmodified', () => {
    const dashboardPage = fs.readFileSync(
      path.join(process.cwd(), 'src/pages/DashboardPage.tsx'),
      'utf8',
    );
    const rpcCallSites = dashboardPage.match(/\.rpc\(/g) ?? [];
    expect(rpcCallSites).toHaveLength(1);
    expect(dashboardPage).toContain(
      '.rpc(activeStatsRequest.rpcName, activeStatsRequest.rpcParam)',
    );
  });
});

// ---------------------------------------------------------------------------
// (2) LIVE RLS INTEGRATION — opt-in only. Requires 0380 applied to a
// THROWAWAY/isolated DB and RUN_LIVE_RLS=1 + the RLS helper env vars.
// Never runs in default CI (no live DB creds there). NOT run against prod
// or the shared local dev instance in this session — 0380 is NOT applied
// anywhere yet.
// ---------------------------------------------------------------------------
const RUN_LIVE = process.env.RUN_LIVE_RLS === '1';

describe.skipIf(!RUN_LIVE)(
  'F-5: live RPC ownership-guard behaviour (throwaway/isolated DB, 0380 applied)',
  () => {
    const helpers = () => import('./rls/helpers');

    function isPermissionDenied(error: { code?: string; message?: string } | null): boolean {
      if (!error) return false;
      return error.code === '42501' || /unauthorized/i.test(error.message ?? '');
    }

    it('ORG_ADMIN (arkova) CAN read their own org stats', async () => {
      const { withArkovaAdmin, ORG_IDS } = await helpers();
      const admin = await withArkovaAdmin();
      const { error } = await admin.rpc('get_org_anchor_stats' as never, {
        p_org_id: ORG_IDS.arkova,
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('ORG_ADMIN (arkova) CANNOT read betaCorp org stats — the bug this closes', async () => {
      const { withArkovaAdmin, ORG_IDS } = await helpers();
      const admin = await withArkovaAdmin();
      const { error } = await admin.rpc('get_org_anchor_stats' as never, {
        p_org_id: ORG_IDS.betaCorp,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('ORG_ADMIN (beta) CAN read their own org stats', async () => {
      const { withBetaAdmin, ORG_IDS } = await helpers();
      const beta = await withBetaAdmin();
      const { error } = await beta.rpc('get_org_anchor_stats' as never, {
        p_org_id: ORG_IDS.betaCorp,
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('INDIVIDUAL user CAN read their own user stats', async () => {
      const { withIndividualUser, DEMO_CREDENTIALS } = await helpers();
      const user = await withIndividualUser();
      const { error } = await user.rpc('get_user_anchor_stats' as never, {
        p_user_id: DEMO_CREDENTIALS.userId,
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('INDIVIDUAL user CANNOT read another user\'s stats — the bug this closes', async () => {
      const { withIndividualUser, DEMO_CREDENTIALS } = await helpers();
      const user = await withIndividualUser();
      const { error } = await user.rpc('get_user_anchor_stats' as never, {
        p_user_id: DEMO_CREDENTIALS.adminId,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('anon CANNOT read an arbitrary org\'s stats', async () => {
      const { createAnonClient, ORG_IDS } = await helpers();
      const anon = createAnonClient();
      const { error } = await anon.rpc('get_org_anchor_stats' as never, {
        p_org_id: ORG_IDS.arkova,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('service_role CAN read any org\'s stats (worker/admin bypass)', async () => {
      const { createServiceClient, ORG_IDS } = await helpers();
      const svc = createServiceClient();
      const { error } = await svc.rpc('get_org_anchor_stats' as never, {
        p_org_id: ORG_IDS.betaCorp,
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('service_role CAN read any user\'s stats (worker/admin bypass)', async () => {
      const { createServiceClient, DEMO_CREDENTIALS } = await helpers();
      const svc = createServiceClient();
      const { error } = await svc.rpc('get_user_anchor_stats' as never, {
        p_user_id: DEMO_CREDENTIALS.adminId,
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });
  },
);
