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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbFrom, mockLogger } = vi.hoisted(() => ({
  mockDbFrom: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
function chain(result: unknown) {
  const builder: Record<string, unknown> = {};
  const pass = () => builder;
  for (const m of ['select', 'eq', 'is', 'not', 'order', 'limit', 'gte', 'in']) builder[m] = pass;
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
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

beforeEach(() => vi.clearAllMocks());

describe('handleListPendingResolution (GET /api/queue/pending)', () => {
  it('401s when no authenticated caller is provided', async () => {
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, undefined);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('authentication_required');
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
      profiles: { data: { org_id: 'org-1' }, error: null },
      anchors: { data: null, error: { message: 'timeout' } },
    });
    const res = mockRes();
    await handleListPendingResolution(mockReq(), res, 'user-1');
    expect(res.statusCode).toBe(500);
  });

  it('returns pending items with sibling_count computed over the full set', async () => {
    routeTables({
      profiles: { data: { org_id: 'org-1' }, error: null },
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
      profiles: { data: { org_id: 'org-1' }, error: null },
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
