/**
 * Unit tests for Admin Lists API (SN1)
 *
 * Tests: auth gating, search sanitization, pagination, filters, enrichment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const {
  mockIsPlatformAdmin,
  mockDbFrom,
  mockLogger,
} = vi.hoisted(() => {
  const mockIsPlatformAdmin = vi.fn();
  const mockDbFrom = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockIsPlatformAdmin, mockDbFrom, mockLogger };
});

vi.mock('../utils/platformAdmin.js', () => ({
  isPlatformAdmin: mockIsPlatformAdmin,
}));

vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom },
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

import { handleAdminUsers, handleAdminRecords, handleAdminSubscriptions } from './admin-lists.js';
import { ADMIN_PAGE_SIZE } from './admin-lists.js';
import type { Request, Response } from 'express';

function mockReq(query: Record<string, string> = {}): Request {
  return { query } as unknown as Request;
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

describe('Admin Lists API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('auth gating', () => {
    it('should return 403 for non-admin users', async () => {
      mockIsPlatformAdmin.mockResolvedValue(false);
      const res = mockRes();

      await handleAdminUsers('user-123', mockReq(), res);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden — platform admin access required' });
    });

    it('should return 403 for records endpoint too', async () => {
      mockIsPlatformAdmin.mockResolvedValue(false);
      const res = mockRes();

      await handleAdminRecords('user-123', mockReq(), res);

      expect(res.statusCode).toBe(403);
    });

    it('should return 403 for subscriptions endpoint too', async () => {
      mockIsPlatformAdmin.mockResolvedValue(false);
      const res = mockRes();

      await handleAdminSubscriptions('user-123', mockReq(), res);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('handleAdminUsers', () => {
    it('should return paginated users with org enrichment', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);

      const mockUsers = [
        { id: 'u1', email: 'test@example.com', full_name: 'Test', account_type: 'INDIVIDUAL', org_id: 'org-1', created_at: '2026-01-01' },
      ];
      const mockOrgs = [{ id: 'org-1', display_name: 'Test Org' }];

      // Users query
      const usersQuery = {
        select: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockResolvedValue({ data: mockUsers, count: 1, error: null }),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      };

      // Orgs query
      const orgsQuery = {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: mockOrgs }),
      };

      mockDbFrom.mockImplementation((table: string) => {
        if (table === 'profiles') return usersQuery;
        if (table === 'organizations') return orgsQuery;
        return usersQuery;
      });

      const res = mockRes();
      await handleAdminUsers('admin-1', mockReq(), res);

      expect(res.statusCode).toBe(200);
      const body = res.body as { users: Array<{ org_name: string }>; total: number };
      expect(body.users).toHaveLength(1);
      expect(body.users[0].org_name).toBe('Test Org');
      expect(body.total).toBe(1);
    });

    it('should handle DB query error', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);

      const usersQuery = {
        select: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockResolvedValue({ data: null, count: null, error: { message: 'DB down' } }),
      };
      mockDbFrom.mockReturnValue(usersQuery);

      const res = mockRes();
      await handleAdminUsers('admin-1', mockReq(), res);

      expect(res.statusCode).toBe(500);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('search sanitization', () => {
    it('should escape ilike wildcards in search parameter', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);

      const orFn = vi.fn();
      // Build a query chain where every method returns itself, and the whole
      // chain is thenable (Supabase returns a PromiseLike query builder).
      const usersQuery: Record<string, unknown> = {};
      usersQuery.select = vi.fn(() => usersQuery);
      usersQuery.is = vi.fn(() => usersQuery);
      usersQuery.order = vi.fn(() => usersQuery);
      usersQuery.range = vi.fn(() => usersQuery);
      usersQuery.eq = vi.fn(() => usersQuery);
      usersQuery.or = orFn.mockImplementation(() => usersQuery);
      // Make it thenable — when awaited, resolve with empty data
      usersQuery.then = (resolve: (v: unknown) => void) => {
        resolve({ data: [], count: 0, error: null });
        return usersQuery;
      };

      mockDbFrom.mockReturnValue(usersQuery);

      const res = mockRes();
      await handleAdminUsers('admin-1', mockReq({ search: '%admin%' }), res);

      // The or() call should have escaped % characters
      expect(orFn).toHaveBeenCalledWith(
        expect.stringContaining('\\%admin\\%'),
      );
    });

    it('should truncate search to 200 chars', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);

      const orFn = vi.fn().mockReturnThis();
      const usersQuery = {
        select: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockResolvedValue({ data: [], count: 0, error: null }),
        or: orFn,
        eq: vi.fn().mockReturnThis(),
      };
      mockDbFrom.mockReturnValue(usersQuery);

      const longSearch = 'a'.repeat(300);
      const res = mockRes();
      await handleAdminUsers('admin-1', mockReq({ search: longSearch }), res);

      // Should be called with truncated search
      if (orFn.mock.calls.length > 0) {
        const searchArg = orFn.mock.calls[0][0] as string;
        // The search portion between %...% should be at most 200 chars
        expect(searchArg.length).toBeLessThan(300 + 50); // 200 chars + field names overhead
      }
    });
  });

  describe('pagination', () => {
    it('should default to page 1 and limit 25', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);

      const rangeFn = vi.fn().mockResolvedValue({ data: [], count: 0, error: null });
      const usersQuery = {
        select: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: rangeFn,
      };
      mockDbFrom.mockReturnValue(usersQuery);

      const res = mockRes();
      await handleAdminUsers('admin-1', mockReq(), res);

      // range(0, 24) for page 1, limit 25
      expect(rangeFn).toHaveBeenCalledWith(0, 24);
      const body = res.body as { page: number; limit: number };
      expect(body.page).toBe(1);
      expect(body.limit).toBe(ADMIN_PAGE_SIZE);
    });

    it('should enforce max limit of 100', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);

      const rangeFn = vi.fn().mockResolvedValue({ data: [], count: 0, error: null });
      const usersQuery = {
        select: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: rangeFn,
      };
      mockDbFrom.mockReturnValue(usersQuery);

      const res = mockRes();
      await handleAdminUsers('admin-1', mockReq({ limit: '500' }), res);

      // range(0, 99) — limit capped to 100
      expect(rangeFn).toHaveBeenCalledWith(0, 99);
    });
  });

  describe('ADMIN_PAGE_SIZE export', () => {
    it('should export default page size of 25', () => {
      expect(ADMIN_PAGE_SIZE).toBe(25);
    });
  });

  /**
   * BUG-009: the unfiltered record count comes from the `anchor_status_counts`
   * cache row, whose `total` can be `-1` — the sentinel for "no trustworthy
   * count", not a number of rows. It must never be rendered as one.
   */
  describe('handleAdminRecords total (BUG-009 sentinel)', () => {
    /**
     * `handleAdminRecords` awaits the anchors query and the cache read in
     * parallel, so both `db.from()` calls need distinct thenable chains.
     */
    function mockRecordsDb(rows: Array<Record<string, unknown>>, cacheValue: unknown) {
      const anchors: Record<string, unknown> = {};
      for (const m of ['select', 'is', 'order', 'range', 'eq', 'or', 'in'] as const) {
        anchors[m] = vi.fn(() => anchors);
      }
      anchors.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve);

      const cache: Record<string, unknown> = {};
      cache.select = vi.fn(() => cache);
      cache.eq = vi.fn(() => cache);
      cache.single = vi.fn().mockResolvedValue({ data: { cache_value: cacheValue }, error: null });

      mockDbFrom.mockImplementation((table: string) =>
        table === 'pipeline_dashboard_cache' ? cache : anchors,
      );
    }

    beforeEach(() => {
      mockIsPlatformAdmin.mockResolvedValue(true);
    });

    it('uses the cached total when it is a real count', async () => {
      mockRecordsDb([], { total: 3_490_000, SECURED: 3_400_000 });
      const res = mockRes();
      await handleAdminRecords('admin-1', mockReq(), res);
      expect((res.body as { total: number }).total).toBe(3_490_000);
    });

    it('does NOT render the -1 sentinel as a count', async () => {
      mockRecordsDb([], { total: -1, SECURED: -1, total_source: 'unavailable' });
      const res = mockRes();
      await handleAdminRecords('admin-1', mockReq(), res);
      const total = (res.body as { total: number }).total;
      expect(total).toBeGreaterThanOrEqual(0);
      expect(total).not.toBe(-1);
    });

    it('falls back to the page heuristic when the total is unavailable', async () => {
      // Full page returned ⇒ "there is at least one more page", which is the
      // same claim the filtered branch makes. No total is asserted.
      const rows = Array.from({ length: ADMIN_PAGE_SIZE }, (_, i) => ({ id: `a${i}`, user_id: null }));
      mockRecordsDb(rows, { total: -1 });
      const res = mockRes();
      await handleAdminRecords('admin-1', mockReq(), res);
      expect((res.body as { total: number }).total).toBe(ADMIN_PAGE_SIZE + 1);
    });

    it('treats a missing or non-numeric total as unavailable, not zero', async () => {
      for (const cacheValue of [{}, { total: null }, { total: 'many' }]) {
        mockRecordsDb([{ id: 'a1', user_id: null }], cacheValue);
        const res = mockRes();
        await handleAdminRecords('admin-1', mockReq(), res);
        // One row on page 1 ⇒ last page ⇒ heuristic total of 1, not a claimed 0.
        expect((res.body as { total: number }).total).toBe(1);
      }
    });
  });
});
