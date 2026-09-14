/**
 * SCRUM-5023 — who actually receives an org-scoped administrative notice.
 *
 * The bug this pins: prod's "Fragile Rocks" org holds ONE active key with an
 * expiry ahead of it, ZERO `profiles` rows at `role = 'ORG_ADMIN'`, and ONE
 * `org_members` row at `role = 'admin'` whose profile has a live address. A
 * profiles-only lookup returns `[]` there, the notice job counts a
 * `noRecipients`, and the key lapses in silence — the exact outcome this story
 * exists to prevent, reintroduced inside the fix for it.
 */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listOrgAdminRecipients } from './orgAdminRecipients.js';

type Result = { data: unknown; error: { message: string } | null };

/**
 * Records every filter applied, then answers with whatever the scenario
 * queued for that table. `profiles` is queried twice (role-based, then by
 * id), so its answers are a queue, not a single value.
 */
function makeClient(scenario: {
  profilesByRole?: Result;
  profilesByIds?: Result;
  members?: Result;
}) {
  const filters: Array<{ table: string; op: string; args: unknown[] }> = [];
  const profileAnswers = [
    scenario.profilesByRole ?? { data: [], error: null },
    scenario.profilesByIds ?? { data: [], error: null },
  ];

  const client = {
    from(table: string) {
      const result = table === 'profiles'
        ? profileAnswers.shift() ?? { data: [], error: null }
        : scenario.members ?? { data: [], error: null };

      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'in', 'is']) {
        builder[op] = (...args: unknown[]) => {
          filters.push({ table, op, args });
          return builder;
        };
      }
      // The terminal await: any builder method may be the last one called.
      (builder as { then: unknown }).then = (resolve: (r: Result) => unknown) => resolve(result);
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, filters };
}

describe('listOrgAdminRecipients', () => {
  it('returns the profiles-table ORG_ADMINs', async () => {
    const { client } = makeClient({
      profilesByRole: { data: [{ email: 'admin@partner.example' }], error: null },
    });

    await expect(listOrgAdminRecipients(client, 'org-1')).resolves.toEqual(['admin@partner.example']);
  });

  it('finds an org_members admin that the profiles role column does not know about', async () => {
    // Fragile Rocks, verified in prod 2026-09-12.
    const { client } = makeClient({
      profilesByRole: { data: [], error: null },
      members: { data: [{ user_id: 'user-9' }], error: null },
      profilesByIds: { data: [{ email: 'owner@fragilerocks.example' }], error: null },
    });

    await expect(listOrgAdminRecipients(client, 'org-1'))
      .resolves.toEqual(['owner@fragilerocks.example']);
  });

  it('de-duplicates an admin recorded in BOTH tables, case-insensitively', async () => {
    // Org creators normally appear in both; the address casing need not match.
    const { client } = makeClient({
      profilesByRole: { data: [{ email: 'Carson@Arkova.io' }], error: null },
      members: { data: [{ user_id: 'user-1' }], error: null },
      profilesByIds: { data: [{ email: 'carson@arkova.io' }], error: null },
    });

    // The stored casing of the FIRST sighting is what gets mailed: the local
    // part of an address is technically case-sensitive.
    await expect(listOrgAdminRecipients(client, 'org-1')).resolves.toEqual(['Carson@Arkova.io']);
  });

  it('asks only for owner and admin members', async () => {
    const { client, filters } = makeClient({ members: { data: [], error: null } });
    await listOrgAdminRecipients(client, 'org-1');

    const roleFilter = filters.find((f) => f.table === 'org_members' && f.op === 'in');
    expect(roleFilter?.args).toEqual(['role', ['owner', 'admin']]);
  });

  it('excludes soft-deleted profiles from both lookups', async () => {
    const { client, filters } = makeClient({
      members: { data: [{ user_id: 'user-9' }], error: null },
    });
    await listOrgAdminRecipients(client, 'org-1');

    const deletedFilters = filters.filter((f) => f.table === 'profiles' && f.op === 'is');
    expect(deletedFilters).toHaveLength(2);
    expect(deletedFilters.every((f) => f.args[0] === 'deleted_at' && f.args[1] === null)).toBe(true);
  });

  it('skips blank and missing addresses rather than mailing an empty string', async () => {
    const { client } = makeClient({
      profilesByRole: { data: [{ email: '  ' }, { email: null }, { email: 'real@example.test' }], error: null },
    });

    await expect(listOrgAdminRecipients(client, 'org-1')).resolves.toEqual(['real@example.test']);
  });

  it('does not resolve member profiles when there are no admin members', async () => {
    const { client, filters } = makeClient({ members: { data: [], error: null } });
    await listOrgAdminRecipients(client, 'org-1');

    expect(filters.some((f) => f.table === 'profiles' && f.op === 'in')).toBe(false);
  });

  it('THROWS on a lookup error instead of reporting "no admins"', async () => {
    // An empty array is indistinguishable from "this org has nobody to tell",
    // so the caller would record the notice as handled and lose the warning.
    const { client } = makeClient({
      profilesByRole: { data: null, error: { message: 'connection reset' } },
    });

    await expect(listOrgAdminRecipients(client, 'org-1')).rejects.toThrow(/connection reset/);
  });

  it('THROWS when the org_members lookup fails', async () => {
    const { client } = makeClient({ members: { data: null, error: { message: 'timeout' } } });

    await expect(listOrgAdminRecipients(client, 'org-1')).rejects.toThrow(/timeout/);
  });
});
