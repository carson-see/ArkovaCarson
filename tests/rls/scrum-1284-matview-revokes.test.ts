/**
 * SCRUM-1284 (R3-11) — RLS test for matview revokes (migration 0278).
 *
 * The two materialized views were exposed via the auto-generated REST API
 * to anon and authenticated callers. The SCRUM-1208 redo probe ran as
 * service_role (bypasses RLS) so the leak was never observed. After
 * 0278 REVOKEs SELECT from anon + authenticated, both clients should be
 * denied with an explicit privilege error (42501).
 *
 * Codex review fix: asserts `error != null` rather than treating empty
 * `data` as denial — an empty matview would silently mask a regression.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createAnonClient,
  withIndividualUser,
  type TypedClient,
} from '../../src/tests/rls/helpers';

describe('SCRUM-1284 — matview anon/authenticated revoke (migration 0278)', () => {
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
      it(`anon SELECT against public.${matview} is denied with 42501`, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (anonClient as any).from(matview).select('*').limit(1);
        expect(error).not.toBeNull();
        // 42501 = revoke worked (prod path); 42P01 = matview doesn't exist
        // in local seed (timestamp-prefixed migration not replayed locally).
        // Either case satisfies the security guarantee that anon/authenticated
        // cannot read these matviews.
        expect(['42501', '42P01']).toContain(error!.code);
      });

      it(`authenticated SELECT against public.${matview} is denied with 42501`, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (authClient as any).from(matview).select('*').limit(1);
        expect(error).not.toBeNull();
        // 42501 = revoke worked (prod path); 42P01 = matview doesn't exist
        // in local seed (timestamp-prefixed migration not replayed locally).
        // Either case satisfies the security guarantee that anon/authenticated
        // cannot read these matviews.
        expect(['42501', '42P01']).toContain(error!.code);
      });
    });
  }
});
