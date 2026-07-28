/**
 * SCRUM-2905 / SCRUM-2918 — Security-advisor triage: revoke anon/authenticated
 * EXECUTE on internal SECURITY DEFINER billing mutators (migration 0364).
 *
 * THE HOLE THIS CLOSES:
 *   `public.deduct_org_credit(uuid, integer, text, uuid)` and
 *   `public.deduct_credit(uuid, integer, text, uuid)` are SECURITY DEFINER
 *   functions that DEBIT credit balances and write ledger rows. They run with
 *   the owner's rights (RLS bypassed) and take an arbitrary `p_org_id` /
 *   `p_user_id` with NO auth.uid() gate. Migrations 0326/0341 granted them
 *   EXECUTE to `anon` and `authenticated`, so any signed-in (or anonymous)
 *   PostgREST caller could drain ANY org's / user's credits by passing that id.
 *   0364 revokes anon/authenticated and keeps service_role (the worker).
 *
 * TWO LAYERS OF ASSERTION:
 *   (1) CONTENT-GUARD (always runs, no DB): read migration 0364 directly and
 *       assert the exact REVOKE/GRANT statements — the same no-live-DB
 *       convention as scrum-2485 / scrum-2248. This is what Monday's reviewer
 *       reads.
 *   (2) LIVE RLS INTEGRATION (opt-in via RUN_LIVE_RLS=1 against a throwaway DB):
 *       uses the RLS helpers to actually invoke the RPCs and assert anon +
 *       authenticated get permission-denied on the deduct functions while the
 *       deliberately-public verification RPC stays callable. Gated OFF by
 *       default so this suite never needs live DB creds in CI. 0364 is now
 *       PROD-APPLIED (2026-07-27 ~13:26-13:32Z, part of the 0359-0364 batch,
 *       exempted via #1712 — see supabase/migrations/agents.md); this suite
 *       was verified against the isolated T3 soak rig pre-apply.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0364_scrum2905_security_advisor_revokes.sql',
);

let migrationCache: string | null = null;
function migration(): string {
  if (migrationCache === null) {
    migrationCache = fs.readFileSync(MIGRATION_PATH, 'utf8');
  }
  return migrationCache;
}

/** Strip SQL comment lines so grants in the header/ROLLBACK prose don't match. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

// The two SECURITY DEFINER billing mutators that MUST NOT be anon/authenticated-callable.
const REVOKED_FUNCTIONS = [
  'public.deduct_org_credit(uuid, integer, text, uuid)',
  'public.deduct_credit(uuid, integer, text, uuid)',
];

describe('SCRUM-2905: migration 0364 revokes anon/authenticated on credit mutators', () => {
  it('migration 0364 exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('is transactional and reloads the PostgREST schema cache', () => {
    const sql = executableSql(migration());
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });

  for (const fn of REVOKED_FUNCTIONS) {
    describe(fn, () => {
      const sql = executableSql(migration());

      it('REVOKEs from PUBLIC, anon, authenticated', () => {
        expect(sql).toContain(
          `REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated;`,
        );
      });

      it('retains EXECUTE for service_role (the worker is the sole caller)', () => {
        expect(sql).toContain(
          `GRANT EXECUTE ON FUNCTION ${fn} TO service_role;`,
        );
      });

      it('does NOT re-grant EXECUTE to anon or authenticated', () => {
        // No executable GRANT ... TO ... {anon|authenticated} for this fn.
        const grantLines = sql
          .split('\n')
          .filter((l) => l.includes('GRANT EXECUTE ON FUNCTION') && l.includes(fn));
        for (const line of grantLines) {
          expect(line).not.toMatch(/\banon\b/);
          expect(line).not.toMatch(/\bauthenticated\b/);
        }
      });
    });
  }

  it('carries a ROLLBACK comment block that restores the prior grants', () => {
    const sql = migration();
    expect(sql).toContain('-- ROLLBACK:');
    // Rollback must re-grant to anon, authenticated for both functions.
    for (const fn of REVOKED_FUNCTIONS) {
      expect(sql).toContain(
        `GRANT EXECUTE ON FUNCTION ${fn} TO anon, authenticated;`,
      );
    }
  });

  it('does NOT touch the deliberately-public RPCs (documents them as kept)', () => {
    const sql = executableSql(migration());
    // No executable REVOKE against the intended-public verification / browse RPCs.
    expect(sql).not.toMatch(/REVOKE[^\n]*get_public_anchor_by_fingerprint/);
    expect(sql).not.toMatch(/REVOKE[^\n]*get_public_records_page/);
    expect(sql).not.toMatch(/REVOKE[^\n]*suspend_suborg/);
    // And the prose explicitly records why they are kept.
    const full = migration();
    expect(full).toContain('get_public_anchor_by_fingerprint');
    expect(full).toContain('suspend_suborg');
  });

  it('documents the manual Auth-dashboard config items (leaked-password + MFA)', () => {
    const full = migration().toLowerCase();
    expect(full).toContain('leaked password protection');
    expect(full).toContain('mfa');
  });
});

// ---------------------------------------------------------------------------
// (2) LIVE RLS INTEGRATION — opt-in only. Requires 0364 applied to a THROWAWAY
// DB and RUN_LIVE_RLS=1 + the RLS helper env vars. Never runs in default CI
// (no live DB creds there); 0364 itself is PROD-APPLIED (see header note).
// ---------------------------------------------------------------------------
const RUN_LIVE = process.env.RUN_LIVE_RLS === '1';

describe.skipIf(!RUN_LIVE)(
  'SCRUM-2905: live RPC execute-grant behaviour (throwaway DB)',
  () => {
    // Lazy import so the helpers' required env vars are only demanded when the
    // live suite actually runs.
    const helpers = () => import('./rls/helpers');

    // A well-formed but harmless call: deducting against a random org/user id.
    // A permission error must fire at the EXECUTE gate BEFORE any body logic,
    // so the target ids never need to exist.
    const RANDOM_ID = '00000000-0000-0000-0000-0000000000ff';

    function isPermissionDenied(error: { code?: string; message?: string } | null): boolean {
      if (!error) return false;
      // Postgres insufficient_privilege is 42501; PostgREST surfaces it in code/message.
      return (
        error.code === '42501' ||
        /permission denied/i.test(error.message ?? '') ||
        /not.*allowed|no function|PGRST202/i.test(error.message ?? '')
      );
    }

    it('anon CANNOT execute deduct_org_credit', async () => {
      const { createAnonClient } = await helpers();
      const anon = createAnonClient();
      const { error } = await anon.rpc('deduct_org_credit' as never, {
        p_org_id: RANDOM_ID,
        p_amount: 1,
        p_reason: 'security-test',
        p_reference_id: RANDOM_ID,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('authenticated CANNOT execute deduct_org_credit', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const { error } = await user.rpc('deduct_org_credit' as never, {
        p_org_id: RANDOM_ID,
        p_amount: 1,
        p_reason: 'security-test',
        p_reference_id: RANDOM_ID,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('authenticated CANNOT execute deduct_credit', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const { error } = await user.rpc('deduct_credit' as never, {
        p_user_id: RANDOM_ID,
        p_amount: 1,
        p_reason: 'security-test',
        p_reference_id: RANDOM_ID,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('service_role CAN still execute deduct_org_credit (no permission error)', async () => {
      const { createServiceClient } = await helpers();
      const svc = createServiceClient();
      const { error } = await svc.rpc('deduct_org_credit' as never, {
        p_org_id: RANDOM_ID,
        p_amount: 1,
        p_reason: 'security-test',
        p_reference_id: RANDOM_ID,
      } as never);
      // Worker path is allowed to EXECUTE; a domain error like
      // 'org_not_initialized' is fine — a PERMISSION error is not.
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('anon CAN still execute the deliberately-public verification RPC', async () => {
      const { createAnonClient } = await helpers();
      const anon = createAnonClient();
      const { error } = await anon.rpc('get_public_anchor_by_fingerprint' as never, {
        p_fingerprint: 'deadbeef',
      } as never);
      // Must NOT be a permission denial — this RPC is intentionally anon-public.
      expect(isPermissionDenied(error)).toBe(false);
    });
  },
);
