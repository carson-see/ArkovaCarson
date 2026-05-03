/**
 * RLS regression tests for SCRUM-1276 (R3-3) — public-schema views
 * security_invoker audit.
 *
 * Goal: pin that `public_org_profiles` is a live view after migration
 * 0281 and that the SECURITY DEFINER function `get_public_org_profiles`
 * remains callable as the intentional public organization search path.
 *
 * The static migration lint also enforces that every newly created view
 * declares `security_invoker = true`; the sibling runtime test verifies
 * the reloption and caller-RLS behavior for `public_org_profiles`.
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

  it('public_org_profiles is a public view after migration 0281', async () => {
    // pg_views IS exposed through the REST surface (it's a public-schema
    // view from Postgres core, accessible to authenticated/service_role).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: viewRows, error } = await (serviceClient as any)
      .from('pg_views')
      .select('viewname')
      .eq('schemaname', 'public')
      .eq('viewname', 'public_org_profiles');

    // Soft-skip only when PostgREST does not expose pg_views in this fixture.
    // Other errors must fail so this regression test cannot silently pass.
    if (error?.code === 'PGRST205' || error?.code === 'PGRST116' || error?.code === '42P01') return;

    expect(error).toBeNull();
    expect(viewRows ?? []).toHaveLength(1);
  });

  it('get_public_org_profiles function succeeds as the intentional public search path', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (serviceClient as any).rpc('get_public_org_profiles', {});
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });
});
