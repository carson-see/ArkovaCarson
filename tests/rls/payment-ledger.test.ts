/**
 * SCRUM-1284 (R3-11) AC3 — payment_ledger access regression test.
 *
 * Migration 0274 set `payment_ledger` to `security_invoker = true`
 * (was SECURITY DEFINER, the original SCRUM-1208 audit miss). Anon
 * has GRANT SELECT (legacy from 0160) but the underlying tables
 * (`billing_events`, `x402_payments`, `ai_usage_events`) have no
 * anon RLS policy, so caller-RLS filters everything to zero rows.
 * Authenticated has no GRANT at all (revoked in 0160 SEC-RECON-2).
 *
 * If the security_invoker option regresses (e.g. someone runs a
 * `CREATE OR REPLACE VIEW payment_ledger AS ...` that omits the
 * option), the anon path would silently start leaking the union
 * of billing rows — exactly the SCRUM-1208 false-resolved gap.
 * This test pins the contract.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createAnonClient,
  createServiceClient,
  withIndividualUser,
  type TypedClient,
} from '../../src/tests/rls/helpers';

type FromableClient = {
  from: (t: string) => {
    select: (cols: string) => {
      limit: (n: number) => Promise<{ data: unknown[] | null; error: { code?: string } | null }>;
    };
  };
};

describe('SCRUM-1284 (R3-11): payment_ledger access regression', () => {
  let anonClient: TypedClient;
  let authClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    anonClient = createAnonClient();
    authClient = await withIndividualUser();
    serviceClient = createServiceClient();
  });

  it('anon SELECT through payment_ledger returns zero rows (caller-RLS applies under security_invoker)', async () => {
    const { data, error } = await (anonClient as unknown as FromableClient)
      .from('payment_ledger')
      .select('ledger_id, source, amount_usd')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
    if (error) {
      // Some PostgREST versions surface this as 401/PGRST301 rather than 42501.
      expect(['42501', 'PGRST301', undefined]).toContain(error.code);
    }
  });

  it('non-admin authenticated SELECT through payment_ledger is denied (no GRANT to authenticated)', async () => {
    const { data, error } = await (authClient as unknown as FromableClient)
      .from('payment_ledger')
      .select('ledger_id, source, amount_usd')
      .limit(1);

    // Authenticated has no GRANT SELECT. PGRST returns 42501 / PGRST301.
    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
    if (error) {
      expect(['42501', 'PGRST301', undefined]).toContain(error.code);
    }
  });

  it('service_role can SELECT through payment_ledger (sanity — admin/worker path)', async () => {
    const { error } = await (serviceClient as unknown as FromableClient)
      .from('payment_ledger')
      .select('ledger_id')
      .limit(1);
    expect(error).toBeNull();
  });
});
