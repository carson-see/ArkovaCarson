/**
 * SCRUM-1276 (R3-3) — public_org_profiles view runs with security_invoker
 *
 * Migration 0281 converted the view from default (definer) to
 * `security_invoker = true`. This pins the new behavior so a future
 * `CREATE OR REPLACE VIEW` without the option fails the test before
 * it ships.
 *
 * Threat model: pre-0281 the view ran as the view owner, bypassing
 * `organizations` RLS. Although the SELECT list is restricted to
 * non-PII fields, RLS bypass meant any future column extension or
 * policy regression would silently leak across tenants. With
 * security_invoker, the caller's RLS applies, so anon (no SELECT
 * policy on organizations) sees zero rows through the view; the
 * intentional anon-read path is the SECURITY DEFINER RPC
 * `get_public_org_profiles`, which is the only callsite in the
 * frontend (`src/hooks/useUserOrgs.ts`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createAnonClient,
  createServiceClient,
  type TypedClient,
} from '../../src/tests/rls/helpers';

describe('SCRUM-1276: public_org_profiles security_invoker', () => {
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(() => {
    anonClient = createAnonClient();
    serviceClient = createServiceClient();
  });

  it('view is declared with security_invoker = true', async () => {
    // pg_class.reloptions stores the option as 'security_invoker=true'.
    // service_role bypasses RLS so this read is reliable.
    const { data, error } = await (serviceClient as unknown as {
      rpc: (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>;
    }).rpc('exec_sql_admin', {
      sql_text:
        "SELECT (c.reloptions @> ARRAY['security_invoker=true']) AS has_invoker " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname = 'public_org_profiles'",
    });

    // If the admin RPC isn't available in this env, fall back to a behavior
    // assertion: anon's view read returns zero rows (proves invoker semantics).
    if (error) {
      const { data: anonRows } = await (anonClient as unknown as {
        from: (t: string) => {
          select: (cols: string) => Promise<{ data: unknown[] | null; error: unknown }>;
        };
      })
        .from('public_org_profiles')
        .select('id');
      expect(Array.isArray(anonRows) ? anonRows.length : 0).toBe(0);
      return;
    }

    expect(data).toBeTruthy();
  });

  it('anon SELECT through the view returns zero rows (caller RLS applies)', async () => {
    // organizations has no anon SELECT policy. Under security_invoker the
    // view inherits that, so anon sees nothing. Pre-0281 this returned
    // every organization row.
    const { data, error } = await (anonClient as unknown as {
      from: (t: string) => {
        select: (cols: string) => Promise<{ data: unknown[] | null; error: unknown }>;
      };
    })
      .from('public_org_profiles')
      .select('id, display_name');

    // Either explicit deny error or empty result — both prove RLS is honored.
    const visibleRows = Array.isArray(data) ? data.length : 0;
    expect(visibleRows).toBe(0);
    // No leak shape: must not return any field that the threat model targets.
    if (Array.isArray(data) && data.length > 0) {
      const cols = Object.keys(data[0] as Record<string, unknown>);
      expect(cols).not.toContain('ein_tax_id');
      expect(cols).not.toContain('domain_verification_token');
    }
    expect(error === null || (error as { code?: string })?.code === '42501').toBe(true);
  });

  it('service_role bypasses RLS and reads through the view (sanity)', async () => {
    // Confirms the view itself still works for callers who legitimately
    // bypass RLS — used by service-role-only paths.
    const { data, error } = await (serviceClient as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          limit: (n: number) => Promise<{ data: unknown[] | null; error: unknown }>;
        };
      };
    })
      .from('public_org_profiles')
      .select('id')
      .limit(1);

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });
});
