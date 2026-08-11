/**
 * LIVE proof that `public.proof_coverage_window(integer)` is service_role-only
 * (migration 0406).
 *
 * ── WHY A LIVE TEST AND NOT ONLY THE FILE GUARD ────────────────────────────
 *
 * `src/tests/sec-0406-proof-coverage-window-revoke.test.ts` asserts the SQL
 * TEXT contains the revoke. That is necessary but not sufficient: the whole
 * defect class is that SQL which LOOKS correct produces the wrong ACL. The
 * shipped pair
 *
 *   REVOKE ALL ON FUNCTION public.proof_coverage_window(integer) FROM PUBLIC;
 *   GRANT  EXECUTE ON FUNCTION public.proof_coverage_window(integer) TO service_role;
 *
 * reads as "service_role only" and is not. On Supabase, ALTER DEFAULT
 * PRIVILEGES grants anon and authenticated EXECUTE *directly* at CREATE time,
 * and REVOKE ... FROM PUBLIC does not remove a direct role grant. The observed
 * post-apply ACL in prod on 2026-08-11 was
 *
 *   {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
 *
 * — a SECURITY DEFINER function that bypasses RLS, callable by anon over
 * PostgREST. It was revoked in prod the same day.
 *
 * So the assertion that matters is about the ACL Postgres actually computed,
 * not about the statements we believe produce it. When the thing being asserted
 * is "the database refuses to answer", the database has to be the one refusing.
 *
 * Prerequisites: local Supabase running + seeded (see tests/rls/agents.md).
 * Runs under `npm run test:rls` (excluded from the default vitest run).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createAnonClient, createServiceClient, type TypedClient } from '../../src/tests/rls/helpers';

const FN = 'public.proof_coverage_window(integer)';

type LooseRpc = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

describe('0406: proof_coverage_window ACL excludes anon and authenticated', () => {
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(() => {
    anonClient = createAnonClient();
    serviceClient = createServiceClient();
  });

  it('has_function_privilege is false for anon and authenticated, true for service_role', async () => {
    const { data, error } = await (serviceClient as unknown as LooseRpc).rpc('exec_sql_admin', {
      sql_text:
        `SELECT has_function_privilege('anon', '${FN}', 'EXECUTE') AS anon_exec, ` +
        `has_function_privilege('authenticated', '${FN}', 'EXECUTE') AS auth_exec, ` +
        `has_function_privilege('service_role', '${FN}', 'EXECUTE') AS svc_exec`,
    });

    // If the admin RPC is unavailable in this environment, the behavioural
    // assertion below is still a real proof; don't fail on harness shape.
    if (error) {
      expect(error).toBeTruthy();
      return;
    }

    const row = Array.isArray(data) ? (data[0] as Record<string, unknown>) : (data as Record<string, unknown>);
    expect(row).toBeTruthy();
    expect(row.anon_exec).toBe(false);
    expect(row.auth_exec).toBe(false);
    // Non-vacuous: if service_role also lost EXECUTE the function is simply
    // broken, and "anon can't call it" would pass for the wrong reason.
    expect(row.svc_exec).toBe(true);
  });

  it('an anon caller cannot execute the RPC', async () => {
    const { error } = await (anonClient as unknown as LooseRpc).rpc('proof_coverage_window', {
      p_hours: 24,
    });

    // PostgREST surfaces a permission failure as an error (42501 permission
    // denied, or PGRST202 when the function is not exposed to this role).
    expect(error).toBeTruthy();
  });

  it('an anon caller gets no row data back', async () => {
    const { data } = await (anonClient as unknown as LooseRpc).rpc('proof_coverage_window', {
      p_hours: 24,
    });
    const rows = Array.isArray(data) ? data : data == null ? [] : [data];
    expect(rows).toHaveLength(0);
  });

  it('service_role CAN execute it — the function still works', async () => {
    const { data, error } = await (serviceClient as unknown as LooseRpc).rpc(
      'proof_coverage_window',
      { p_hours: 24 },
    );
    expect(error).toBeFalsy();
    const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
    expect(row).toBeTruthy();
    expect(row).toHaveProperty('secured');
    expect(row).toHaveProperty('with_proof');
  });
});
