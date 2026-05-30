/**
 * Unit tests for Platform Stats API (admin-stats.ts)
 *
 * Tests: auth gating, RPC call to get_anchor_status_counts_fast,
 * fallback behavior when RPC fails, response shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const {
  mockIsPlatformAdmin,
  mockDbFrom,
  mockDbRpc,
  mockLogger,
} = vi.hoisted(() => {
  const mockIsPlatformAdmin = vi.fn();
  const mockDbFrom = vi.fn();
  const mockDbRpc = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockIsPlatformAdmin, mockDbFrom, mockDbRpc, mockLogger };
});

vi.mock('../utils/platformAdmin.js', () => ({
  isPlatformAdmin: mockIsPlatformAdmin,
}));

vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom, rpc: mockDbRpc },
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

import { handlePlatformStats } from './admin-stats.js';
import type { Request, Response } from 'express';

function mockReq(): Request {
  return {} as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe('handlePlatformStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 for non-admin users', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = mockRes();
    await handlePlatformStats('user-123', mockReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden — platform admin access required' });
  });

  it('calls get_anchor_status_counts_fast RPC', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true);

    const rpcData = {
      PENDING: 50,
      SUBMITTED: 10,
      BROADCASTING: 5,
      SECURED: 1280000,
      REVOKED: 100,
      total: 1280165,
    };

    mockDbRpc.mockImplementation((name: string) => {
      if (name === 'get_anchor_status_counts_fast') {
        return { data: rpcData, error: null };
      }
      if (name === 'get_anchor_tx_stats') {
        return { data: {}, error: null };
      }
      return { data: null, error: null };
    });

    const chain = {
      select: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => void) => resolve({ count: 10, data: [], error: null }),
    };
    mockDbFrom.mockReturnValue(chain);

    const res = mockRes();
    await handlePlatformStats('admin-user', mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockDbRpc).toHaveBeenCalledWith('get_anchor_status_counts_fast');

    const body = res.body as { anchors: { total: number; byStatus: Record<string, number> } };
    expect(body.anchors.byStatus.SECURED).toBe(1280000);
    expect(body.anchors.byStatus.PENDING).toBe(50);
    expect(body.anchors.total).toBe(1280165);
  });

  it('falls back to direct queries when RPC fails', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true);

    // RPC fails for anchor counts, succeeds for tx stats
    mockDbRpc.mockImplementation((name: string) => {
      if (name === 'get_anchor_status_counts_fast') {
        return { data: null, error: { message: 'function not found' } };
      }
      if (name === 'get_anchor_tx_stats') {
        return { data: {}, error: null };
      }
      return { data: null, error: null };
    });

    // All .from() queries resolve with count: 5
    const fallbackChain = {
      select: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => void) => resolve({ count: 5, data: [], error: null }),
    };
    mockDbFrom.mockReturnValue(fallbackChain);

    const res = mockRes();
    await handlePlatformStats('admin-user', mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.anything() }),
      expect.stringContaining('RPC failed'),
    );
  });

  it('includes subscription plan counts', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true);

    mockDbRpc.mockImplementation((name: string) => {
      if (name === 'get_anchor_status_counts_fast') {
        return { data: { SECURED: 100, total: 100, PENDING: 0, SUBMITTED: 0, BROADCASTING: 0, REVOKED: 0 }, error: null };
      }
      return { data: {}, error: null };
    });

    // Track which table is queried
    mockDbFrom.mockImplementation((table: string) => {
      const subData = table === 'subscriptions'
        ? [
            { plan_id: '1', plans: { name: 'Starter' } },
            { plan_id: '1', plans: { name: 'Starter' } },
            { plan_id: '2', plans: { name: 'Professional' } },
          ]
        : [];
      const chain = {
        select: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        then: (resolve: (v: unknown) => void) => resolve({ count: 3, data: subData, error: null }),
      };
      return chain;
    });

    const res = mockRes();
    await handlePlatformStats('admin-user', mockReq(), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { subscriptions: { byPlan: Record<string, number> } };
    expect(body.subscriptions.byPlan.Starter).toBe(2);
    expect(body.subscriptions.byPlan.Professional).toBe(1);
  });

  // SCRUM-1984: the organizations table has NO `deleted_at` column in prod.
  // The original query filtered `.is('deleted_at', null)` on it; PostgREST
  // resolves (does not throw) with `{ count: null, error: <column missing> }`,
  // so the handler silently reported Total Orgs = 0 despite real orgs existing.
  it('counts all organizations and does not filter a non-existent deleted_at column (SCRUM-1984)', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true);

    mockDbRpc.mockImplementation((name: string) => {
      if (name === 'get_anchor_status_counts_fast') {
        return { data: { SECURED: 100, total: 100, PENDING: 0, SUBMITTED: 0, BROADCASTING: 0, REVOKED: 0 }, error: null };
      }
      return { data: {}, error: null };
    });

    // Simulate prod: an organizations query that applies `.is('deleted_at', …)`
    // errors and yields count: null; an unfiltered organizations query yields
    // the real count (3). profiles/anchors DO have deleted_at, so they count fine.
    mockDbFrom.mockImplementation((table: string) => {
      let deletedAtFiltered = false;
      const chain: Record<string, unknown> = {
        select: vi.fn().mockReturnThis(),
        is: vi.fn((col: string) => {
          if (col === 'deleted_at') deletedAtFiltered = true;
          return chain;
        }),
        gte: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
      };
      // Intentional thenable mock matching Supabase's PostgREST builder (awaitable mid-chain).
      Object.defineProperty(chain, 'then', { // NOSONAR — intentional thenable for Supabase mock
        value: (resolve: (v: unknown) => void) => {
          if (table === 'organizations') {
            return resolve(
              deletedAtFiltered
                ? { count: null, data: null, error: { message: 'column organizations.deleted_at does not exist' } }
                : { count: 3, data: [], error: null },
            );
          }
          return resolve({ count: 7, data: [], error: null });
        },
        configurable: true,
        writable: true,
      });
      return chain;
    });

    const res = mockRes();
    await handlePlatformStats('admin-user', mockReq(), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { organizations: { total: number } };
    expect(body.organizations.total).toBe(3);
  });
});
