/** API-key notices must reach people authorized to act on that org's keys. */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listOrgAdminRecipients } from './orgAdminRecipients.js';

type Row = Record<string, unknown>;
function makeClient(
  profiles: Row[], members: Row[] = [],
  options: { serverCap?: number; failAtOffset?: number } = {},
) {
  return {
    from(table: string) {
      const predicates: Array<(row: Row) => boolean> = [];
      const rows = table === 'profiles' ? profiles : members;
      let offset = 0;
      let limit = options.serverCap ?? 1_000;
      let orderColumn: string | null = null;
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { predicates.push((row) => row[column] === value); return builder; },
        is: (column: string, value: unknown) => { predicates.push((row) => row[column] === value); return builder; },
        in: (column: string, values: unknown[]) => { predicates.push((row) => values.includes(row[column])); return builder; },
        order: (column: string) => { orderColumn = column; return builder; },
        range: (from: number, to: number) => {
          offset = from;
          limit = Math.min(to - from + 1, options.serverCap ?? 1_000);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          const filtered = rows.filter((row) => predicates.every((predicate) => predicate(row)));
          if (orderColumn) {
            const column = orderColumn;
            filtered.sort((a, b) => String(a[column]).localeCompare(String(b[column])));
          }
          const failed = options.failAtOffset !== undefined && offset >= options.failAtOffset;
          return resolve({
            data: failed ? null : filtered.slice(offset, offset + limit),
            error: failed ? { code: '08006', message: 'connection reset' } : null,
          });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}
const admin = (overrides: Row = {}): Row => ({
  id: 'admin-1', org_id: 'org-1', role: 'ORG_ADMIN', deleted_at: null,
  email: 'admin@example.test', ...overrides,
});

describe('listOrgAdminRecipients — API-key authorization parity', () => {
  it('returns the owning-org profile administrators', async () => {
    await expect(listOrgAdminRecipients(makeClient([admin()]), 'org-1'))
      .resolves.toEqual(['admin@example.test']);
  });

  it('does not notify membership-only administrators who cannot use the key-management API', async () => {
    const profile = admin({ id: 'member-1', role: 'INDIVIDUAL', email: 'member@example.test' });
    const membership = { org_id: 'org-1', user_id: 'member-1', role: 'admin' };
    await expect(listOrgAdminRecipients(makeClient([profile], [membership]), 'org-1')).resolves.toEqual([]);
  });

  it('does not notify a foreign-home-org administrator whose notice link opens different keys', async () => {
    const profile = admin({ org_id: 'org-2' });
    const membership = { org_id: 'org-1', user_id: 'admin-1', role: 'owner' };
    await expect(listOrgAdminRecipients(makeClient([profile], [membership]), 'org-1')).resolves.toEqual([]);
  });

  it('excludes soft-deleted profiles even when an administrator membership remains', async () => {
    const profile = admin({ deleted_at: '2026-09-01T00:00:00Z' });
    const membership = { org_id: 'org-1', user_id: 'admin-1', role: 'admin' };
    await expect(listOrgAdminRecipients(makeClient([profile], [membership]), 'org-1')).resolves.toEqual([]);
  });

  it('de-duplicates addresses case-insensitively while retaining stored casing', async () => {
    const profiles = [admin({ email: 'Admin@example.test' }), admin({ id: 'admin-2' })];
    await expect(listOrgAdminRecipients(makeClient(profiles), 'org-1')).resolves.toEqual(['Admin@example.test']);
  });

  it('ignores missing and blank addresses', async () => {
    const profiles = [admin({ email: null }), admin({ email: '   ' }), admin({ email: ' usable@example.test ' })];
    await expect(listOrgAdminRecipients(makeClient(profiles), 'org-1')).resolves.toEqual(['usable@example.test']);
  });

  it('returns every authorized recipient beyond 1,000 rows when the server returns short pages', async () => {
    const profiles = Array.from({ length: 1_205 }, (_, i) => admin({
      id: `admin-${String(i).padStart(4, '0')}`, email: `admin-${i}@example.test`,
    }));
    const expected = profiles.map((profile) => profile.email);
    await expect(listOrgAdminRecipients(makeClient(profiles.reverse(), [], { serverCap: 400 }), 'org-1'))
      .resolves.toEqual(expected);
  });

  it('rejects a later-page failure instead of returning a partial recipient set', async () => {
    const profiles = Array.from({ length: 401 }, (_, i) => admin({ id: `admin-${i}` }));
    await expect(listOrgAdminRecipients(makeClient(profiles, [], { serverCap: 400, failAtOffset: 400 }), 'org-1'))
      .rejects.toThrow(/page scan failed at offset 400/);
  });

  it('rejects a recipient set beyond the scan budget instead of silently truncating it', async () => {
    const profiles = Array.from({ length: 25_001 }, (_, i) => admin({ id: `admin-${i}` }));
    await expect(listOrgAdminRecipients(makeClient(profiles), 'org-1'))
      .rejects.toThrow(/row_budget_exceeded/);
  });

  it('throws on lookup failure rather than recording an empty recipient set', async () => {
    await expect(listOrgAdminRecipients(makeClient([], [], { failAtOffset: 0 }), 'org-1'))
      .rejects.toThrow(/page scan failed at offset 0/);
  });
});
