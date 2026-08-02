/**
 * F-5b — NULL-identity bypass in the F-5 ownership guard.
 *
 * Compensating migration: supabase/migrations/0391_f5b_anchor_stats_null_identity_guard.sql
 * Supersedes the guard added by 0380 (PR #1778), which is already applied to
 * production and therefore must not be edited (CLAUDE.md §1.2).
 *
 * THE HOLE THIS CLOSES:
 *   0380 guards with `p_org_id IS DISTINCT FROM get_user_org_id()` (and
 *   `p_user_id IS DISTINCT FROM (SELECT auth.uid())`). For a caller with no identity
 *   both sides are NULL, and `NULL IS DISTINCT FROM NULL` is FALSE — so an
 *   explicit NULL argument skipped the RAISE and returned HTTP 200 with
 *   {"total":0,"secured":0,"pending":0} instead of a 403.
 *
 *   Not a data disclosure (`WHERE org_id = NULL` matches no row), but a
 *   response-shape defect: an unauthorized call is indistinguishable from an
 *   authorized empty result — the "silent success" shape 0380 itself set out
 *   to eliminate.
 *
 *   TWO caller classes reach it, not one:
 *     (a) anon — the anon EXECUTE grant is still live.
 *     (b) an AUTHENTICATED user whose profiles.org_id IS NULL (role
 *         INDIVIDUAL; seed user demo-user@arkova.local) — get_user_org_id()
 *         is NULL for them too, so get_org_anchor_stats(NULL) also slipped.
 *
 * WHY A SEPARATE FILE FROM f5-stats-fn-ownership-guard.test.ts:
 *   That file is not on main — it lives on PR #1778's branch alongside 0380,
 *   which is still open. A test on this branch cannot readFileSync 0380's
 *   .sql or extend a file that does not exist here without either failing on
 *   main or colliding with #1778 in the merge. This file therefore stands
 *   alone and asserts against 0391, with the 0380 cross-checks written to
 *   activate automatically once #1778 lands. Fold the two together after that.
 *
 * TWO LAYERS OF ASSERTION (repo convention):
 *   (1) CONTENT-GUARD (always runs, no DB) — asserts on the migration SQL.
 *   (2) LIVE RLS INTEGRATION (opt-in, RUN_LIVE_RLS=1, throwaway/isolated DB
 *       with 0391 applied) — actually invokes both RPCs and asserts the real
 *       response shape. Never runs in default CI. NEVER against prod: several
 *       cases are deliberately cross-tenant reads.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0391_f5b_anchor_stats_null_identity_guard.sql',
);
const MIGRATION_0380_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0380_f5_anchor_stats_fn_ownership_guard.sql',
);

let migrationCache: string | null = null;
function migration(): string {
  if (migrationCache === null) {
    migrationCache = fs.readFileSync(MIGRATION_PATH, 'utf8');
  }
  return migrationCache;
}

/** Strip SQL comment lines so header/ROLLBACK prose never satisfies an assertion. */
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

const ORG_FN = 'get_org_anchor_stats';
const USER_FN = 'get_user_anchor_stats';

