/**
 * Unit tests for GET /api/queue/pending (handleListPendingResolution).
 *
 * SCRUM-2213: the prior implementation called an RPC that read `auth.uid()`,
 * which is NULL under the worker's service-role client → "Profile not found" →
 * 500 on every request (Review Queue page hung on "Loading…"). The handler now
 * resolves the caller's org from the authenticated `callerUserId` and queries
 * org-scoped directly. These tests pin: auth gating, graceful empty state, the
 * `{items,count}` shape, sibling_count computed over the full pending set, and
 * that the display limit does not distort sibling_count.
 *
 * SCRUM-3569 (SEC): org-scoping alone was never the whole gate. The OpenAPI
 * contract has always tagged this route `OrgAdmin` / `OrgAdminBearer`, and the
 * route comment claimed the (since-removed) RPC enforced ORG_ADMIN — but after
 * SCRUM-2213 replaced that RPC with a direct query, ANY authenticated member of
 * an org could list every coworker's filenames + fingerprints. The
 * `describe('ORG_ADMIN authorization (SCRUM-3569)')` block below pins the gate,
 * every admissible admin signal, and the operational-error / true-negative split.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbFrom, mockLogger } = vi.hoisted(() => ({
  mockDbFrom: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const eqCalls: Array<[string, unknown]> = [];

vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/rpc.js', () => ({ callRpc: vi.fn() }));
vi.mock('../notifications/dispatcher.js', () => ({ emitOrgAdminNotifications: vi.fn() }));
vi.mock('../jobs/batch-anchor.js', () => ({ processBatchAnchors: vi.fn() }));
vi.mock('../jobs/org-queue-scheduler.js', () => ({ recordOrgQueueRunResult: vi.fn() }));
vi.mock('./rpc-error-status.js', () => ({ mapRpcErrorToStatus: vi.fn(() => 500) }));

import { handleListPendingResolution } from './queue-resolution.js';
import type { Request, Response } from 'express';

/** Chainable query mock: methods return the builder; `.maybeSingle()` resolves to
 *  `result`; the builder is thenable so an awaited terminal query resolves too. */
function chain(result: unknown | ((filters: Array<[string, unknown]>) => unknown)) {
  const builder: Record<string, unknown> = {};
  const filters: Array<[string, unknown]> = [];
  const pass = () => builder;
  for (const m of ['select', 'is', 'not', 'order', 'limit', 'gte', 'in']) builder[m] = pass;
  builder.eq = (column: string, value: unknown) => {
    eqCalls.push([column, value]);
    filters.push([column, value]);
    return builder;
  };
  const resolved = () => typeof result === 'function' ? result(filters) : result;
  builder.maybeSingle = () => Promise.resolve(resolved());
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(resolved()).then(resolve, reject);
  return builder;
}

