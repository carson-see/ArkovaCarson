/**
 * Tests for the shared org-auth helpers (SCRUM-1849 / SCRUM-1863).
 *
 * Focus: `isUserMemberOfOrg` (the cross-org gate for admin-acts-on-member
 * flows) and `isCallerOrgAdmin`, which together authorize the org CPE export,
 * plus the `*Result` variants that surface a DB/operational `error` so a caller
 * can return 500 instead of masking a fault as 403 (PR #1045 review).
 *
 * The worker uses a service_role client (RLS bypassed), so these predicates ARE
 * the tenant boundary — the boolean forms must fail closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  isUserMemberOfOrg,
  isCallerOrgAdmin,
  getCallerOrgId,
  getCallerOrgIdResult,
  isCallerOrgAdminResult,
  isUserMemberOfOrgResult,
} from './_org-auth.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

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

// ─── *Result variants: 403-vs-500 signal (PR #1045 review) ───
describe('getCallerOrgIdResult', () => {
  it('reports a true negative (no org) WITHOUT an error', async () => {
    routeTables({ profiles: { data: { org_id: null, role: 'INDIVIDUAL', is_platform_admin: false }, error: null } });
    expect(await getCallerOrgIdResult('user')).toEqual({ value: null, error: false });
  });

  it('reports error:true (operational) when the profile lookup errors', async () => {
    routeTables({ profiles: { data: null, error: { message: 'boom' } } });
    const result = await getCallerOrgIdResult('user');
    expect(result).toEqual({ value: null, error: true });
  });

  it('reports the org id with error:false on success', async () => {
    routeTables({ profiles: { data: { org_id: 'org-A', role: 'ORG_ADMIN', is_platform_admin: false }, error: null } });
    expect(await getCallerOrgIdResult('admin')).toEqual({ value: 'org-A', error: false });
  });
});

describe('isCallerOrgAdminResult', () => {
  it('reports admin with error:false from an owner/admin org_members row', async () => {
    routeTables({ org_members: { data: { role: 'admin' }, error: null } });
    expect(await isCallerOrgAdminResult('admin', 'org-A')).toEqual({ value: true, error: false });
  });

  it('reports a definitive non-admin with error:false (clean negative → 403)', async () => {
    routeTables({
      org_members: { data: { role: 'member' }, error: null },
      profiles: { data: { org_id: 'org-A', role: 'ORG_MEMBER', is_platform_admin: false }, error: null },
    });
    expect(await isCallerOrgAdminResult('member', 'org-A')).toEqual({ value: false, error: false });
  });

  it('captures + LOGS the org_members error and reports error:true when no admin signal (finding c)', async () => {
    // org_members errors; profile fallback finds no admin role → indeterminate.
    routeTables({
      org_members: { data: null, error: { message: 'db down' } },
      profiles: { data: { org_id: 'org-A', role: 'ORG_MEMBER', is_platform_admin: false }, error: null },
    });
    const result = await isCallerOrgAdminResult('user', 'org-A');
    expect(result).toEqual({ value: false, error: true });
    // The previously-swallowed org_members error is now explicitly logged.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: { message: 'db down' }, userId: 'user', orgId: 'org-A' }),
      'org-auth: admin membership lookup failed',
    );
  });

  it('does NOT report an error when a positive admin signal exists despite an org_members hiccup', async () => {
    // org_members errors, but the profile fallback proves platform-admin → admin
    // is definitive, so the lookup error is immaterial (error:false).
    routeTables({
      org_members: { data: null, error: { message: 'transient' } },
      profiles: { data: { org_id: 'org-A', role: 'INDIVIDUAL', is_platform_admin: true }, error: null },
    });
    expect(await isCallerOrgAdminResult('user', 'org-A')).toEqual({ value: true, error: false });
  });

  it('boolean isCallerOrgAdmin still fails closed (false) on org_members error', async () => {
    routeTables({
      org_members: { data: null, error: { message: 'db down' } },
      profiles: { data: { org_id: 'org-A', role: 'ORG_MEMBER', is_platform_admin: false }, error: null },
    });
    expect(await isCallerOrgAdmin('user', 'org-A')).toBe(false);
  });
});

describe('isUserMemberOfOrgResult', () => {
  it('reports a definitive non-member with error:false (clean cross-org → 403)', async () => {
    routeTables({
      org_members: { data: null, error: null },
      profiles: { data: { org_id: 'org-B', role: 'ORG_MEMBER', is_platform_admin: false }, error: null },
    });
    expect(await isUserMemberOfOrgResult('target', 'org-A')).toEqual({ value: false, error: false });
  });

  it('reports error:true when the org_members lookup errors and no positive signal', async () => {
    routeTables({
      org_members: { data: null, error: { message: 'boom' } },
      profiles: { data: { org_id: 'org-B', role: 'ORG_MEMBER', is_platform_admin: false }, error: null },
    });
    expect(await isUserMemberOfOrgResult('target', 'org-A')).toEqual({ value: false, error: true });
  });

  it('reports member with error:false from an org_members row (no error escalation)', async () => {
    routeTables({ org_members: { data: { user_id: 'target' }, error: null } });
    expect(await isUserMemberOfOrgResult('target', 'org-A')).toEqual({ value: true, error: false });
  });

  it('returns error:false for empty inputs (a definitive non-member, not an error)', async () => {
    routeTables({});
    expect(await isUserMemberOfOrgResult('', 'org-A')).toEqual({ value: false, error: false });
  });
});
