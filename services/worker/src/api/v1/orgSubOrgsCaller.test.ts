/**
 * SCRUM-3971 — who is acting on the sub-organization surface, and on which
 * child.
 *
 * Every case here is a REFUSAL that the route layer alone cannot make safely:
 * the key surface names children by public id, so "not found", "not yours",
 * "not approved yet" and "suspended" all have to collapse to one answer that
 * leaks nothing, while the JWT surface keeps the 403s it has always returned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({ config: { frontendUrl: 'https://app.test' } }));

import { db } from '../../utils/db.js';
import {
  resolveSubOrgCaller,
  resolveChildForApprove,
  resolveChildForRevoke,
  resolveApprovedChild,
  resolveOwnedChild,
  subOrgAuditActor,
} from './orgSubOrgsCaller.js';

const PARENT = '22222222-2222-4222-8222-222222222222';
const OTHER_PARENT = '33333333-3333-4333-8333-333333333333';
const CHILD = '44444444-4444-4444-8444-444444444444';
const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const KEY_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

const KEY_CALLER = { kind: 'api_key', apiKeyId: KEY_ID, keyPrefix: 'ak_live_65aa', orgId: PARENT } as const;

function keyReq(overrides: Partial<{ orgId: string }> = {}): Request {
  return {
    apiKey: {
      keyId: KEY_ID,
      orgId: overrides.orgId ?? PARENT,
      userId: 'the-key-owner-user-id',
      scopes: ['orgs:manage'],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_live_65aa',
    },
    query: {},
    headers: {},
  } as unknown as Request;
}

function jwtReq(userId: string = USER, query: Record<string, string> = {}): Request {
  return { userId, query, headers: {} } as unknown as Request;
}

/** No API key, no verified JWT identity. */
function anonReq(): Request {
  return { query: {}, headers: {} } as unknown as Request;
}

/**
 * Minimal PostgREST double. `rows` is consulted by the last `.eq()` pair the
 * caller applied, so a test states the table contents rather than the chain.
 */
interface OrgRow {
  id: string;
  public_id?: string | null;
  display_name?: string;
  parent_org_id?: string | null;
  parent_approval_status?: string | null;
  suspended?: boolean;
}

function mockDb(opts: {
  organizations?: OrgRow[];
  organizationsError?: { message: string };
  memberships?: { org_id: string; role: string }[];
  membershipsError?: { message: string };
  profile?: { org_id: string | null; role: string | null; is_platform_admin: boolean | null } | null;
  profileError?: { message: string };
}) {
  const from = db.from as unknown as ReturnType<typeof vi.fn>;
  from.mockImplementation((table: string) => {
    if (table === 'organizations') {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (col: string, value: unknown) => { filters[col] = value; return chain; };
      chain.maybeSingle = () => {
        if (opts.organizationsError) return Promise.resolve({ data: null, error: opts.organizationsError });
        const hit = (opts.organizations ?? []).find((row) =>
          Object.entries(filters).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v));
        return Promise.resolve({ data: hit ?? null, error: null });
      };
      return chain;
    }
    if (table === 'org_members') {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () => Promise.resolve({
        data: (opts.memberships ?? [])[0] ?? null,
        error: opts.membershipsError ?? null,
      });
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({
        data: opts.membershipsError ? null : (opts.memberships ?? []),
        error: opts.membershipsError ?? null,
      }).then(resolve);
      return chain;
    }
    if (table === 'profiles') {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () => Promise.resolve({
        data: opts.profileError ? null : (opts.profile ?? null),
        error: opts.profileError ?? null,
      });
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSubOrgCaller — API key branch', () => {
  it('acts as the key OWNING ORG, never as the key-creating user', async () => {
    mockDb({ organizations: [{ id: PARENT, parent_org_id: null }] });
    const result = await resolveSubOrgCaller(keyReq());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      kind: 'api_key',
      apiKeyId: KEY_ID,
      keyPrefix: 'ak_live_65aa',
      orgId: PARENT,
    });
    // The key's `userId` is a privilege-laundering hazard: it is the human who
    // minted the key, not the principal acting. It must not appear at all.
    expect(JSON.stringify(result.value)).not.toContain('the-key-owner-user-id');
  });

  it('refuses a key whose own organization has a parent (a child never acts as a parent)', async () => {
    mockDb({ organizations: [{ id: CHILD, parent_org_id: PARENT }] });
    const result = await resolveSubOrgCaller(keyReq({ orgId: CHILD }));
    expect(result).toMatchObject({ ok: false, status: 403, error: 'sub_org_cannot_manage_sub_orgs' });
  });

  it('503s (never 403s) when the acting-org lookup itself fails', async () => {
    mockDb({ organizationsError: { message: 'boom' } });
    const result = await resolveSubOrgCaller(keyReq());
    expect(result).toMatchObject({ ok: false, status: 503, error: 'org_lookup_unavailable' });
  });

  it('refuses a key whose organization row is gone', async () => {
    mockDb({ organizations: [] });
    const result = await resolveSubOrgCaller(keyReq());
    expect(result).toMatchObject({ ok: false, status: 403, error: 'acting_org_not_found' });
  });
});

