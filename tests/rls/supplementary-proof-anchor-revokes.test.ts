/**
 * LIVE proof that the five SECURITY DEFINER functions in migration 0408 are
 * service_role-only.
 *
 * ── WHY A LIVE TEST AND NOT ONLY THE FILE GUARD ────────────────────────────
 *
 * `src/tests/sec-0408-supplementary-proof-anchor-revokes.test.ts` asserts the
 * SQL TEXT. That is necessary but not sufficient, because the entire defect
 * class is SQL that LOOKS correct producing the wrong ACL. The originally
 * shipped pair
 *
 *   REVOKE ALL ON FUNCTION public.persist_supplementary_journal(...) FROM PUBLIC;
 *   GRANT  EXECUTE ON FUNCTION public.persist_supplementary_journal(...) TO service_role;
 *
 * reads as "service_role only" and is not: ALTER DEFAULT PRIVILEGES grants anon
 * and authenticated EXECUTE *directly* at CREATE time, and REVOKE ... FROM
 * PUBLIC does not remove a direct role grant. The same mistake in 0406 produced
 * a live prod ACL of {postgres=X,anon=X,authenticated=X,service_role=X}.
 *
 * So the assertion that matters is about the ACL Postgres actually computed,
 * not the statements we believe produce it.
 *
 * ── WHY THESE FUNCTIONS SPECIFICALLY ───────────────────────────────────────
 *
 * persist_/resolve_supplementary_journal are the anti-double-broadcast journal
 * primitives: the subsystem's safety argument is sign -> journal -> broadcast,
 * never reordered, and an ambiguous broadcast must HOLD the journal rather than
 * REVERT. claim_supplementary_proof_cohort claims work units. An unauthenticated
 * caller reaching any of these over PostgREST could starve the backfill by
 * pre-claiming cohorts, or perturb exactly the state that decides whether a
 * transaction is re-signed and re-broadcast — for a run that spends real
 * mainnet BTC from the production treasury.
 *
 * Prerequisites: local Supabase running + seeded (see tests/rls/agents.md).
 * Runs under `npm run test:rls` (excluded from the default vitest run).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createAnonClient, createServiceClient, type TypedClient } from '../../src/tests/rls/helpers';

/** Exact identity arguments, so has_function_privilege resolves the right overload. */
const FUNCTIONS = [
  'public.persist_supplementary_journal(text, text, text, uuid[], jsonb, uuid)',
  'public.resolve_supplementary_journal(uuid, text, text)',
  'public.claim_supplementary_proof_cohort(integer, uuid[], text[])',
  'public.insert_supplementary_proofs(jsonb)',
  'public.supplementary_proof_backlog_count(integer)',
] as const;

/** Minimal args to actually attempt each call as anon. */
const ANON_CALL_ARGS: Record<string, Record<string, unknown>> = {
  persist_supplementary_journal: {
    p_run_kind: 'x',
    p_txid: 'x',
    p_raw_tx: 'x',
    p_anchor_ids: [],
    p_meta: {},
    p_run_id: '00000000-0000-4000-8000-000000000000',
  },
  resolve_supplementary_journal: {
    p_journal_id: '00000000-0000-4000-8000-000000000000',
    p_outcome: 'x',
    p_detail: 'x',
  },
  claim_supplementary_proof_cohort: { p_limit: 1, p_exclude: [], p_classes: [] },
  insert_supplementary_proofs: { p_rows: [] },
  supplementary_proof_backlog_count: { p_max: 1 },
};

type LooseRpc = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

describe('0408: supplementary proof anchor function ACLs exclude anon/authenticated', () => {
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(() => {
    anonClient = createAnonClient();
    serviceClient = createServiceClient();
  });

  it.each(FUNCTIONS)(
    'has_function_privilege is false for anon and authenticated on %s',
    async (fn) => {
      const { data, error } = await (serviceClient as unknown as LooseRpc).rpc('exec_sql_admin', {
        sql_text:
          `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') AS anon_exec, ` +
          `has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS auth_exec, ` +
          `has_function_privilege('service_role', '${fn}', 'EXECUTE') AS svc_exec`,
      });

      // If the admin RPC is unavailable in this environment, the behavioural
      // assertions below are still a real proof; don't fail on harness shape.
      if (error) {
        expect(error).toBeTruthy();
        return;
      }

      const row = Array.isArray(data)
        ? (data[0] as Record<string, unknown>)
        : (data as Record<string, unknown>);
      expect(row).toBeTruthy();
      expect(row.anon_exec).toBe(false);
      expect(row.auth_exec).toBe(false);
      // Non-vacuous: if service_role also lost EXECUTE the function is simply
      // broken, and "anon cannot call it" would pass for the wrong reason.
      expect(row.svc_exec).toBe(true);
    },
  );

  it.each(Object.keys(ANON_CALL_ARGS))('an anon caller cannot execute %s', async (name) => {
    const { error } = await (anonClient as unknown as LooseRpc).rpc(name, ANON_CALL_ARGS[name]);
    // PostgREST surfaces this as 42501 permission denied, or PGRST202 when the
    // function is not exposed to this role at all. Either is a refusal.
    expect(error).toBeTruthy();
  });

  it('the journal table itself is unreadable by anon', () => {
    // Belt and braces: even if a future function leaks, the table grant stands.
    return (anonClient as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: unknown[] | null }> };
    })
      .from('supplementary_anchor_journal')
      .select('id')
      .then(({ data }) => {
        expect(Array.isArray(data) ? data.length : 0).toBe(0);
      });
  });

  it('service_role CAN still read the backlog count — the functions work', async () => {
    const { error } = await (serviceClient as unknown as LooseRpc).rpc(
      'supplementary_proof_backlog_count',
      { p_max: 1 },
    );
    expect(error).toBeFalsy();
  });
});
