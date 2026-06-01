/**
 * Unit tests for Admin Org Members API (platform-admin org roster bugfix)
 *
 * A platform admin viewing an org they do NOT belong to was getting "0 members"
 * and "No user found" because the browser queried Supabase under RLS, which has
 * no platform-admin bypass on org_members / profiles. These worker endpoints use
 * the service_role db client (bypasses RLS) and are gated on isPlatformAdmin().
 *
 * Tests: auth gating (403 for non-admin on every endpoint), roster listing,
 * user search by email, add-member (org_members insert + profiles backfill +
 * audit row), validation, and the already-member guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks (mirror admin-lists.test.ts) ----
const { mockIsPlatformAdmin, mockDbFrom, mockLogger } = vi.hoisted(() => {
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

import {
  handleAdminOrgMembers,
  handleAdminUserSearch,
  handleAdminAddOrgMember,
} from './admin-org-members.js';
import type { Request, Response } from 'express';

function mockReq(
  query: Record<string, string> = {},
  body: Record<string, unknown> = {},
): Request {
  return { query, body } as unknown as Request;
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

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_USER = '22222222-2222-2222-2222-222222222222';

describe('Admin Org Members API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('auth gating', () => {
    it('handleAdminOrgMembers returns 403 for non-admin', async () => {
      mockIsPlatformAdmin.mockResolvedValue(false);
      const res = mockRes();
      await handleAdminOrgMembers('user-123', ORG_ID, mockReq(), res);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden — platform admin access required' });
      // Must not touch the DB before the gate
      expect(mockDbFrom).not.toHaveBeenCalled();
    });

    it('handleAdminUserSearch returns 403 for non-admin', async () => {
      mockIsPlatformAdmin.mockResolvedValue(false);
      const res = mockRes();
      await handleAdminUserSearch('user-123', mockReq({ email: 'x@y.com' }), res);
      expect(res.statusCode).toBe(403);
      expect(mockDbFrom).not.toHaveBeenCalled();
    });

    it('handleAdminAddOrgMember returns 403 for non-admin', async () => {
      mockIsPlatformAdmin.mockResolvedValue(false);
      const res = mockRes();
      await handleAdminAddOrgMember(
        'user-123',
        ORG_ID,
        mockReq({}, { user_id: TARGET_USER, role: 'INDIVIDUAL' }),
        res,
      );
      expect(res.statusCode).toBe(403);
      expect(mockDbFrom).not.toHaveBeenCalled();
    });
  });

  describe('handleAdminOrgMembers (roster)', () => {
    it('returns the org roster mapped to Member shape', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);

      const rows = [
        {
          id: 'u1',
          email: 'owner@acme.com',
          full_name: 'Owner One',
          avatar_url: null,
          role: 'ORG_ADMIN',
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'u2',
          email: 'member@acme.com',
          full_name: null,
          avatar_url: 'https://x/y.png',
          role: 'INDIVIDUAL',
          created_at: '2026-01-02T00:00:00Z',
        },
      ];

      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
      };
      mockDbFrom.mockReturnValue(query);

      const res = mockRes();
      await handleAdminOrgMembers('admin-1', ORG_ID, mockReq(), res);

      expect(res.statusCode).toBe(200);
      // Scoped to the requested org and excludes soft-deleted rows
      expect(query.eq).toHaveBeenCalledWith('org_id', ORG_ID);
      expect(query.is).toHaveBeenCalledWith('deleted_at', null);

      const body = res.body as { members: Array<Record<string, unknown>> };
      expect(body.members).toHaveLength(2);
      expect(body.members[0]).toEqual({
        id: 'u1',
        email: 'owner@acme.com',
        fullName: 'Owner One',
        avatarUrl: null,
        role: 'ORG_ADMIN',
        joinedAt: '2026-01-01T00:00:00Z',
        status: 'active',
      });
      expect(body.members[1].role).toBe('INDIVIDUAL');
    });

    it('returns 500 on DB error', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
      };
      mockDbFrom.mockReturnValue(query);

      const res = mockRes();
      await handleAdminOrgMembers('admin-1', ORG_ID, mockReq(), res);
      expect(res.statusCode).toBe(500);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('returns 400 for a malformed org id', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const res = mockRes();
      await handleAdminOrgMembers('admin-1', 'not-a-uuid', mockReq(), res);
      expect(res.statusCode).toBe(400);
      expect(mockDbFrom).not.toHaveBeenCalled();
    });
  });

  describe('handleAdminUserSearch', () => {
    it('returns the matched user (id, email, full_name)', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [{ id: TARGET_USER, email: 'found@acme.com', full_name: 'Found User' }],
          error: null,
        }),
      };
      mockDbFrom.mockReturnValue(query);

      const res = mockRes();
      await handleAdminUserSearch('admin-1', mockReq({ email: 'Found@Acme.com ' }), res);

      expect(res.statusCode).toBe(200);
      // Email is normalized (trim + lowercase) for the exact-match lookup
      expect(query.eq).toHaveBeenCalledWith('email', 'found@acme.com');
      const body = res.body as { user: { id: string; email: string; full_name: string | null } | null };
      expect(body.user).toEqual({ id: TARGET_USER, email: 'found@acme.com', full_name: 'Found User' });
    });

    it('returns 200 with user: null when no match', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
      mockDbFrom.mockReturnValue(query);

      const res = mockRes();
      await handleAdminUserSearch('admin-1', mockReq({ email: 'nobody@acme.com' }), res);
      expect(res.statusCode).toBe(200);
      expect((res.body as { user: unknown }).user).toBeNull();
    });

    it('returns 400 when email is missing or blank', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const res = mockRes();
      await handleAdminUserSearch('admin-1', mockReq({ email: '   ' }), res);
      expect(res.statusCode).toBe(400);
      expect(mockDbFrom).not.toHaveBeenCalled();
    });
  });

  describe('handleAdminAddOrgMember', () => {
    it('inserts org_members, backfills profile org, writes audit row, returns 200', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);

      // profiles existence/lookup
      const profileSelect = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { id: TARGET_USER, email: 'found@acme.com', full_name: 'Found User', org_id: null },
          error: null,
        }),
      };
      // org_members already-member check
      const memberSelect = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
      const memberInsert = { insert: vi.fn().mockResolvedValue({ error: null }) };
      const profileUpdate = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({ error: null }),
      };
      const auditInsert = { insert: vi.fn().mockResolvedValue({ error: null }) };

      // org_members is touched twice: SELECT (already-member) then INSERT.
      let orgMembersCall = 0;
      mockDbFrom.mockImplementation((table: string) => {
        if (table === 'profiles') {
          // first profiles call = existence lookup, second = backfill update
          return profileSelect.maybeSingle.mock.calls.length === 0 ? profileSelect : profileUpdate;
        }
        if (table === 'org_members') {
          orgMembersCall += 1;
          return orgMembersCall === 1 ? memberSelect : memberInsert;
        }
        if (table === 'audit_events') return auditInsert;
        throw new Error(`unexpected table ${table}`);
      });

      const res = mockRes();
      await handleAdminAddOrgMember(
        'admin-1',
        ORG_ID,
        mockReq({}, { user_id: TARGET_USER, role: 'ORG_ADMIN' }),
        res,
      );

      expect(res.statusCode).toBe(200);
      // org_members insert uses the org_member_role enum (admin), not the profiles enum
      expect(memberInsert.insert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: TARGET_USER, org_id: ORG_ID, role: 'admin' }),
      );
      // audit row recorded
      expect(auditInsert.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'MEMBER_ADDED',
          actor_id: 'admin-1',
          org_id: ORG_ID,
          target_id: TARGET_USER,
        }),
      );
      expect((res.body as { success: boolean }).success).toBe(true);
    });

    it('returns 404 when the target user does not exist', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const profileSelect = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
      mockDbFrom.mockReturnValue(profileSelect);

      const res = mockRes();
      await handleAdminAddOrgMember(
        'admin-1',
        ORG_ID,
        mockReq({}, { user_id: TARGET_USER, role: 'INDIVIDUAL' }),
        res,
      );
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when the user is already a member', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const profileSelect = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { id: TARGET_USER, email: 'a@b.com', full_name: null, org_id: ORG_ID },
          error: null,
        }),
      };
      const memberSelect = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'm1' }, error: null }),
      };
      mockDbFrom.mockImplementation((table: string) => {
        if (table === 'profiles') return profileSelect;
        if (table === 'org_members') return memberSelect;
        throw new Error(`unexpected table ${table}`);
      });

      const res = mockRes();
      await handleAdminAddOrgMember(
        'admin-1',
        ORG_ID,
        mockReq({}, { user_id: TARGET_USER, role: 'INDIVIDUAL' }),
        res,
      );
      expect(res.statusCode).toBe(409);
    });

    it('returns 400 for an invalid role', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const res = mockRes();
      await handleAdminAddOrgMember(
        'admin-1',
        ORG_ID,
        mockReq({}, { user_id: TARGET_USER, role: 'SUPERUSER' }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(mockDbFrom).not.toHaveBeenCalled();
    });

    it('returns 400 for a malformed user_id', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const res = mockRes();
      await handleAdminAddOrgMember(
        'admin-1',
        ORG_ID,
        mockReq({}, { user_id: 'nope', role: 'INDIVIDUAL' }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(mockDbFrom).not.toHaveBeenCalled();
    });

    it('returns 400 for a malformed org id', async () => {
      mockIsPlatformAdmin.mockResolvedValue(true);
      const res = mockRes();
      await handleAdminAddOrgMember(
        'admin-1',
        'not-a-uuid',
        mockReq({}, { user_id: TARGET_USER, role: 'INDIVIDUAL' }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(mockDbFrom).not.toHaveBeenCalled();
    });
  });
});