describe('resolveSubOrgCaller — credential combinations', () => {
  it('409s when BOTH a verified JWT identity and an API key are present', async () => {
    mockDb({ organizations: [{ id: PARENT, parent_org_id: null }] });
    const req = keyReq();
    (req as unknown as { userId: string }).userId = USER;
    const result = await resolveSubOrgCaller(req);
    expect(result).toMatchObject({ ok: false, status: 409, error: 'ambiguous_caller' });
  });

  it('401s with no credential at all', async () => {
    mockDb({});
    const result = await resolveSubOrgCaller(anonReq());
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});

describe('resolveSubOrgCaller — JWT branch (SCRUM-5031)', () => {
  it('admits a profile-only ORG_ADMIN who holds NO org_members row', async () => {
    mockDb({
      memberships: [],
      profile: { org_id: PARENT, role: 'ORG_ADMIN', is_platform_admin: false },
    });
    const result = await resolveSubOrgCaller(jwtReq());
    expect(result).toMatchObject({ ok: true, value: { kind: 'user', userId: USER, orgId: PARENT } });
  });

  it('still refuses a caller with no membership row and no ORG_ADMIN profile', async () => {
    mockDb({ memberships: [], profile: { org_id: PARENT, role: 'MEMBER', is_platform_admin: false } });
    const result = await resolveSubOrgCaller(jwtReq());
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('503s when the profile fallback lookup itself fails', async () => {
    mockDb({ memberships: [], profileError: { message: 'boom' } });
    const result = await resolveSubOrgCaller(jwtReq());
    expect(result).toMatchObject({ ok: false, status: 503, error: 'membership_lookup_unavailable' });
  });

  it('does NOT consult profiles when org_members already answered — an explicit member row is an answer', async () => {
    // Regression pin for the scoping of the SCRUM-5031 fix: `mockDb` throws on
    // any table it was not given, so a stray `profiles` read fails this test
    // rather than silently changing the ambiguity arithmetic for every caller
    // who already has a membership row.
    mockDb({ memberships: [{ org_id: PARENT, role: 'member' }] });
    const result = await resolveSubOrgCaller(jwtReq());
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses to guess when the caller administers more than one organization', async () => {
    mockDb({ memberships: [{ org_id: PARENT, role: 'owner' }, { org_id: CHILD, role: 'owner' }] });
    const result = await resolveSubOrgCaller(jwtReq());
    expect(result).toMatchObject({ ok: false, status: 400, error: 'org_id_required' });
  });

  it('uses the explicit ?orgId= when given', async () => {
    mockDb({ memberships: [{ org_id: PARENT, role: 'owner' }] });
    const result = await resolveSubOrgCaller(jwtReq(USER, { orgId: PARENT }));
    expect(result).toMatchObject({ ok: true, value: { kind: 'user', orgId: PARENT } });
  });
});

describe('child resolution — 404 shaping on the key surface', () => {
  const approvedChild: OrgRow = {
    id: CHILD, public_id: 'child-pub', display_name: 'Child A',
    parent_org_id: PARENT, parent_approval_status: 'APPROVED', suspended: false,
  };

  it('resolves an approved, unsuspended child of the caller', async () => {
    mockDb({ organizations: [approvedChild] });
    const result = await resolveApprovedChild(KEY_CALLER, 'child-pub');
    expect(result).toMatchObject({
      ok: true,
      value: { id: CHILD, publicId: 'child-pub', displayName: 'Child A', suspended: false },
    });
  });

  it('404s an organization that is not a child of the caller', async () => {
    mockDb({ organizations: [{ ...approvedChild, parent_org_id: null }] });
    const result = await resolveApprovedChild(KEY_CALLER, 'child-pub');
    expect(result).toMatchObject({ ok: false, status: 404, error: 'sub_org_not_found' });
  });

  it("404s another parent's child — never 403, which would confirm it exists", async () => {
    mockDb({ organizations: [{ ...approvedChild, parent_org_id: OTHER_PARENT }] });
    const result = await resolveApprovedChild(KEY_CALLER, 'child-pub');
    expect(result).toMatchObject({ ok: false, status: 404, error: 'sub_org_not_found' });
  });

  it('404s a PENDING child for credits', async () => {
    mockDb({ organizations: [{ ...approvedChild, parent_approval_status: 'PENDING' }] });
    const result = await resolveApprovedChild(KEY_CALLER, 'child-pub');
    expect(result).toMatchObject({ ok: false, status: 404, error: 'sub_org_not_found' });
  });

  it('404s a NULL-status child for credits — NULL exists in this column and is not "approved"', async () => {
    mockDb({ organizations: [{ ...approvedChild, parent_approval_status: null }] });
    const result = await resolveApprovedChild(KEY_CALLER, 'child-pub');
    expect(result).toMatchObject({ ok: false, status: 404, error: 'sub_org_not_found' });
  });

  it('404s a REVOKED child for credits', async () => {
    mockDb({ organizations: [{ ...approvedChild, parent_approval_status: 'REVOKED' }] });
    const result = await resolveApprovedChild(KEY_CALLER, 'child-pub');
    expect(result).toMatchObject({ ok: false, status: 404, error: 'sub_org_not_found' });
  });

  it('404s a suspended child for credits but still resolves it for offboard', async () => {
    mockDb({ organizations: [{ ...approvedChild, suspended: true }] });
    await expect(resolveApprovedChild(KEY_CALLER, 'child-pub'))
      .resolves.toMatchObject({ ok: false, status: 404 });

    mockDb({ organizations: [{ ...approvedChild, suspended: true }] });
    await expect(resolveOwnedChild(KEY_CALLER, 'child-pub'))
      .resolves.toMatchObject({ ok: true, value: { id: CHILD, suspended: true } });
  });

  it('503s (never 404s) when the child lookup itself fails — an outage is not an absence', async () => {
    mockDb({ organizationsError: { message: 'boom' } });
    const result = await resolveApprovedChild(KEY_CALLER, 'child-pub');
    expect(result).toMatchObject({ ok: false, status: 503, error: 'sub_org_lookup_unavailable' });
  });
});

/**
 * The lifecycle reachability matrix. Every cell is a transition a parent can
 * legitimately want; a `false` cell that should be `true` is a stranded
 * affiliate, which is how the first cut of this surface made offboard→revoke
 * and revoke→offboard both unreachable.
 */
describe('lifecycle reachability — the predicate is per ACTION', () => {
  const child = (over: Partial<OrgRow> = {}): OrgRow => ({
    id: CHILD, public_id: 'child-pub', display_name: 'Child A',
    parent_org_id: PARENT, parent_approval_status: 'APPROVED', suspended: false,
    ...over,
  });

  type Resolver = typeof resolveApprovedChild;
  const RESOLVERS: Record<string, Resolver> = {
    approve: resolveChildForApprove,
    revoke: resolveChildForRevoke,
    credits: resolveApprovedChild,
    offboard: resolveOwnedChild,
  };

  // [status, suspended, action, addressable]
  const MATRIX: [string | null, boolean, keyof typeof RESOLVERS, boolean][] = [
    // PENDING: approve moves it on, revoke refuses the request, no money, and
    // offboard is legal (a parent may wind down a request it never approved).
    ['PENDING', false, 'approve', true],
    ['PENDING', false, 'revoke', true],
    ['PENDING', false, 'credits', false],
    ['PENDING', false, 'offboard', true],
    // APPROVED: the live relationship. Approve is not a transition from here.
    ['APPROVED', false, 'approve', false],
    ['APPROVED', false, 'revoke', true],
    ['APPROVED', false, 'credits', true],
    ['APPROVED', false, 'offboard', true],
    // APPROVED + suspended — the state offboard LEAVES behind. Revoke must
    // still work or offboard→revoke is unreachable.
    ['APPROVED', true, 'revoke', true],
    ['APPROVED', true, 'credits', false],
    ['APPROVED', true, 'offboard', true],
    // REVOKED: offboard must still work or revoke→offboard is unreachable and
    // the affiliate's credits are stranded.
    ['REVOKED', false, 'offboard', true],
    ['REVOKED', false, 'approve', false],
    ['REVOKED', false, 'revoke', false],
    ['REVOKED', false, 'credits', false],
    ['REVOKED', true, 'offboard', true],
    // NULL is a real value in this column, and it is not "approved".
    [null, false, 'approve', false],
    [null, false, 'credits', false],
    [null, false, 'offboard', true],
  ];

  it.each(MATRIX)(
    'status=%s suspended=%s action=%s -> addressable=%s',
    async (status, suspended, action, addressable) => {
      mockDb({ organizations: [child({ parent_approval_status: status, suspended })] });
      const result = await RESOLVERS[action](KEY_CALLER, 'child-pub');
      expect(result.ok).toBe(addressable);
      if (!result.ok) expect(result).toMatchObject({ status: 404, error: 'sub_org_not_found' });
    },
  );

  it('offboard then revoke: the suspended, still-APPROVED child stays revocable', async () => {
    mockDb({ organizations: [child({ suspended: true })] });
    await expect(resolveOwnedChild(KEY_CALLER, 'child-pub')).resolves.toMatchObject({ ok: true });
    mockDb({ organizations: [child({ suspended: true })] });
    await expect(resolveChildForRevoke(KEY_CALLER, 'child-pub')).resolves.toMatchObject({ ok: true });
  });

  it('revoke then offboard: the REVOKED child stays offboardable', async () => {
    mockDb({ organizations: [child({ parent_approval_status: 'REVOKED' })] });
    await expect(resolveChildForRevoke(KEY_CALLER, 'child-pub'))
      .resolves.toMatchObject({ ok: false, status: 404 });
    mockDb({ organizations: [child({ parent_approval_status: 'REVOKED' })] });
    await expect(resolveOwnedChild(KEY_CALLER, 'child-pub')).resolves.toMatchObject({ ok: true });
  });
});

describe('subOrgAuditActor', () => {
  it('records a user caller as the actor_id', () => {
    expect(subOrgAuditActor({ kind: 'user', userId: USER, orgId: PARENT })).toEqual({
      actorId: USER,
      actor: { actor_kind: 'user', actor_user_id: USER },
    });
  });

  it('records an API-key caller with a NULL actor_id — actor_id is FK-bound to profiles', () => {
    expect(subOrgAuditActor(KEY_CALLER)).toEqual({
      actorId: null,
      actor: { actor_kind: 'api_key', actor_api_key_id: KEY_ID, actor_key_prefix: 'ak_live_65aa' },
    });
  });
});
