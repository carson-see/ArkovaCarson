/**
 * Tests for the shared org-auth helpers (SCRUM-1849 / SCRUM-1863).
 *
 * Focus: `isUserMemberOfOrg` (the cross-org gate for admin-acts-on-member
 * flows) and `isCallerOrgAdmin`, which together authorize the org CPE export.
 *
 * The worker uses a service_role client (RLS bypassed), so these predicates ARE
 * the tenant boundary — they must fail closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isUserMemberOfOrg, isCallerOrgAdmin, getCallerOrgId } from './_org-auth.js';
import { db } from '../utils/db.js';

type Result = { data: unknown; error: unknown };

/**
 * Build a chainable query stub whose terminal `.maybeSingle()` resolves to the
 * given result. `select`/`eq` return the same chain so any number of `.eq()`
 * calls work. Captures the table name so a single `db.from` mock can route by
 * table.
 */
function makeChain(result: Result) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}

const fromMock = db.from as unknown as ReturnType<typeof vi.fn>;

/** Route db.from(table) → a per-table result. */
function routeTables(map: Partial<Record<'org_members' | 'profiles', Result>>) {
  fromMock.mockImplementation((table: string) => {
    const result = map[table as 'org_members' | 'profiles'] ?? { data: null, error: null };
    return makeChain(result);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isUserMemberOfOrg', () => {
  it('returns true when the target has an org_members row for the org', async () => {
    routeTables({ org_members: { data: { user_id: 'target' }, error: null } });
    expect(await isUserMemberOfOrg('target', 'org-A')).toBe(true);
  });

  it('returns true via profiles.org_id fallback when no org_members row exists', async () => {
    routeTables({
      org_members: { data: null, error: null },
      profiles: { data: { org_id: 'org-A', role: 'ORG_MEMBER', is_platform_admin: false }, error: null },
    });
    expect(await isUserMemberOfOrg('target', 'org-A')).toBe(true);
  });

  it('returns false when the target belongs to a DIFFERENT org (cross-org)', async () => {
    routeTables({
      org_members: { data: null, error: null },
      profiles: { data: { org_id: 'org-B', role: 'ORG_MEMBER', is_platform_admin: false }, error: null },
    });
    expect(await isUserMemberOfOrg('target', 'org-A')).toBe(false);
  });

  it('returns false when the target has no org at all', async () => {
    routeTables({
      org_members: { data: null, error: null },
      profiles: { data: { org_id: null, role: 'INDIVIDUAL', is_platform_admin: false }, error: null },
    });
    expect(await isUserMemberOfOrg('target', 'org-A')).toBe(false);
  });

  it('fails closed (false) when the org_members lookup errors', async () => {
    routeTables({ org_members: { data: null, error: { message: 'boom' } } });
    expect(await isUserMemberOfOrg('target', 'org-A')).toBe(false);
  });

  it('returns false for empty inputs without hitting the db', async () => {
    routeTables({});
    expect(await isUserMemberOfOrg('', 'org-A')).toBe(false);
    expect(await isUserMemberOfOrg('target', '')).toBe(false);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('isCallerOrgAdmin', () => {
  it('returns true when org_members role is owner', async () => {
    routeTables({ org_members: { data: { role: 'owner' }, error: null } });
    expect(await isCallerOrgAdmin('admin', 'org-A')).toBe(true);
  });

  it('returns true when org_members role is admin', async () => {
    routeTables({ org_members: { data: { role: 'admin' }, error: null } });
    expect(await isCallerOrgAdmin('admin', 'org-A')).toBe(true);
  });

  it('returns true via profile role ORG_ADMIN when no admin membership row', async () => {
    routeTables({
      org_members: { data: { role: 'member' }, error: null },
      profiles: { data: { org_id: 'org-A', role: 'ORG_ADMIN', is_platform_admin: false }, error: null },
    });
    expect(await isCallerOrgAdmin('admin', 'org-A')).toBe(true);
  });

  it('returns false for a plain member (no admin role, profile ORG_MEMBER)', async () => {
    routeTables({
      org_members: { data: { role: 'member' }, error: null },
      profiles: { data: { org_id: 'org-A', role: 'ORG_MEMBER', is_platform_admin: false }, error: null },
    });
    expect(await isCallerOrgAdmin('member', 'org-A')).toBe(false);
  });
});

describe('getCallerOrgId', () => {
  it('returns the org id from the profile', async () => {
    routeTables({ profiles: { data: { org_id: 'org-A', role: 'ORG_ADMIN', is_platform_admin: false }, error: null } });
    expect(await getCallerOrgId('admin')).toBe('org-A');
  });

  it('returns null when the profile lookup errors (fail closed)', async () => {
    routeTables({ profiles: { data: null, error: { message: 'boom' } } });
    expect(await getCallerOrgId('admin')).toBeNull();
  });
});
