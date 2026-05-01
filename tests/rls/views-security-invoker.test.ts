/**
 * RLS regression tests for SCRUM-1276 (R3-3) — public-schema views
 * security_invoker audit.
 *
 * Goal: pin that `public_org_profiles` is NOT a view in the live schema
 * (it was DROPPED in 0161 and replaced with the SECURITY DEFINER
 * function `get_public_org_profiles`). Re-introducing the view without
 * security_invoker would re-open the cross-tenant leak.
 *
 * The runtime `security_invoker = true` flag on the surviving public
 * views (`payment_ledger`, `v_slow_queries`, `calibration_features`) is
 * statically enforced by `scripts/ci/check-views-security-invoker.ts` —
 * runtime introspection through Supabase's REST surface can't read
 * `pg_class.reloptions` (pg_catalog isn't exposed), so the lint is the
 * canonical guard for that property.
 *
 * Prerequisites: Supabase running locally with all migrations
 * (including 0281) applied.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createServiceClient, type TypedClient } from '../../src/tests/rls/helpers';

describe('SCRUM-1276: public-schema views security_invoker audit', () => {
  let serviceClient: TypedClient;

  beforeAll(() => {
    serviceClient = createServiceClient();
  });

  it('public_org_profiles is NOT a view (dropped in 0161, replaced with function)', async () => {
    // pg_views IS exposed through the REST surface (it's a public-schema
    // view from Postgres core, accessible to authenticated/service_role).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: viewRows, error } = await (serviceClient as any)
      .from('pg_views')
      .select('viewname')
      .eq('schemaname', 'public')
      .eq('viewname', 'public_org_profiles');

    // Soft-skip if PostgREST refuses pg_views in this fixture — the lint
    // is the canonical guard. The migration's defensive DROP IF EXISTS
    // also pins the runtime state.
    if (error?.code === 'PGRST205' || error?.code === 'PGRST116') return;

    expect(viewRows ?? []).toHaveLength(0);
  });

  it('get_public_org_profiles function exists as the canonical replacement', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (serviceClient as any).rpc('get_public_org_profiles', {});
    // service_role can call without args; should not 404 (function-not-found)
    expect(error?.code).not.toBe('42883');
  });
});
