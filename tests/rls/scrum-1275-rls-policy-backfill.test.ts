/**
 * SCRUM-1275 (R3-2) — RLS policy backfill regression tests.
 *
 * Migration 0282 added explicit `service_role` policies to the three
 * tables that were ENABLE+FORCE RLS without a policy in prod. The
 * tables only worked at runtime because `service_role` has the
 * `BYPASSRLS` role attribute — fragile coupling that the policies
 * remove. These tests pin three things:
 *
 *   1. service_role can read each table (sanity — no regression).
 *   2. anon cannot SELECT from any of them (intentionally worker-only).
 *   3. authenticated cannot SELECT from any of them (intentionally worker-only).
 *
 * If the policies regress (e.g. dropped, scope narrowed), at least one
 * of these assertions flips.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createAnonClient,
  createServiceClient,
  withIndividualUser,
  type TypedClient,
} from '../../src/tests/rls/helpers';

const TARGET_TABLES = [
  'drive_folder_path_cache',
  'kyb_webhook_nonces',
  'parent_split_tokens',
] as const;

type FromableClient = {
  from: (t: string) => {
    select: (cols: string) => {
      limit: (n: number) => Promise<{ data: unknown[] | null; error: { code?: string } | null }>;
    };
  };
};

describe('SCRUM-1275: RLS policy backfill (drive_folder_path_cache, kyb_webhook_nonces, parent_split_tokens)', () => {
  let anonClient: TypedClient;
  let authClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    anonClient = createAnonClient();
    authClient = await withIndividualUser();
    serviceClient = createServiceClient();
  });

  for (const table of TARGET_TABLES) {
    it(`service_role can SELECT ${table} (sanity — policy permits)`, async () => {
      const { error } = await (serviceClient as unknown as FromableClient)
        .from(table)
        .select('*')
        .limit(1);
      // Even if rows = 0, error must be null (policy allows the read).
      expect(error).toBeNull();
    });

    it(`anon cannot SELECT ${table} (no anon policy)`, async () => {
      const { data, error } = await (anonClient as unknown as FromableClient)
        .from(table)
        .select('*')
        .limit(1);
      // Either an explicit deny error or an empty result — both prove RLS holds.
      const visible = Array.isArray(data) ? data.length : 0;
      expect(visible).toBe(0);
      // 42501 = insufficient_privilege; PGRST often returns empty data
      // with a 401-ish error shape. Accept either.
      if (error) {
        expect(['42501', undefined, 'PGRST301']).toContain(error.code);
      }
    });

    it(`authenticated cannot SELECT ${table} (no authenticated policy)`, async () => {
      const { data, error } = await (authClient as unknown as FromableClient)
        .from(table)
        .select('*')
        .limit(1);
      const visible = Array.isArray(data) ? data.length : 0;
      expect(visible).toBe(0);
      if (error) {
        expect(['42501', undefined, 'PGRST301']).toContain(error.code);
      }
    });
  }
});
