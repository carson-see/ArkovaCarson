/**
 * F-5c — last instance of the F-5b NULL-identity guard idiom.
 *
 * Migration: supabase/migrations/0392_f5c_monthly_anchor_count_null_identity_guard.sql
 * Lint:      scripts/ci/check-null-identity-guard.ts
 *
 * public.get_user_monthly_anchor_count(uuid) carried
 * `p_user_id IS DISTINCT FROM auth.uid()` with no NULL pre-check — the same
 * collapse 0391 fixed for get_org_anchor_stats/get_user_anchor_stats.
 *
 * SEVERITY (verified live against prod 2026-08-02, do not re-triage as a
 * pen-test finding): anon has NO EXECUTE grant on this function, and every
 * authenticated caller has a non-NULL auth id, so the guard already raises
 * correctly for every caller that can actually reach it. This is a latent
 * trap — one GRANT away from live — not a reachable bypass.
 *
 * The migration also adds the service_role bypass the function never had, and
 * wraps auth.uid() per SCRUM-1278.
 *
 * THREE LAYERS:
 *   (1) MIGRATION CONTENT-GUARD (always runs, no DB).
 *   (2) LINT FAILURE-MODE TESTS (always runs, no DB) — proves the new CI lint
 *       actually catches the bad shape and accepts the good one. A guard that
 *       cannot fail proves nothing.
 *   (3) LIVE RLS INTEGRATION (opt-in, RUN_LIVE_RLS=1, throwaway/isolated DB).
 *       Never in default CI. NEVER against prod.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const FN = 'get_user_monthly_anchor_count';
const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0392_f5c_monthly_anchor_count_null_identity_guard.sql',
);
const LINT_PATH = path.join(process.cwd(), 'scripts/ci/check-null-identity-guard.ts');

let migrationCache: string | null = null;
function migration(): string {
  if (migrationCache === null) migrationCache = fs.readFileSync(MIGRATION_PATH, 'utf8');
  return migrationCache;
}

/** Strip SQL comment lines so header/ROLLBACK prose never satisfies an assertion. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function functionBlock(sql: string): string {
  const marker = `FUNCTION "public"."${FN}"`;
  const start = sql.indexOf(marker);
  if (start === -1) return '';
  const end = sql.indexOf('$$;', start);
  return end === -1 ? '' : sql.slice(start, end + 3);
}

// ---------------------------------------------------------------------------
// (1) Migration content-guard
// ---------------------------------------------------------------------------
describe('F-5c: migration 0392 shape', () => {
  it('exists, is transactional, reloads the PostgREST cache, and is reversible', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    const sql = executableSql(migration());
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
    expect(migration()).toContain('-- ROLLBACK:');
  });

  it('resolves the caller identity into a local and rejects NULL before comparing', () => {
    const b = functionBlock(executableSql(migration()));
    // THE FIX — the assertion that would have caught the original bug.
    expect(b).toMatch(/v_caller_id\s*:=\s*\(SELECT auth\.uid\(\)\)/);
    const nullCheck = b.search(/IF\s+v_caller_id\s+IS\s+NULL\s+THEN/);
    const argCompare = b.search(/p_user_id\s+IS\s+DISTINCT\s+FROM/);
    expect(nullCheck).toBeGreaterThan(-1);
    expect(argCompare).toBeGreaterThan(-1);
    expect(nullCheck).toBeLessThan(argCompare);
  });

  it('compares against the local, never against the identity function directly', () => {
    const b = functionBlock(executableSql(migration()));
    expect(b).toMatch(/p_user_id\s+IS\s+DISTINCT\s+FROM\s+v_caller_id/);
    // The original bug shape must not survive anywhere in executable SQL.
    expect(b).not.toMatch(/IS\s+DISTINCT\s+FROM\s*\(?\s*(?:SELECT\s+)?auth\.uid\(\)/);
  });

  it('adds the service_role bypass the function never had', () => {
    const b = functionBlock(executableSql(migration()));
    expect(b).toMatch(/get_caller_role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/);
  });

  it('raises 42501 for both rejection reasons, never a silent zero', () => {
    const b = functionBlock(executableSql(migration()));
    expect(b.match(/USING ERRCODE = '42501'/g) ?? []).toHaveLength(2);
  });

  it('preserves signature, volatility, security context and the exact count query', () => {
    const b = functionBlock(executableSql(migration()));
    expect(b).toContain('RETURNS integer');
    expect(b).toContain('STABLE');
    expect(b).toContain('SECURITY DEFINER');
    expect(b).toMatch(/SET\s+"search_path"\s+TO\s+'public'/);
    expect(b).toContain('SELECT count(*)::integer INTO v_count FROM anchors');
    expect(b).toContain('WHERE user_id = p_user_id');
    expect(b).toContain("AND created_at >= date_trunc('month', now())");
  });

  it('does not change grants (anon must stay without EXECUTE)', () => {
    const sql = executableSql(migration());
    expect(sql).not.toMatch(/\bGRANT\b/);
    expect(sql).not.toMatch(/\bREVOKE\b/);
  });
});

// ---------------------------------------------------------------------------
// (2) Lint failure-mode tests — the lint must be able to FAIL.
// ---------------------------------------------------------------------------
describe('F-5c: check-null-identity-guard lint actually detects the bug class', () => {
  /** Run the lint against a scratch repo root containing only `files`. */
  function runLint(
    files: Record<string, string>,
    env: Record<string, string> = {},
  ): { code: number; out: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f5c-lint-'));
    fs.mkdirSync(path.join(dir, 'supabase/migrations'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, rel), body);
    }
    // The lint enumerates via `git ls-files`, so the scratch dir needs a repo.
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    try {
      const out = execFileSync('npx', ['tsx', LINT_PATH], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NULL_IDENTITY_REPO_ROOT: dir, PR_LABELS: '', ...env },
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const BAD = `BEGIN;
CREATE OR REPLACE FUNCTION "public"."f"("p_user_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER SET "search_path" TO 'public' AS $$
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'nope' USING ERRCODE = '42501';
  END IF;
  RETURN 0;
END;
$$;
COMMIT;
`;

  const GOOD = `BEGIN;
CREATE OR REPLACE FUNCTION "public"."f"("p_user_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER SET "search_path" TO 'public' AS $$
DECLARE v_caller_id uuid;
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    v_caller_id := (SELECT auth.uid());
    IF v_caller_id IS NULL THEN
      RAISE EXCEPTION 'nope' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS DISTINCT FROM v_caller_id THEN
      RAISE EXCEPTION 'nope' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN 0;
END;
$$;
COMMIT;
`;

  it('FAILS on a bare `IS DISTINCT FROM auth.uid()` guard', () => {
    const r = runLint({ 'supabase/migrations/0500_bad.sql': BAD });
    expect(r.code).toBe(1);
    expect(r.out).toContain('0500_bad.sql');
  });

  it('FAILS on `IS DISTINCT FROM get_user_org_id()` too', () => {
    const r = runLint({
      'supabase/migrations/0500_bad.sql': BAD.replace('auth.uid()', 'get_user_org_id()'),
    });
    expect(r.code).toBe(1);
  });

  it('FAILS on the wrapped `IS DISTINCT FROM (SELECT auth.uid())` form', () => {
    // The SCRUM-1278 wrap fixes per-row cost, NOT the NULL collapse — the
    // wrapped form is exactly as unsafe and must still be caught.
    const r = runLint({
      'supabase/migrations/0500_bad.sql': BAD.replace('auth.uid()', '(SELECT auth.uid())'),
    });
    expect(r.code).toBe(1);
  });

  it('PASSES on the required resolve-then-NULL-check-then-compare shape', () => {
    const r = runLint({ 'supabase/migrations/0500_good.sql': GOOD });
    expect(r.code).toBe(0);
  });

  it('PASSES when the bad shape appears only in a SQL comment (ROLLBACK blocks)', () => {
    const commented = BAD.split('\n').map((l) => `-- ${l}`).join('\n');
    const r = runLint({ 'supabase/migrations/0500_rollback_prose.sql': commented });
    expect(r.code).toBe(0);
  });

  it('grandfathers migrations below the enforced prefix', () => {
    const r = runLint({ 'supabase/migrations/0100_historical.sql': BAD });
    expect(r.code).toBe(0);
  });

  it('grandfathers the immutable Path C baseline', () => {
    const r = runLint({ 'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql': BAD });
    expect(r.code).toBe(0);
  });

  it('honours the override label', () => {
    const r = runLint(
      { 'supabase/migrations/0500_bad.sql': BAD },
      { PR_LABELS: 'null-identity-guard-intentional' },
    );
    expect(r.code).toBe(0);
  });

  it('does NOT flag `= auth.uid()` RLS quals, which fail closed on NULL', () => {
    const rlsQual = `BEGIN;
CREATE POLICY "p" ON "public"."t" FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY "q" ON "public"."t" FOR SELECT USING (org_id = get_user_org_id());
COMMIT;
`;
    const r = runLint({ 'supabase/migrations/0500_rls.sql': rlsQual });
    expect(r.code).toBe(0);
  });

  it('does NOT flag the NULL-safe EXISTS admin-check idiom', () => {
    const existsIdiom = `BEGIN;
CREATE OR REPLACE FUNCTION "public"."f"() RETURNS integer LANGUAGE "plpgsql" AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = (SELECT auth.uid()) AND is_platform_admin = true) THEN
    RAISE EXCEPTION 'nope' USING ERRCODE = '42501';
  END IF;
  RETURN 0;
END;
$$;
COMMIT;
`;
    const r = runLint({ 'supabase/migrations/0500_exists.sql': existsIdiom });
    expect(r.code).toBe(0);
  });
});

