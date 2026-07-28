/**
 * SEC-RECON follow-up to #1652 / 0364 — revoke anon/authenticated EXECUTE on
 * the SECURITY DEFINER RPC family 0364 missed, and drop the vulnerable legacy
 * invite_member(uuid,text,text,uuid) overload (migration 0377).
 *
 * THE HOLE THIS CLOSES:
 *   Six SECURITY DEFINER functions — submit_batch_anchors, batch_insert_anchors,
 *   allocate_monthly_credits, deduct_ai_credits, deduct_unified_credits,
 *   roll_over_monthly_allocation — run with the owner's rights (RLS bypassed),
 *   take arbitrary org_id/user_id/anchor_id/chain-receipt arguments with NO
 *   auth.uid() gate, and were granted EXECUTE to anon + authenticated. Any
 *   unauthenticated PostgREST caller could forge a Bitcoin chain receipt
 *   (submit_batch_anchors), insert anchors under any user/org
 *   (batch_insert_anchors), trigger a platform-wide credit reallocation
 *   (allocate_monthly_credits), or drain/roll-over credits for any org/user
 *   (deduct_ai_credits / deduct_unified_credits / roll_over_monthly_allocation).
 *   0377 revokes anon/authenticated and keeps service_role (the worker).
 *
 *   Separately, invite_member had a legacy 4-arg overload
 *   (inviter_user_id uuid, invitee_email text, invitee_role text,
 *   target_org_id uuid) that never compared inviter_user_id to auth.uid(),
 *   accepted invitee_role as unchecked text, and lacked the SEC-RECON-8
 *   "cannot invite as ORG_ADMIN" guard the safe 3-arg overload
 *   (invitee_email text, invitee_role user_role, target_org_id uuid) has.
 *   0377 DROPs the 4-arg overload; the safe overload is untouched.
 *
 * TWO LAYERS OF ASSERTION (same convention as scrum-2905-security-advisor-
 * revokes.test.ts / scrum-2485 / scrum-2248):
 *   (1) CONTENT-GUARD (always runs, no DB): read migration 0377 directly and
 *       assert the exact REVOKE/GRANT/DROP statements.
 *   (2) LIVE RLS INTEGRATION (opt-in via RUN_LIVE_RLS=1 against a throwaway
 *       DB with 0377 applied): actually invoke the RPCs and assert anon +
 *       authenticated get permission-denied (or "no function" once the
 *       invite_member overload is dropped) while service_role and the safe
 *       invite_member overload keep working. Gated OFF by default — never
 *       needs live DB creds in CI. NOT run against prod; 0377 is NOT applied
 *       to prod in this PR.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0377_sec_recon_revoke_unguarded_rpc_family.sql',
);

let migrationCache: string | null = null;
function migration(): string {
  if (migrationCache === null) {
    migrationCache = fs.readFileSync(MIGRATION_PATH, 'utf8');
  }
  return migrationCache;
}

/** Strip SQL comment lines so grants/drops in the header/ROLLBACK prose don't match. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

// The six SECURITY DEFINER mutators that MUST NOT be anon/authenticated-callable.
const REVOKED_FUNCTIONS = [
  'public.submit_batch_anchors(uuid[], text, bigint, timestamp with time zone, text, text)',
  'public.batch_insert_anchors(jsonb)',
  'public.allocate_monthly_credits()',
  'public.deduct_ai_credits(uuid, uuid, integer)',
  'public.deduct_unified_credits(uuid, uuid, integer)',
  'public.roll_over_monthly_allocation(uuid)',
];

const DROPPED_INVITE_MEMBER_OVERLOAD = 'public.invite_member(uuid, text, text, uuid)';
const SAFE_INVITE_MEMBER_OVERLOAD = 'public.invite_member(text, user_role, uuid)';

describe('SEC-RECON: migration 0377 exists and is transactional', () => {
  it('migration 0377 exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('is transactional and reloads the PostgREST schema cache', () => {
    const sql = executableSql(migration());
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });
});

describe.each(REVOKED_FUNCTIONS)('%s', (fn) => {
  it('REVOKEs from PUBLIC, anon, authenticated', () => {
    const sql = executableSql(migration());
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated;`);
  });

  it('retains EXECUTE for service_role (the worker is the sole caller)', () => {
    const sql = executableSql(migration());
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role;`);
  });

  it('does NOT re-grant EXECUTE to anon or authenticated', () => {
    const sql = executableSql(migration());
    const grantLines = sql
      .split('\n')
      .filter((l) => l.includes('GRANT EXECUTE ON FUNCTION') && l.includes(fn));
    for (const line of grantLines) {
      expect(line).not.toMatch(/\banon\b/);
      expect(line).not.toMatch(/\bauthenticated\b/);
    }
  });
});

describe('SEC-RECON: legacy invite_member(uuid,text,text,uuid) overload is dropped', () => {
  it('DROPs the vulnerable 4-arg overload', () => {
    const sql = executableSql(migration());
    expect(sql).toContain(`DROP FUNCTION IF EXISTS ${DROPPED_INVITE_MEMBER_OVERLOAD};`);
  });

  it(`does NOT touch the safe overload (${SAFE_INVITE_MEMBER_OVERLOAD})`, () => {
    const sql = executableSql(migration());
    expect(sql).not.toMatch(/REVOKE[^\n]*invite_member\(text,\s*user_role,\s*uuid\)/);
    expect(sql).not.toMatch(/DROP FUNCTION[^\n]*invite_member\(text,\s*user_role,\s*uuid\)/);
  });

  it('documents the confirmed single call site (useInviteMember.ts, named 3-arg params)', () => {
    const full = migration();
    expect(full).toContain('src/hooks/useInviteMember.ts:72');
    expect(full).toContain('invitee_email');
    expect(full).toContain('invitee_role');
    expect(full).toContain('target_org_id');
  });
});

describe('SEC-RECON: additional unguarded functions found in the sweep are documented, not silently fixed', () => {
  it('records the CRITICAL follow-up findings in the migration header', () => {
    const full = migration();
    expect(full).toContain('finalize_public_record_anchor_batch');
    expect(full).toContain('drain_submitted_to_secured_for_tx');
    expect(full).toContain('bulk_promote_confirmed');
  });

  it('does NOT touch any of the follow-up findings in this migration (scope stays bounded)', () => {
    const sql = executableSql(migration());
    for (const followUp of [
      'finalize_public_record_anchor_batch',
      'drain_submitted_to_secured_for_tx',
      'bulk_promote_confirmed',
      'auto_associate_profile_to_org_by_email_domain',
      'link_recipient_on_signup',
      'archive_old_audit_events',
      'clear_payment_grace',
      'start_payment_grace',
      'increment_org_usage',
      'search_credential_embeddings',
    ]) {
      expect(sql).not.toContain(followUp);
    }
  });
});

describe('SEC-RECON: does NOT touch the correctly-guarded reference sibling', () => {
  it('leaves bulk_create_anchors(jsonb) untouched (it self-authorizes via auth.uid())', () => {
    const sql = executableSql(migration());
    expect(sql).not.toMatch(/REVOKE[^\n]*bulk_create_anchors/);
    expect(sql).not.toMatch(/DROP FUNCTION[^\n]*bulk_create_anchors/);
  });
});

it('carries a ROLLBACK comment block that restores the prior grants + the dropped overload', () => {
  const sql = migration();
  expect(sql).toContain('-- ROLLBACK:');
  for (const fn of REVOKED_FUNCTIONS) {
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO anon, authenticated;`);
  }
  expect(sql).toContain('CREATE OR REPLACE FUNCTION public.invite_member(inviter_user_id uuid');
  expect(sql).toContain(
    `GRANT EXECUTE ON FUNCTION ${DROPPED_INVITE_MEMBER_OVERLOAD} TO anon, authenticated, service_role;`,
  );
});

// ---------------------------------------------------------------------------
// (2) LIVE RLS INTEGRATION — opt-in only. Requires 0377 applied to a THROWAWAY
// DB and RUN_LIVE_RLS=1 + the RLS helper env vars. Never runs in default CI
// (no live DB creds there). NOT run against prod — 0377 is NOT applied to
// prod in this PR.
// ---------------------------------------------------------------------------
const RUN_LIVE = process.env.RUN_LIVE_RLS === '1';

describe.skipIf(!RUN_LIVE)(
  'SEC-RECON: live RPC execute-grant behaviour (throwaway DB, 0377 applied)',
  () => {
    const helpers = () => import('./rls/helpers');

    const RANDOM_ID = '00000000-0000-0000-0000-0000000000ff';

    function isPermissionDenied(error: { code?: string; message?: string } | null): boolean {
      if (!error) return false;
      // Postgres insufficient_privilege is 42501; PostgREST surfaces it in code/message.
      // A dropped overload with no remaining name+arity match surfaces PGRST202
      // ("Could not find the function") — also a correct-deny outcome here.
      return (
        error.code === '42501' ||
        /permission denied/i.test(error.message ?? '') ||
        /not.*allowed|no function|PGRST202/i.test(error.message ?? '')
      );
    }

    it('anon CANNOT execute submit_batch_anchors', async () => {
      const { createAnonClient } = await helpers();
      const anon = createAnonClient();
      const { error } = await anon.rpc('submit_batch_anchors' as never, {
        p_anchor_ids: [RANDOM_ID],
        p_tx_id: 'forged-tx',
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('authenticated CANNOT execute submit_batch_anchors', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const { error } = await user.rpc('submit_batch_anchors' as never, {
        p_anchor_ids: [RANDOM_ID],
        p_tx_id: 'forged-tx',
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('service_role CAN still execute submit_batch_anchors (no permission error)', async () => {
      const { createServiceClient } = await helpers();
      const svc = createServiceClient();
      const { error } = await svc.rpc('submit_batch_anchors' as never, {
        p_anchor_ids: [RANDOM_ID],
        p_tx_id: 'legit-tx',
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('anon CANNOT execute batch_insert_anchors', async () => {
      const { createAnonClient } = await helpers();
      const anon = createAnonClient();
      const { error } = await anon.rpc('batch_insert_anchors' as never, {
        p_anchors: [],
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('service_role CAN still execute batch_insert_anchors', async () => {
      const { createServiceClient } = await helpers();
      const svc = createServiceClient();
      const { error } = await svc.rpc('batch_insert_anchors' as never, {
        p_anchors: [],
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('anon CANNOT execute allocate_monthly_credits', async () => {
      const { createAnonClient } = await helpers();
      const anon = createAnonClient();
      const { error } = await anon.rpc('allocate_monthly_credits' as never, {} as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('service_role CAN still execute allocate_monthly_credits', async () => {
      const { createServiceClient } = await helpers();
      const svc = createServiceClient();
      const { error } = await svc.rpc('allocate_monthly_credits' as never, {} as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('authenticated CANNOT execute deduct_ai_credits', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const { error } = await user.rpc('deduct_ai_credits' as never, {
        p_org_id: RANDOM_ID,
        p_user_id: RANDOM_ID,
        p_amount: 1,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('service_role CAN still execute deduct_ai_credits', async () => {
      const { createServiceClient } = await helpers();
      const svc = createServiceClient();
      const { error } = await svc.rpc('deduct_ai_credits' as never, {
        p_org_id: RANDOM_ID,
        p_user_id: RANDOM_ID,
        p_amount: 1,
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('authenticated CANNOT execute deduct_unified_credits', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const { error } = await user.rpc('deduct_unified_credits' as never, {
        p_org_id: RANDOM_ID,
        p_user_id: RANDOM_ID,
        p_amount: 1,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('service_role CAN still execute deduct_unified_credits', async () => {
      const { createServiceClient } = await helpers();
      const svc = createServiceClient();
      const { error } = await svc.rpc('deduct_unified_credits' as never, {
        p_org_id: RANDOM_ID,
        p_user_id: RANDOM_ID,
        p_amount: 1,
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('authenticated CANNOT execute roll_over_monthly_allocation', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const { error } = await user.rpc('roll_over_monthly_allocation' as never, {
        p_org_id: RANDOM_ID,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('service_role CAN still execute roll_over_monthly_allocation', async () => {
      const { createServiceClient } = await helpers();
      const svc = createServiceClient();
      const { error } = await svc.rpc('roll_over_monthly_allocation' as never, {
        p_org_id: RANDOM_ID,
      } as never);
      expect(isPermissionDenied(error)).toBe(false);
    });

    it('anon/authenticated calling the dropped invite_member 4-arg shape now fails (no matching function)', async () => {
      const { createAnonClient } = await helpers();
      const anon = createAnonClient();
      const { error } = await anon.rpc('invite_member' as never, {
        inviter_user_id: RANDOM_ID,
        invitee_email: 'attacker@example.com',
        invitee_role: 'ORG_ADMIN',
        target_org_id: RANDOM_ID,
      } as never);
      expect(isPermissionDenied(error)).toBe(true);
    });

    it('authenticated CAN still call the safe 3-arg invite_member overload (no permission/shape error)', async () => {
      const { withIndividualUser } = await helpers();
      const user = await withIndividualUser();
      const { error } = await user.rpc('invite_member' as never, {
        invitee_email: 'someone@example.com',
        invitee_role: 'ORG_MEMBER',
        target_org_id: RANDOM_ID,
      } as never);
      // A domain error (e.g. 'insufficient_privilege' raised BY THE FUNCTION
      // BODY because this test user isn't an ORG_ADMIN of RANDOM_ID) is fine —
      // it proves the function was found and executed. A grant-level
      // permission denial or "no function found" is not.
      expect(isPermissionDenied(error)).toBe(false);
    });
  },
);
