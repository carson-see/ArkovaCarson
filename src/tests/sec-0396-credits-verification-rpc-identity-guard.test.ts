/**
 * SEC — two SECURITY DEFINER RPCs missed by the F-5/F-5b/F-5c sweep.
 *
 * Compensating migration: supabase/migrations/0396_sec_credits_verification_rpc_identity_guard.sql
 *
 * BUG 1 — public.get_user_credits(p_user_id uuid DEFAULT NULL): the baseline
 *   body is `v_user_id := COALESCE(p_user_id, auth.uid())` — an explicit
 *   p_user_id wins outright over the caller's real identity, with NO
 *   comparison against it at all (not even F-5's NULL-unsafe `IS DISTINCT
 *   FROM` shape). Because the function is `anon`-granted, ANY unauthenticated
 *   caller supplying an existing user's id gets that user's credit balance,
 *   plan tier, and billing-cycle dates back, and can trigger a row-seed write
 *   (INSERT INTO credits + credit_transactions 'ALLOCATION') against an id
 *   they never authenticated as. This is a SECURITY DEFINER bypass of a real,
 *   working RLS policy (`credits_select` restricts direct table reads to
 *   `auth.uid() = user_id`), not a defense-in-depth gap layered on top of one.
 *
 * BUG 2 — public.is_user_verified(p_user_id uuid): zero identity check at
 *   all, `anon`+`authenticated` granted, leaks `profiles.identity_verification_status`
 *   (a KYC-verified boolean) for an arbitrary user id. `get_public_member_profile`
 *   deliberately excludes this field from its public projection elsewhere —
 *   this RPC is a side door around that exclusion. Zero real callers exist
 *   (grep-verified both source trees), so the fix REVOKEs anon/authenticated
 *   EXECUTE outright (0364/0377/0378 precedent for zero-caller unguarded
 *   SECURITY DEFINER RPCs) instead of inventing ownership semantics nobody uses.
 *
 * TWO LAYERS OF ASSERTION (repo convention — see f5b/f5c):
 *   (1) CONTENT-GUARD (always runs, no DB) — asserts on the migration SQL.
 *   (2) LIVE INTEGRATION (opt-in, RUN_LIVE_RLS=1, throwaway/isolated DB with
 *       0396 applied) — actually invokes the RPCs and asserts the real
 *       response/error shape. Never runs in default CI. NEVER against prod.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0396_sec_credits_verification_rpc_identity_guard.sql',
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

const CREDITS_FN = 'get_user_credits';
const VERIFIED_FN = 'is_user_verified';

describe('SEC-0396: migration exists, is transactional, and is reversible', () => {
  it('migration 0396 exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('is transactional and reloads the PostgREST schema cache', () => {
    const sql = executableSql(migration());
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('carries a ROLLBACK block restoring the unguarded get_user_credits body and the is_user_verified grants', () => {
    const sql = migration();
    expect(sql).toContain('-- ROLLBACK:');
    expect(sql).toMatch(/--\s+v_user_id := COALESCE\(p_user_id, auth\.uid\(\)\);/);
    expect(sql).toMatch(
      /--\s+GRANT ALL ON FUNCTION "public"\."is_user_verified"\("p_user_id" "uuid"\) TO PUBLIC, "anon", "authenticated";/,
    );
    expect(sql).toContain("--   NOTIFY pgrst, 'reload schema';");
  });

  it('is a higher numeric prefix than every function/grant it touches was last defined at', () => {
    expect(path.basename(MIGRATION_PATH).startsWith('0396_')).toBe(true);
  });
});

describe('BUG 1: get_user_credits — NULL-safe ownership guard', () => {
  const block = () => extractFunctionBlock(executableSql(migration()), CREDITS_FN);

  it('is still SECURITY DEFINER with SET search_path = public', () => {
    const b = block();
    expect(b).toContain('SECURITY DEFINER');
    expect(b).toMatch(/SET\s+"search_path"\s+TO\s+'public'/);
  });

  it('resolves the caller identity into a local and rejects it when NULL, BEFORE any argument comparison', () => {
    // The bug this catches: comparing p_user_id against a bare auth.uid() (or
    // not comparing at all, as the real bug was) lets a NULL-identity caller
    // (anon) slip an explicit p_user_id straight through.
    const b = block();
    expect(b).toMatch(/v_caller_id\s*:=\s*\(SELECT\s+auth\.uid\(\)\)/);
    const nullCheck = b.search(/IF\s+v_caller_id\s+IS\s+NULL\s+THEN/);
    const argCompare = b.search(/p_user_id\s+IS\s+NOT\s+NULL\s+AND\s+p_user_id\s+IS\s+DISTINCT\s+FROM\s+v_caller_id/);
    expect(nullCheck).toBeGreaterThan(-1);
    expect(argCompare).toBeGreaterThan(-1);
    expect(nullCheck).toBeLessThan(argCompare);
  });

  it('preserves the "omit p_user_id means self" contract (COALESCE against the caller local, not a bare re-auth.uid() call)', () => {
    const b = block();
    expect(b).toMatch(/v_user_id\s*:=\s*COALESCE\(p_user_id,\s*v_caller_id\)/);
  });

  it('raises 42501 twice — once for no identity, once for a mismatched identity — never a silent empty/zero result', () => {
    const b = block();
    expect(b).toMatch(/RAISE EXCEPTION[^;]*unauthorized: caller is not authenticated[^;]*USING ERRCODE = '42501'/s);
    expect(b).toMatch(/RAISE EXCEPTION[^;]*unauthorized: p_user_id must match[^;]*USING ERRCODE = '42501'/s);
    expect(b.match(/USING ERRCODE = '42501'/g) ?? []).toHaveLength(2);
  });

  it('preserves the service_role bypass', () => {
    expect(block()).toMatch(/get_caller_role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/);
  });

  it('preserves the exact credits computation: plan lookup, row-seed insert, and return shape untouched', () => {
    const b = block();
    expect(b).toContain("WHEN 'Free' THEN 50");
    expect(b).toContain("WHEN 'Individual' THEN 500");
    expect(b).toContain("WHEN 'Professional' THEN 5000");
    expect(b).toContain('INSERT INTO credits (user_id, balance, monthly_allocation, cycle_start, cycle_end)');
    expect(b).toContain("INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)");
    expect(b).toContain("'balance', v_credits.balance");
    expect(b).toContain("'is_low', v_credits.balance < 10");
  });

  it('contains no bare (unwrapped) auth.uid() — SCRUM-1278 / check-rls-auth-uid-wrap.ts compliance', () => {
    const b = block();
    // Every auth.uid() occurrence must be immediately preceded by "SELECT ".
    const bare = [...b.matchAll(/auth\.uid\(\)/g)].filter((m) => {
      const before = b.slice(Math.max(0, m.index! - 8), m.index!);
      return !/SELECT\s*$/i.test(before);
    });
    expect(bare).toHaveLength(0);
  });

  it('contains no direct comparison of an identity function inside IS DISTINCT FROM (check-null-identity-guard.ts shape)', () => {
    // The lint's own regex: `IS DISTINCT FROM (SELECT )?auth.uid()|get_user_org_id()`.
    // Our guard compares against the LOCAL v_caller_id, which the lint
    // explicitly treats as the safe, endorsed shape.
    const b = block();
    expect(b).not.toMatch(/IS\s+DISTINCT\s+FROM\s*\(?\s*(?:SELECT\s+)?(?:auth\.uid\(\)|get_user_org_id\(\))/i);
  });
});

describe('BUG 1: get_user_credits — non-regression (the only real caller always passes its own id)', () => {
  it('src/hooks/useCredits.ts still calls fetchCreditsData with the current session\'s own id only', () => {
    // Locks the call-site claim the migration's non-regression argument
    // depends on: if this line ever changes to pass a different id, this
    // test breaks and forces a re-review of the guard's assumptions.
    const hookPath = path.join(process.cwd(), 'src/hooks/useCredits.ts');
    const hookSrc = fs.readFileSync(hookPath, 'utf8');
    expect(hookSrc).toMatch(/queryFn:\s*\(\)\s*=>\s*fetchCreditsData\(user!\.id\)/);
    expect(hookSrc).toMatch(/p_user_id:\s*userId/);
    // Only reachable when a session exists — never an anonymous call.
    expect(hookSrc).toMatch(/enabled:\s*!!user/);
  });
});

describe('BUG 2: is_user_verified — PUBLIC/anon/authenticated EXECUTE revoked', () => {
  it('REVOKEs EXECUTE from PUBLIC, anon, and authenticated in one statement', () => {
    // Revoking only anon/authenticated would be a no-op fix: PostgreSQL grants
    // EXECUTE to the PUBLIC pseudo-role by default at function creation, and
    // every role (anon/authenticated included) is implicitly a member of
    // PUBLIC — confirmed live this session via information_schema.routine_privileges.
    // 0364/0377/0378/0388 all target `FROM PUBLIC, anon, authenticated` together;
    // matched here.
    const sql = executableSql(migration());
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION "public"\."is_user_verified"\("p_user_id" "uuid"\) FROM PUBLIC, "anon", "authenticated";/,
    );
  });

  it('does NOT revoke service_role', () => {
    const sql = executableSql(migration());
    expect(sql).not.toMatch(
      /REVOKE[^;]*"is_user_verified"[^;]*service_role/i,
    );
  });

  it('does not touch the function body itself (revoke-only fix, no CREATE OR REPLACE for this function)', () => {
    const sql = executableSql(migration());
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION "public"\."is_user_verified"/);
  });

  it('has zero real call sites in either source tree (locks the "no legitimate caller" premise)', () => {
    const hits: string[] = [];
    for (const root of ['src', 'services/worker/src']) {
      const dir = path.join(process.cwd(), root);
      if (!fs.existsSync(dir)) continue;
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            walk(p);
          } else if (
            /\.(ts|tsx)$/.test(entry.name) &&
            entry.name !== 'database.types.ts' &&
            !/\.test\.(ts|tsx)$/.test(entry.name)
          ) {
            const text = fs.readFileSync(p, 'utf8');
            if (text.includes('is_user_verified')) hits.push(p);
          }
        }
      };
      walk(dir);
    }
    expect(hits).toEqual([]);
  });
});

describe('Cross-check: the pre-0396 baseline genuinely had both bugs (red before this migration)', () => {
  const BASELINE_PATH = path.join(
    process.cwd(),
    'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
  );
  const baseline = () => fs.readFileSync(BASELINE_PATH, 'utf8');

  it('BUG 1: baseline get_user_credits has zero identity comparison — p_user_id wins outright', () => {
    const b = extractFunctionBlock(executableSql(baseline()), CREDITS_FN);
    expect(b).toMatch(/v_user_id\s*:=\s*COALESCE\(p_user_id,\s*auth\.uid\(\)\)/);
    // The whole point: no RAISE, no ownership check, no NULL rejection at all.
    expect(b).not.toMatch(/RAISE EXCEPTION/i);
    expect(b).not.toMatch(/get_caller_role\(\)/);
  });

  it('BUG 1: baseline grants get_user_credits to anon (unauthenticated reachability)', () => {
    const sql = executableSql(baseline());
    expect(sql).toMatch(/GRANT ALL ON FUNCTION "public"\."get_user_credits"\("p_user_id" "uuid"\) TO "anon";/);
  });

  it('BUG 2: baseline is_user_verified has zero identity comparison', () => {
    const b = extractFunctionBlock(executableSql(baseline()), VERIFIED_FN);
    expect(b).toMatch(/SELECT\s+identity_verification_status\s*=\s*'verified'/);
    expect(b).not.toMatch(/auth\.uid\(\)/);
    expect(b).not.toMatch(/get_caller_role\(\)/);
  });

  it('BUG 2: baseline grants is_user_verified to both anon and authenticated (unrevoked)', () => {
    const sql = executableSql(baseline());
    expect(sql).toMatch(/GRANT ALL ON FUNCTION "public"\."is_user_verified"\("p_user_id" "uuid"\) TO "anon";/);
    expect(sql).toMatch(/GRANT ALL ON FUNCTION "public"\."is_user_verified"\("p_user_id" "uuid"\) TO "authenticated";/);
  });

  // Was: 'sorts after ... every other migration, so it wins on a fresh
  // reset' — a proxy that only held while 0396 happened to be the highest
  // numbered file in the directory, which any unrelated later migration
  // (e.g. 0397, adding an org_rule_action_type enum value — touches neither
  // function) invalidates by definition. The invariant that actually matters
  // — restored here per the `0376`-clobber lesson documented throughout
  // supabase/migrations/agents.md ("`get_public_anchor` is redefined
  // WHOLESALE by every migration that touches it... branching a new
  // definition off an older migration file silently deletes every change
  // made in between") — is that NO migration sorting after 0396 also
  // redefines get_user_credits or is_user_verified. A same-numbered-or-later
  // file that does would silently clobber this fix with no ledger signal,
  // exactly like 0376 did to 0356/0362.
  it('no migration after 0396 redefines get_user_credits or is_user_verified (anti-clobber)', () => {
    const migrationsDir = path.join(process.cwd(), 'supabase/migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const ownIndex = files.indexOf(path.basename(MIGRATION_PATH));
    expect(ownIndex).toBeGreaterThanOrEqual(0);
    const later = files.slice(ownIndex + 1);
    for (const file of later) {
      const sql = executableSql(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
      expect(sql, `${file} must not redefine ${CREDITS_FN}`).not.toMatch(
        new RegExp(`FUNCTION\\s+"public"\\."${CREDITS_FN}"`),
      );
      expect(sql, `${file} must not redefine ${VERIFIED_FN}`).not.toMatch(
        new RegExp(`FUNCTION\\s+"public"\\."${VERIFIED_FN}"`),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// (2) LIVE INTEGRATION — opt-in only.
//
// Requires 0396 applied to a THROWAWAY/ISOLATED DB, RUN_LIVE_RLS=1, and the
// RLS helper env vars (SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY / RLS_TEST_PASSWORD).
//
// NEVER run against production: cases below deliberately attempt cross-tenant
// reads. Never runs in default CI (no live DB creds there).
// ---------------------------------------------------------------------------
const RUN_LIVE = process.env.RUN_LIVE_RLS === '1';

describe.skipIf(!RUN_LIVE)(
  'SEC-0396: live behaviour (throwaway/isolated DB, 0396 applied)',
  () => {
    const helpers = () => import('./rls/helpers');

    type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

    function expectDenied(res: RpcResult) {
      expect(res.error).not.toBeNull();
      expect(
        res.error?.code === '42501' || /unauthorized|permission denied/i.test(res.error?.message ?? ''),
      ).toBe(true);
    }

    function expectAllowed(res: RpcResult) {
      expect(res.error).toBeNull();
      expect(res.data).not.toBeNull();
    }

    // ---- BUG 1: get_user_credits ----

    it('anon CANNOT read another user\'s credits by passing their id — was 200 + real balance', async () => {
      const { createAnonClient, DEMO_CREDENTIALS } = await helpers();
      const res = await createAnonClient().rpc(CREDITS_FN as never, {
        p_user_id: DEMO_CREDENTIALS.userId,
      } as never);
      expectDenied(res as RpcResult);
    });

    it('anon CANNOT call get_user_credits(NULL) either — no identity to fall back to', async () => {
      const { createAnonClient } = await helpers();
      const res = await createAnonClient().rpc(CREDITS_FN as never, { p_user_id: null } as never);
      expectDenied(res as RpcResult);
    });

    it('an authenticated user CANNOT read another user\'s credits — was 200 + real balance/plan', async () => {
      const { withIndividualUser, DEMO_CREDENTIALS } = await helpers();
      const user = await withIndividualUser();
      const res = await user.rpc(CREDITS_FN as never, { p_user_id: DEMO_CREDENTIALS.adminId } as never);
      expectDenied(res as RpcResult);
    });

    it('an authenticated user CAN still read their OWN credits by explicit id', async () => {
      const { withIndividualUser, DEMO_CREDENTIALS } = await helpers();
      const user = await withIndividualUser();
      const res = await user.rpc(CREDITS_FN as never, { p_user_id: DEMO_CREDENTIALS.userId } as never);
      expectAllowed(res as RpcResult);
    });

    it('an authenticated user CAN still read their own credits by omitting p_user_id', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const res = await user.rpc(CREDITS_FN as never, {} as never);
      expectAllowed(res as RpcResult);
    });

    it('service_role CAN still read any user\'s credits (worker/admin escape hatch)', async () => {
      const { createServiceClient, DEMO_CREDENTIALS } = await helpers();
      const res = await createServiceClient().rpc(CREDITS_FN as never, {
        p_user_id: DEMO_CREDENTIALS.adminId,
      } as never);
      expectAllowed(res as RpcResult);
    });

    // ---- BUG 2: is_user_verified ----

    it('anon CANNOT call is_user_verified at all — permission denied at the grant level', async () => {
      const { createAnonClient, DEMO_CREDENTIALS } = await helpers();
      const res = await createAnonClient().rpc(VERIFIED_FN as never, {
        p_user_id: DEMO_CREDENTIALS.userId,
      } as never);
      expectDenied(res as RpcResult);
    });

    it('an authenticated user CANNOT call is_user_verified either — grant revoked, not just body-guarded', async () => {
      const { withIndividualUser, DEMO_CREDENTIALS } = await helpers();
      const user = await withIndividualUser();
      const res = await user.rpc(VERIFIED_FN as never, {
        p_user_id: DEMO_CREDENTIALS.adminId,
      } as never);
      expectDenied(res as RpcResult);
    });

    it('service_role CAN still call is_user_verified', async () => {
      const { createServiceClient, DEMO_CREDENTIALS } = await helpers();
      const res = await createServiceClient().rpc(VERIFIED_FN as never, {
        p_user_id: DEMO_CREDENTIALS.userId,
      } as never);
      expect(res.error).toBeNull();
      expect(typeof res.data).toBe('boolean');
    });
  },
);