describe('F-5c: the real repo passes the new lint', () => {
  it('no executable NULL-collapsing guard in any enforced migration', () => {
    let code = 0;
    try {
      execFileSync('npx', ['tsx', LINT_PATH], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PR_LABELS: '' },
      });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (3) LIVE RLS INTEGRATION — opt-in only.
// Requires 0392 applied to a THROWAWAY/ISOLATED DB and RUN_LIVE_RLS=1.
// NEVER against prod.
// ---------------------------------------------------------------------------
const RUN_LIVE = process.env.RUN_LIVE_RLS === '1';

describe.skipIf(!RUN_LIVE)(
  'F-5c: live behaviour (throwaway/isolated DB, 0392 applied)',
  () => {
    const helpers = () => import('./rls/helpers');
    type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

    /**
     * NB: PostgREST returns HTTP 401 for the `anon` role and 403 for
     * `authenticated` on the same 42501 — assert on SQLSTATE, not status.
     */
    function expectDenied(res: RpcResult) {
      expect(res.error).not.toBeNull();
      expect(
        res.error?.code === '42501' || /unauthorized/i.test(res.error?.message ?? ''),
      ).toBe(true);
      expect(res.data ?? null).toBeNull();
    }

    it('authenticated user CAN still read their OWN count (the live hook path)', async () => {
      const { withIndividualUser, DEMO_CREDENTIALS } = await helpers();
      const user = await withIndividualUser();
      const res = (await user.rpc(FN as never, {
        p_user_id: DEMO_CREDENTIALS.userId,
      } as never)) as RpcResult;
      expect(res.error).toBeNull();
      expect(typeof res.data).toBe('number');
    });

    it('authenticated user CANNOT read another user\'s count', async () => {
      const { withIndividualUser, DEMO_CREDENTIALS } = await helpers();
      const user = await withIndividualUser();
      expectDenied(
        (await user.rpc(FN as never, { p_user_id: DEMO_CREDENTIALS.adminId } as never)) as RpcResult,
      );
    });

    it('authenticated user CANNOT pass NULL', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      expectDenied((await user.rpc(FN as never, { p_user_id: null } as never)) as RpcResult);
    });

    it('anon is denied (no EXECUTE grant today; denied by the guard even if granted)', async () => {
      const { createAnonClient } = await helpers();
      expectDenied(
        (await createAnonClient().rpc(FN as never, { p_user_id: null } as never)) as RpcResult,
      );
    });

    it('service_role CAN now read any user\'s count — the bypass this migration adds', async () => {
      // Before 0392 this raised 42501: the worker's auth id is NULL, so
      // `<uuid> IS DISTINCT FROM NULL` was TRUE and service_role was rejected.
      const { createServiceClient, DEMO_CREDENTIALS } = await helpers();
      const res = (await createServiceClient().rpc(FN as never, {
        p_user_id: DEMO_CREDENTIALS.adminId,
      } as never)) as RpcResult;
      expect(res.error).toBeNull();
      expect(typeof res.data).toBe('number');
    });
  },
);
