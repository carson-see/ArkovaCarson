/**
 * SCRUM-1284 (R3-11) — RLS test for matview revokes (migration 0277).
 *
 * The two materialized views were exposed via the auto-generated REST API
 * to anon and authenticated callers. The SCRUM-1208 redo probe ran as
 * service_role (bypasses RLS) so the leak was never observed. After 0277
 * REVOKEs SELECT from anon + authenticated, both clients should see either
 * an explicit error OR no rows when querying via PostgREST.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createAnonClient,
  withIndividualUser,
  type TypedClient,
} from '../../src/tests/rls/helpers';

describe('SCRUM-1284 — matview anon/authenticated revoke (migration 0277)', () => {
  let anonClient: TypedClient;
  let authClient: TypedClient;

  beforeAll(async () => {
    anonClient = createAnonClient();
    authClient = await withIndividualUser();
  });

  afterAll(async () => {
    await authClient.auth.signOut();
  });

  for (const matview of ['mv_anchor_status_counts', 'mv_public_records_source_counts']) {
    describe(matview, () => {
      it(`anon cannot SELECT rows from public.${matview}`, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (anonClient as any).from(matview).select('*').limit(1);
        const hasAccess = !error && Array.isArray(data) && data.length > 0;
        expect(hasAccess).toBe(false);
      });

      it(`authenticated user cannot SELECT rows from public.${matview}`, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (authClient as any).from(matview).select('*').limit(1);
        const hasAccess = !error && Array.isArray(data) && data.length > 0;
        expect(hasAccess).toBe(false);
      });
    });
  }
});