function mockReq(query: Record<string, unknown> = {}): Request {
  return { query, headers: {} } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.body = data; return res; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function routeTables(map: Record<string, unknown>) {
  mockDbFrom.mockImplementation((table: string) => chain(map[table]));
}

function membershipByOrg(roles: Record<string, string | null>) {
  return (filters: Array<[string, unknown]>) => {
    const orgId = filters.find(([column]) => column === 'org_id')?.[1];
    const role = typeof orgId === 'string' ? roles[orgId] : null;
    return { data: role ? { role } : null, error: null };
  };
}

/**
 * Profile fixture used to prove profile role alone is not authoritative.
 */
function adminProfile(orgId: string | null) {
  return { data: { org_id: orgId, role: 'ORG_ADMIN', is_platform_admin: false }, error: null };
}

/** A rank-and-file member of `orgId`: no admin signal on any source. */
function memberProfile(orgId: string | null) {
  return { data: { org_id: orgId, role: 'ORG_MEMBER', is_platform_admin: false }, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0;
});

describe('handleListPendingResolution (GET /api/queue/pending)', () => {
  it('401s when no authenticated caller is provided', async () => {
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, undefined);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('authentication_required');
  });

  it('400s a malformed explicit organization before reading authorization tables', async () => {
    const res = mockRes();
    await handleListPendingResolution(mockReq({ org_id: 'not-a-uuid' }), res, 'user-1');
    expect(res.statusCode).toBe(400);
    expect(mockDbFrom).not.toHaveBeenCalled();
  });

  it('lets an exact secondary-org admin list that queue and scopes anchors to it', async () => {
    const parentOrg = '11111111-1111-4111-8111-111111111111';
    const childOrg = '22222222-2222-4222-8222-222222222222';
    routeTables({
      profiles: adminProfile(parentOrg),
      organizations: { data: { parent_org_id: null, parent_approval_status: null }, error: null },
      org_members: membershipByOrg({ [childOrg]: 'admin' }),
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq({ org_id: childOrg }), res, 'user-1');
    expect(res.statusCode).toBe(200);
    expect(eqCalls).toContainEqual(['org_id', childOrg]);
  });

  it('allows an exact-org admin whose profile has no primary organization', async () => {
    const selectedOrg = '22222222-2222-4222-8222-222222222222';
    routeTables({
      profiles: memberProfile(null),
      org_members: membershipByOrg({ [selectedOrg]: 'owner' }),
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq({ org_id: selectedOrg }), res, 'user-1');
    expect(res.statusCode).toBe(200);
    expect(eqCalls).toContainEqual(['org_id', selectedOrg]);
  });

  it('denies a primary-org admin who is only a member of the selected organization', async () => {
    const primaryOrg = '11111111-1111-4111-8111-111111111111';
    const selectedOrg = '22222222-2222-4222-8222-222222222222';
    routeTables({
      profiles: adminProfile(primaryOrg),
      org_members: membershipByOrg({ [selectedOrg]: 'member' }),
      organizations: { data: { parent_org_id: null, parent_approval_status: null }, error: null },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq({ org_id: selectedOrg }), res, 'user-1');
    expect(res.statusCode).toBe(403);
    expect(mockDbFrom).not.toHaveBeenCalledWith('anchors');
  });

  it('denies an unrelated explicit organization before reading anchors', async () => {
    const parentOrg = '11111111-1111-4111-8111-111111111111';
    const unrelatedOrg = '33333333-3333-4333-8333-333333333333';
    routeTables({
      profiles: adminProfile(parentOrg),
      organizations: { data: { parent_org_id: null, parent_approval_status: null }, error: null },
      org_members: { data: null, error: null },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq({ org_id: unrelatedOrg }), res, 'user-1');
    expect(res.statusCode).toBe(403);
    expect(mockDbFrom).not.toHaveBeenCalledWith('anchors');
  });

  it('500s when the profile lookup errors', async () => {
    routeTables({ profiles: { data: null, error: { message: 'db down' } } });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe('internal');
  });

  it('returns an empty queue (200) when the caller has no org', async () => {
    routeTables({ profiles: { data: { org_id: null }, error: null } });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ items: [], count: 0 });
  });

  it('500s when the anchors query errors', async () => {
    routeTables({
      profiles: adminProfile('org-1'),
      org_members: { data: { role: 'admin' }, error: null },
      anchors: { data: null, error: { message: 'timeout' } },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(500);
  });

  it('returns pending items with sibling_count computed over the full set', async () => {
    routeTables({
      profiles: adminProfile('org-1'),
      org_members: { data: { role: 'admin' }, error: null },
      anchors: {
        data: [
          { public_id: 'p1', metadata: { external_file_id: 'A' }, filename: 'f1', fingerprint: 'h1', created_at: '2026-05-30T03:00:00Z' },
          { public_id: 'p2', metadata: { external_file_id: 'A' }, filename: 'f2', fingerprint: 'h2', created_at: '2026-05-30T02:00:00Z' },
          { public_id: 'p3', metadata: { external_file_id: 'B' }, filename: 'f3', fingerprint: 'h3', created_at: '2026-05-30T01:00:00Z' },
          { public_id: 'p4', metadata: null, filename: null, fingerprint: 'h4', created_at: '2026-05-30T00:00:00Z' },
        ],
        error: null,
      },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(200);
    const body = res.body as { items: Array<{ public_id: string; external_file_id: string | null; sibling_count: number }>; count: number };
    expect(body.count).toBe(4);
    const byId = Object.fromEntries(body.items.map((i) => [i.public_id, i]));
    expect(byId.p1.sibling_count).toBe(1); // 'A' appears twice → 1 sibling
    expect(byId.p2.sibling_count).toBe(1);
    expect(byId.p3.sibling_count).toBe(0); // 'B' appears once
    expect(byId.p4.sibling_count).toBe(0); // no external_file_id
    expect(byId.p4.external_file_id).toBeNull();
  });

  it('applies the display limit but computes sibling_count over the full pending set', async () => {
    routeTables({
      profiles: adminProfile('org-1'),
      org_members: { data: { role: 'admin' }, error: null },
      anchors: {
        data: [
          { public_id: 'p1', metadata: { external_file_id: 'A' }, filename: 'f1', fingerprint: 'h1', created_at: '2026-05-30T03:00:00Z' },
          { public_id: 'p2', metadata: { external_file_id: 'A' }, filename: 'f2', fingerprint: 'h2', created_at: '2026-05-30T02:00:00Z' },
          { public_id: 'p3', metadata: { external_file_id: 'A' }, filename: 'f3', fingerprint: 'h3', created_at: '2026-05-30T01:00:00Z' },
        ],
        error: null,
      },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq({ limit: '2' }), res, 'user-1');
    expect(res.statusCode).toBe(200);
    const body = res.body as { items: Array<{ public_id: string; sibling_count: number }>; count: number };
    expect(body.count).toBe(2); // display limit
    expect(body.items.map((i) => i.public_id)).toEqual(['p1', 'p2']);
    // sibling_count reflects all 3 'A' rows (3 - 1 = 2), not just the 2 displayed.
    expect(body.items[0].sibling_count).toBe(2);
  });
});

/**
 * SCRUM-3569 (SEC) — GET /api/queue/pending must require ORG_ADMIN.
 *
 * The response body carries every pending anchor's `filename` and
 * `fingerprint`. Org scoping keeps that inside one tenant, but a rank-and-file
 * member has no business enumerating what their coworkers uploaded — and the
 * published OpenAPI contract (`openapi-ciba.ts`, tags `['Queue','OrgAdmin']`,
 * `security: [{ OrgAdminBearer: [] }]`) already promised this gate existed.
 *
 * These tests drive the real exact-membership queue resolver through the
 * table-dispatching `db` double; profile role alone must stay denied.
 */
describe('ORG_ADMIN authorization (SCRUM-3569)', () => {
  it('403s a plain org member and never reaches the anchors table', async () => {
    routeTables({
      profiles: memberProfile('org-1'),
      org_members: { data: { role: 'member' }, error: null },
      organizations: { data: null, error: null },
      anchors: {
        data: [
          { public_id: 'p1', metadata: { external_file_id: 'A' }, filename: 'payroll-2026.pdf', fingerprint: 'h1', created_at: '2026-05-30T03:00:00Z' },
        ],
        error: null,
      },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('forbidden');
    // Fail closed BEFORE the read: a denied caller must not cause the
    // coworker-filename query to run at all, let alone leak its rows.
    expect(mockDbFrom).not.toHaveBeenCalledWith('anchors');
    expect(JSON.stringify(res.body)).not.toContain('payroll-2026.pdf');
  });

  it('403s a member with no org_members row at all (no admin signal anywhere)', async () => {
    routeTables({
      profiles: memberProfile('org-1'),
      org_members: { data: null, error: null },
      organizations: { data: null, error: null },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(403);
    expect(mockDbFrom).not.toHaveBeenCalledWith('anchors');
  });

  it('allows an org_members owner', async () => {
    routeTables({
      profiles: memberProfile('org-1'),
      org_members: { data: { role: 'owner' }, error: null },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ items: [], count: 0 });
  });

  it('allows an org_members admin', async () => {
    routeTables({
      profiles: memberProfile('org-1'),
      org_members: { data: { role: 'admin' }, error: null },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(200);
  });

  it('denies a stale profile-level ORG_ADMIN without an authoritative membership', async () => {
    routeTables({
      profiles: adminProfile('org-1'),
      org_members: { data: null, error: null },
      organizations: { data: null, error: null },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(403);
    expect(mockDbFrom).not.toHaveBeenCalledWith('anchors');
  });

  it('allows a platform admin', async () => {
    routeTables({
      profiles: { data: { org_id: 'org-1', role: 'ORG_MEMBER', is_platform_admin: true }, error: null },
      org_members: { data: null, error: null },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(200);
  });

  it('500s (never a masked 403) when the admin lookup hits a DB error', async () => {
    routeTables({
      profiles: memberProfile('org-1'),
      org_members: { data: null, error: { message: 'org_members unavailable' } },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe('internal');
    expect(mockDbFrom).not.toHaveBeenCalledWith('anchors');
  });

  it('resolves admin status WITHOUT a second profiles round-trip', async () => {
    routeTables({
      profiles: adminProfile('org-1'),
      org_members: { data: { role: 'admin' }, error: null },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(200);
    // The handler already loaded the profile; it must hand that row to
    // the exact membership check rather than re-fetching it.
    const profileReads = mockDbFrom.mock.calls.filter(([t]) => t === 'profiles');
    expect(profileReads).toHaveLength(1);
  });

  it('403 copy carries no banned terminology (§1.3 — AnchorQueuePage renders it verbatim)', async () => {
    routeTables({
      profiles: memberProfile('org-1'),
      org_members: { data: null, error: null },
      anchors: { data: [], error: null },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    const message = (res.body as { error: { message: string } }).error.message;
    expect(message.length).toBeGreaterThan(0);
    // AnchorQueuePage.tsx's fetchPending() throws `body.error.message` and
    // renders it via setError — worker-assembled, but user-facing UI copy.
    expect(message).not.toMatch(
      /wallet|gas|hash|block|transaction|crypto|blockchain|bitcoin|testnet|mainnet|utxo|broadcast/i,
    );
  });
});