describe('F-5b: migration 0391 exists, is transactional, and is reversible', () => {
  it('migration 0391 exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('is transactional and reloads the PostgREST schema cache', () => {
    const sql = executableSql(migration());
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('carries a ROLLBACK block that restores 0380\'s guarded bodies', () => {
    const sql = migration();
    expect(sql).toContain('-- ROLLBACK:');
    // The rollback must restore 0380's IS DISTINCT FROM form (not the
    // pre-0380 ungated baseline, which would re-open the original F-5).
    expect(sql).toMatch(/--\s+IF get_caller_role\(\) IS DISTINCT FROM 'service_role'/);
    expect(sql).toMatch(/--\s+AND p_org_id IS DISTINCT FROM get_user_org_id\(\)/);
    expect(sql).toContain("--   NOTIFY pgrst, 'reload schema';");
  });

  it('does not modify 0380 — it is a separate, higher-numbered file', () => {
    expect(path.basename(MIGRATION_PATH).startsWith('0391_')).toBe(true);
    // Ordering safety: lexical migration order must apply 0391 AFTER 0380 so
    // the compensating bodies win on a fresh `supabase db reset`.
    expect(path.basename(MIGRATION_PATH) > '0380_').toBe(true);
  });
});

describe.each([
  { fn: ORG_FN, idArg: 'p_org_id', identityExpr: 'get_user_org_id\\(\\)' },
  { fn: USER_FN, idArg: 'p_user_id', identityExpr: '\\(SELECT auth\\.uid\\(\\)\\)' },
])('F-5b: $fn — NULL-identity guard', ({ fn, idArg, identityExpr }) => {
  const block = () => extractFunctionBlock(executableSql(migration()), fn);

  it('is still SECURITY DEFINER, STABLE, with SET search_path = public', () => {
    expect(block()).toContain('SECURITY DEFINER');
    expect(block()).toContain('STABLE');
    expect(block()).toMatch(/SET\s+"search_path"\s+TO\s+'public'/);
  });

  it('resolves the caller identity into a local and rejects it when NULL', () => {
    // THE FIX. This is the assertion that would have caught 0380's bug: the
    // guard must test the identity for NULL explicitly, not rely on
    // IS DISTINCT FROM (which silently absorbs NULL-vs-NULL).
    expect(block()).toMatch(new RegExp(`v_caller\\w*\\s*:=\\s*${identityExpr}`));
    expect(block()).toMatch(/IF\s+v_caller\w*\s+IS\s+NULL\s+THEN/);
  });

  it('the NULL-identity RAISE comes BEFORE the argument comparison', () => {
    const b = block();
    const nullCheck = b.search(/IF\s+v_caller\w*\s+IS\s+NULL\s+THEN/);
    const argCompare = b.search(new RegExp(`${idArg}\\s+IS\\s+DISTINCT\\s+FROM`));
    expect(nullCheck).toBeGreaterThan(-1);
    expect(argCompare).toBeGreaterThan(-1);
    // Order matters: if the comparison ran first, a NULL-vs-NULL match would
    // fall straight through to the query and return a 200 again.
    expect(nullCheck).toBeLessThan(argCompare);
  });

  it('still raises 42501 (never a silent empty result)', () => {
    const b = block();
    expect(b).toMatch(/RAISE EXCEPTION[^;]*unauthorized/i);
    expect(b).toContain("USING ERRCODE = '42501'");
    // Two distinct rejection reasons: no identity, and wrong identity.
    expect(b.match(/USING ERRCODE = '42501'/g) ?? []).toHaveLength(2);
  });

  it('preserves the ownership comparison from 0380', () => {
    expect(block()).toMatch(new RegExp(`${idArg}\\s+IS\\s+DISTINCT\\s+FROM\\s+v_caller`));
  });

  it('preserves the service_role bypass', () => {
    expect(block()).toMatch(/get_caller_role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/);
  });

  it('preserves the exact stats shape', () => {
    const b = block();
    expect(b).toContain("'total', COUNT(*) FILTER (WHERE TRUE)");
    expect(b).toContain("'secured', COUNT(*) FILTER (WHERE status = 'SECURED')");
    expect(b).toContain("'pending', COUNT(*) FILTER (WHERE status = 'PENDING')");
    expect(b).toContain('AND deleted_at IS NULL');
    expect(b).toContain("AND (metadata->>'pipeline_source') IS NULL");
  });
});

describe('F-5b: scope — authorization tightening only', () => {
  it('contains no GRANT/REVOKE (grants unchanged)', () => {
    const sql = executableSql(migration());
    expect(sql).not.toMatch(/\bREVOKE\b/);
    expect(sql).not.toMatch(/\bGRANT\b/);
  });

  it('touches only the two F-5 functions', () => {
    const created = [...executableSql(migration()).matchAll(/FUNCTION\s+"public"\."(\w+)"/g)]
      .map((m) => m[1]);
    expect([...new Set(created)].sort()).toEqual([ORG_FN, USER_FN]);
  });

  it('the dashboard never calls the org RPC without an org, so the guard is non-regressive', async () => {
    const { resolveDashboardStatsRequest } = await import('@/lib/dashboardStats');
    // An ORG_ADMIN with no org must NOT be routed to the org RPC — otherwise
    // 0391 would turn a working dashboard into a 403.
    for (const profileOrgId of [null, undefined, '']) {
      const req = resolveDashboardStatsRequest({
        userId: 'user-1',
        profileLoading: false,
        profileRole: 'ORG_ADMIN',
        profileOrgId,
      });
      expect(req?.rpcName).toBe(USER_FN);
      expect(req?.rpcParam).toEqual({ p_user_id: 'user-1' });
    }
    // And with an org, it passes the caller's OWN org.
    const withOrg = resolveDashboardStatsRequest({
      userId: 'user-1',
      profileLoading: false,
      profileRole: 'ORG_ADMIN',
      profileOrgId: 'org-1',
    });
    expect(withOrg).toEqual({
      rpcName: ORG_FN,
      rpcParam: { p_org_id: 'org-1' },
      requestKey: `${ORG_FN}:org-1`,
    });
  });
});

// Activates automatically once PR #1778 merges and 0380 lands on main.
describe.skipIf(!fs.existsSync(MIGRATION_0380_PATH))(
  'F-5b: cross-check against 0380 (runs once #1778 lands on main)',
  () => {
    it('0380 has the NULL-vs-NULL hole this migration compensates for', () => {
      const sql = executableSql(fs.readFileSync(MIGRATION_0380_PATH, 'utf8'));
      const org = extractFunctionBlock(sql, ORG_FN);
      // 0380 compares directly against the helper with no prior NULL check.
      expect(org).toMatch(/p_org_id\s+IS\s+DISTINCT\s+FROM\s+get_user_org_id\(\)/);
      expect(org).not.toMatch(/IS\s+NULL\s+THEN/);
    });

    it('0391 sorts after 0380 so the compensating bodies win on a fresh reset', () => {
      const files = fs
        .readdirSync(path.join(process.cwd(), 'supabase/migrations'))
        .filter((f) => /^0(380|391)_/.test(f))
        .sort();
      expect(files[files.length - 1]).toBe(path.basename(MIGRATION_PATH));
    });
  },
);

// ---------------------------------------------------------------------------
// (2) LIVE RLS INTEGRATION — opt-in only.
//
// Requires 0391 applied to a THROWAWAY/ISOLATED DB, RUN_LIVE_RLS=1, and the
// RLS helper env vars (SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY / RLS_TEST_PASSWORD).
//
// NEVER run against production: cases below deliberately attempt cross-tenant
// reads. Never runs in default CI (no live DB creds there).
// ---------------------------------------------------------------------------
const RUN_LIVE = process.env.RUN_LIVE_RLS === '1';

describe.skipIf(!RUN_LIVE)(
  'F-5b: live NULL-identity behaviour (throwaway/isolated DB, 0391 applied)',
  () => {
    const helpers = () => import('./rls/helpers');

    type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

    /**
     * The whole point of F-5b is the RESPONSE SHAPE, so assert both halves:
     * a 42501 error AND no stats payload. Asserting only `error !== null`
     * would still pass if the function returned zeros alongside a warning.
     *
     * NB (measured on an isolated PostgREST v14.14): the SQLSTATE is 42501 for
     * every denial, but the HTTP status is NOT uniform — PostgREST returns 401
     * for the `anon` role and 403 for `authenticated`. Assert on the SQLSTATE
     * the function raises, never on the HTTP status.
     */
    function expectDenied(res: RpcResult) {
      expect(res.error).not.toBeNull();
      expect(
        res.error?.code === '42501' || /unauthorized/i.test(res.error?.message ?? ''),
      ).toBe(true);
      expect(res.data ?? null).toBeNull();
    }

    function expectAllowed(res: RpcResult) {
      expect(res.error).toBeNull();
      expect(res.data).not.toBeNull();
    }

    // ---- THE BUG: explicit NULL argument from a caller with no identity ----

    it('anon CANNOT call get_org_anchor_stats(NULL) — was 200 + zeros', async () => {
      const { createAnonClient } = await helpers();
      const res = await createAnonClient().rpc(ORG_FN as never, { p_org_id: null } as never);
      expectDenied(res as RpcResult);
    });

    it('anon CANNOT call get_user_anchor_stats(NULL) — was 200 + zeros', async () => {
      const { createAnonClient } = await helpers();
      const res = await createAnonClient().rpc(USER_FN as never, { p_user_id: null } as never);
      expectDenied(res as RpcResult);
    });

    it('anon calling with the argument omitted entirely never gets a stats payload', async () => {
      // Verified against an isolated PostgREST v14.14: omitting the arg does NOT
      // reach the function as NULL — PostgREST resolves RPC overloads by the
      // JSON body keys, finds no matching signature (p_org_id has no DEFAULT)
      // and returns 404 PGRST202. So this shape is closed by signature
      // resolution rather than by the guard. Asserted as "no silent zero
      // payload" rather than 42501, because the denial is a 404 here.
      const { createAnonClient } = await helpers();
      const res = (await createAnonClient().rpc(ORG_FN as never, {} as never)) as RpcResult;
      expect(res.error).not.toBeNull();
      expect(res.data ?? null).toBeNull();
    });

    it('AUTHENTICATED org-less user CANNOT call get_org_anchor_stats(NULL) — was 200 + zeros', async () => {
      // demo-user@arkova.local is INDIVIDUAL with profiles.org_id IS NULL, so
      // get_user_org_id() is NULL for them: the same NULL-vs-NULL match anon hit.
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const res = await user.rpc(ORG_FN as never, { p_org_id: null } as never);
      expectDenied(res as RpcResult);
    });

    it('AUTHENTICATED user CANNOT call get_user_anchor_stats(NULL)', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const res = await user.rpc(USER_FN as never, { p_user_id: null } as never);
      expectDenied(res as RpcResult);
    });

    it('AUTHENTICATED ORG_ADMIN CANNOT call get_org_anchor_stats(NULL)', async () => {
      const { withArkovaAdmin } = await helpers();
      const admin = await withArkovaAdmin();
      const res = await admin.rpc(ORG_FN as never, { p_org_id: null } as never);
      expectDenied(res as RpcResult);
    });

    // ---- 0380's original guarantees must survive the compensating change ----

    it('ORG_ADMIN CAN still read their OWN org stats', async () => {
      const { withArkovaAdmin, ORG_IDS } = await helpers();
      const admin = await withArkovaAdmin();
      const res = await admin.rpc(ORG_FN as never, { p_org_id: ORG_IDS.arkova } as never);
      expectAllowed(res as RpcResult);
    });

    it('ORG_ADMIN still CANNOT read another org\'s stats', async () => {
      const { withArkovaAdmin, ORG_IDS } = await helpers();
      const admin = await withArkovaAdmin();
      const res = await admin.rpc(ORG_FN as never, { p_org_id: ORG_IDS.betaCorp } as never);
      expectDenied(res as RpcResult);
    });

    it('user CAN still read their OWN stats', async () => {
      const { withIndividualUser, DEMO_CREDENTIALS } = await helpers();
      const user = await withIndividualUser();
      const res = await user.rpc(USER_FN as never, {
        p_user_id: DEMO_CREDENTIALS.userId,
      } as never);
      expectAllowed(res as RpcResult);
    });

    it('user still CANNOT read another user\'s stats', async () => {
      const { withIndividualUser, DEMO_CREDENTIALS } = await helpers();
      const user = await withIndividualUser();
      const res = await user.rpc(USER_FN as never, {
        p_user_id: DEMO_CREDENTIALS.adminId,
      } as never);
      expectDenied(res as RpcResult);
    });

    // ---- service_role bypass must be untouched, including with NULL ----

    it('service_role CAN still read any org\'s stats', async () => {
      const { createServiceClient, ORG_IDS } = await helpers();
      const res = await createServiceClient().rpc(ORG_FN as never, {
        p_org_id: ORG_IDS.betaCorp,
      } as never);
      expectAllowed(res as RpcResult);
    });

    it('service_role is NOT rejected by the new NULL-identity check', async () => {
      // service_role has no auth.uid()/org either — the bypass must short-circuit
      // before the NULL check, or the worker would start 403ing.
      const { createServiceClient } = await helpers();
      const res = await createServiceClient().rpc(ORG_FN as never, { p_org_id: null } as never);
      expectAllowed(res as RpcResult);
    });

    it('service_role CAN still read any user\'s stats', async () => {
      const { createServiceClient, DEMO_CREDENTIALS } = await helpers();
      const res = await createServiceClient().rpc(USER_FN as never, {
        p_user_id: DEMO_CREDENTIALS.adminId,
      } as never);
      expectAllowed(res as RpcResult);
    });
  },
);
