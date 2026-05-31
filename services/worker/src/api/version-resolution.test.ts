/**
 * Tests for SCRUM-1971: Version Resolution API endpoints.
 *
 * GET  /api/v1/versions          -> list pending version reviews for caller's org
 * POST /api/v1/versions/:versionId/resolve -> resolve a version conflict
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock db + logger BEFORE importing the SUT so the SUT captures the mocked modules.
const fromMock = vi.fn();

vi.mock('../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  handleListVersions,
  handleResolveVersion,
  requireVersionOrgAdminContext,
  ResolveVersionInput,
} from './version-resolution.js';
import { logger } from '../utils/logger.js';

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

function mockReq(opts: {
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
  userId?: string;
  orgId?: string;
  orgRole?: string;
} = {}): Request {
  const req = {
    body: opts.body ?? {},
    query: opts.query ?? {},
    params: opts.params ?? {},
  } as unknown as Request;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).userId = opts.userId ?? undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).orgId = opts.orgId ?? undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).orgRole = opts.orgRole ?? undefined;
  return req;
}

/**
 * Helper: creates a chainable mock for db.from('table').select().eq().eq()...order().limit()
 */
function mockSelectChain(data: unknown, error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn().mockResolvedValue({ data, error }),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  return chain;
}

/**
 * Helper: creates a chainable mock for db.from('table').select().eq().eq().maybeSingle()
 */
function mockMaybeSingleChain(data: unknown, error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return chain;
}

/**
 * Helper: creates a chainable mock for db.from('table').update().eq().eq().select().single()
 */
function mockUpdateChain(data: unknown, error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    update: vi.fn(),
    eq: vi.fn(),
    select: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
  };
  chain.update.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  return chain;
}

/**
 * Helper: creates a chainable mock for db.from('table').insert()
 */
function mockInsertChain(data: unknown = null, error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    insert: vi.fn().mockResolvedValue({ data, error }),
    select: vi.fn(),
    single: vi.fn().mockResolvedValue({ data, error }),
  };
  chain.insert.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  return chain;
}

describe('ResolveVersionInput', () => {
  it('accepts approve decision', () => {
    const result = ResolveVersionInput.safeParse({ decision: 'approve' });
    expect(result.success).toBe(true);
  });

  it('accepts skip decision', () => {
    const result = ResolveVersionInput.safeParse({ decision: 'skip' });
    expect(result.success).toBe(true);
  });

  it('accepts flag decision with notes', () => {
    const result = ResolveVersionInput.safeParse({ decision: 'flag', notes: 'Suspicious change' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid decision', () => {
    const result = ResolveVersionInput.safeParse({ decision: 'delete' });
    expect(result.success).toBe(false);
  });

  it('rejects missing decision', () => {
    const result = ResolveVersionInput.safeParse({});
    expect(result.success).toBe(false);
  });

  it('caps notes at 2000 chars', () => {
    const result = ResolveVersionInput.safeParse({ decision: 'flag', notes: 'x'.repeat(2001) });
    expect(result.success).toBe(false);
  });
});

describe('handleListVersions', () => {
  beforeEach(() => fromMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('returns pending versions for callers org', async () => {
    const versions = [
      {
        id: 'v-1',
        external_file_id: 'file-abc',
        source: 'google_drive',
        fingerprint: 'fp123',
        version_number: 2,
        status: 'pending_review',
        metadata: { change: 'content_hash' },
        detected_at: '2026-05-15T10:00:00Z',
      },
    ];
    const chain = mockSelectChain(versions);
    fromMock.mockReturnValue(chain);

    const { res, json } = mockRes();
    await handleListVersions(
      mockReq({ userId: 'user-1', orgId: 'org-1', orgRole: 'admin' }),
      res,
    );

    expect(fromMock).toHaveBeenCalledWith('external_document_versions');
    expect(chain.eq).toHaveBeenCalledWith('org_id', 'org-1');
    expect(json).toHaveBeenCalledWith({ versions });
  });

  it('filters by status query parameter', async () => {
    const chain = mockSelectChain([]);
    fromMock.mockReturnValue(chain);

    const { res } = mockRes();
    await handleListVersions(
      mockReq({ userId: 'user-1', orgId: 'org-1', orgRole: 'admin', query: { status: 'approved' } }),
      res,
    );

    expect(chain.eq).toHaveBeenCalledWith('status', 'approved');
  });

  it('defaults to pending_review status filter', async () => {
    const chain = mockSelectChain([]);
    fromMock.mockReturnValue(chain);

    const { res } = mockRes();
    await handleListVersions(
      mockReq({ userId: 'user-1', orgId: 'org-1', orgRole: 'admin' }),
      res,
    );

    expect(chain.eq).toHaveBeenCalledWith('status', 'pending_review');
  });

  it('resolves org admin context when middleware only supplies userId', async () => {
    const versions = [{ id: 'v-1', external_file_id: 'file-abc' }];
    const versionsChain = mockSelectChain(versions);
    fromMock
      .mockReturnValueOnce(mockMaybeSingleChain({
        org_id: 'org-1',
        role: 'ORG_ADMIN',
        is_platform_admin: false,
      }))
      .mockReturnValueOnce(mockMaybeSingleChain({ role: 'admin' }))
      .mockReturnValueOnce(versionsChain);

    const { res, json } = mockRes();
    await handleListVersions(mockReq({ userId: 'user-1' }), res);

    expect(versionsChain.eq).toHaveBeenCalledWith('org_id', 'org-1');
    expect(json).toHaveBeenCalledWith({ versions });
  });

  it('returns 401 without auth (no userId)', async () => {
    const { res, status, json } = mockRes();
    await handleListVersions(mockReq(), res);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
  });

  it('returns 403 for non-admin', async () => {
    const { res, status, json } = mockRes();
    await handleListVersions(
      mockReq({ userId: 'user-1', orgId: 'org-1', orgRole: 'member' }),
      res,
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'Organization admin role required' },
    });
  });

  it('returns 500 when db query errors', async () => {
    const chain = mockSelectChain(null, { message: 'connection failed' });
    fromMock.mockReturnValue(chain);

    const { res, status, json } = mockRes();
    await handleListVersions(
      mockReq({ userId: 'user-1', orgId: 'org-1', orgRole: 'admin' }),
      res,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'internal', message: 'Failed to list versions' },
    });
  });
});

describe('requireVersionOrgAdminContext', () => {
  beforeEach(() => fromMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('attaches org admin context when only requireAuth userId is present', async () => {
    fromMock
      .mockReturnValueOnce(mockMaybeSingleChain({
        org_id: 'org-1',
        role: 'ORG_ADMIN',
        is_platform_admin: false,
      }))
      .mockReturnValueOnce(mockMaybeSingleChain({ role: 'admin' }));

    const req = mockReq({ userId: 'user-1' });
    const { res, status } = mockRes();
    const next = vi.fn();

    await requireVersionOrgAdminContext(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as { orgId?: string }).orgId).toBe('org-1');
    expect((req as unknown as { orgRole?: string }).orgRole).toBe('admin');
  });

  it('fails closed when user has no organization context', async () => {
    fromMock.mockReturnValueOnce(mockMaybeSingleChain({ org_id: null, role: null, is_platform_admin: false }));

    const { res, status, json } = mockRes();
    const next = vi.fn();

    await requireVersionOrgAdminContext(mockReq({ userId: 'user-1' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'Organization context required' },
    });
  });
});

// Fixed-format UUIDs for test fixtures (required after Zod UUID validation was added).
const VERSION_UUID = '11111111-1111-4111-a111-111111111111';
const VERSION_UUID_2 = '22222222-2222-4222-a222-222222222222';

describe('handleResolveVersion', () => {
  beforeEach(() => fromMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('returns 401 without auth', async () => {
    const { res, status, json } = mockRes();
    await handleResolveVersion(mockReq({ params: { versionId: VERSION_UUID } }), res);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
  });

  it('returns 403 for non-admin', async () => {
    const { res, status, json } = mockRes();
    await handleResolveVersion(
      mockReq({ userId: 'user-1', orgId: 'org-1', orgRole: 'member', params: { versionId: VERSION_UUID } }),
      res,
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'Organization admin role required' },
    });
  });

  it('returns 400 for invalid versionId (not a UUID)', async () => {
    const { res, status, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: 'not-a-uuid' },
        body: { decision: 'approve' },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'invalid_request' }),
    }));
  });

  it('returns 400 for invalid body', async () => {
    const { res, status, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: VERSION_UUID },
        body: { decision: 'destroy' },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'invalid_request' }),
    }));
  });

  it('returns 404 for unknown version', async () => {
    const chain = mockMaybeSingleChain(null);
    fromMock.mockReturnValue(chain);

    const { res, status, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: VERSION_UUID_2 },
        body: { decision: 'approve' },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'not_found', message: 'Version not found' },
    });
  });

  it('returns 404 when version belongs to a different org', async () => {
    // The query filters by org_id so a version from another org returns null
    const chain = mockMaybeSingleChain(null);
    fromMock.mockReturnValue(chain);

    const { res, status, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: VERSION_UUID_2 },
        body: { decision: 'approve' },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'not_found', message: 'Version not found' },
    });
  });

  it('approve: updates status and creates anchor', async () => {
    const versionRow = {
      id: VERSION_UUID,
      external_file_id: 'file-abc',
      fingerprint: 'fp-new-123',
      org_id: 'org-1',
      source: 'google_drive',
      metadata: {},
    };

    // 1st call: from('external_document_versions').select().eq().eq().maybeSingle() -> version lookup
    const lookupChain = mockMaybeSingleChain(versionRow);
    // 2nd call: from('external_document_versions').update() -> status update
    const updateChain = mockUpdateChain({ ...versionRow, status: 'approved' });
    // 3rd call: from('anchors').insert() -> create anchor
    const anchorInsertChain = mockInsertChain({ id: 'anchor-new', public_id: 'pid_new1' });
    // 4th call: link created anchor back to external_document_versions
    const anchorLinkUpdateChain = mockUpdateChain({ ...versionRow, status: 'approved', anchor_id: 'anchor-new' });
    // 5th call: from('version_reviews').insert() -> record review
    const reviewInsertChain = mockInsertChain();

    fromMock
      .mockReturnValueOnce(lookupChain)
      .mockReturnValueOnce(updateChain)
      .mockReturnValueOnce(anchorInsertChain)
      .mockReturnValueOnce(anchorLinkUpdateChain)
      .mockReturnValueOnce(reviewInsertChain);

    const { res, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: VERSION_UUID },
        body: { decision: 'approve' },
      }),
      res,
    );

    expect(json).toHaveBeenCalledWith({
      success: true,
      decision: 'approve',
      version_id: VERSION_UUID,
    });
    // Verify anchor was created
    expect(fromMock).toHaveBeenCalledWith('anchors');
    // Verify review was recorded
    expect(fromMock).toHaveBeenCalledWith('version_reviews');
  });

  it('returns 409 when the pending version update affects no rows', async () => {
    const versionRow = {
      id: VERSION_UUID,
      external_file_id: 'file-abc',
      fingerprint: 'fp-new-123',
      org_id: 'org-1',
      source: 'google_drive',
      metadata: {},
    };

    fromMock
      .mockReturnValueOnce(mockMaybeSingleChain(versionRow))
      .mockReturnValueOnce(mockUpdateChain(null));

    const { res, status, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: VERSION_UUID },
        body: { decision: 'approve' },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'conflict', message: 'Version was already resolved' },
    });
    expect(fromMock.mock.calls.some((c) => c[0] === 'anchors')).toBe(false);
  });

  it('logs when rollback fails after anchor creation failure', async () => {
    const versionRow = {
      id: VERSION_UUID,
      external_file_id: 'file-abc',
      fingerprint: 'fp-new-123',
      org_id: 'org-1',
      source: 'google_drive',
      metadata: {},
    };

    fromMock
      .mockReturnValueOnce(mockMaybeSingleChain(versionRow))
      .mockReturnValueOnce(mockUpdateChain({ id: VERSION_UUID }))
      .mockReturnValueOnce(mockInsertChain(null, { message: 'anchor insert failed' }))
      .mockReturnValueOnce(mockUpdateChain(null, { message: 'rollback failed' }));

    const { res, status } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: VERSION_UUID },
        body: { decision: 'approve' },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'rollback failed' }),
        versionId: VERSION_UUID,
        rollbackRestored: false,
      }),
      'Version status rollback failed after anchor creation failure',
    );
  });

  it('approve: stores the created anchor id on the approved version', async () => {
    const versionRow = {
      id: VERSION_UUID,
      external_file_id: 'file-abc',
      fingerprint: 'fp-new-123',
      org_id: 'org-1',
      source: 'google_drive',
      metadata: {},
    };

    const lookupChain = mockMaybeSingleChain(versionRow);
    const statusUpdateChain = mockUpdateChain({ ...versionRow, status: 'approved' });
    const anchorInsertChain = mockInsertChain({ id: 'anchor-new', public_id: 'pid_new1' });
    const anchorLinkUpdateChain = mockUpdateChain({ ...versionRow, status: 'approved', anchor_id: 'anchor-new' });
    const reviewInsertChain = mockInsertChain();

    fromMock
      .mockReturnValueOnce(lookupChain)
      .mockReturnValueOnce(statusUpdateChain)
      .mockReturnValueOnce(anchorInsertChain)
      .mockReturnValueOnce(anchorLinkUpdateChain)
      .mockReturnValueOnce(reviewInsertChain);

    const { res } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: VERSION_UUID },
        body: { decision: 'approve' },
      }),
      res,
    );

    expect(anchorLinkUpdateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ anchor_id: 'anchor-new' }),
    );
    expect(anchorLinkUpdateChain.eq).toHaveBeenCalledWith('id', VERSION_UUID);
    expect(anchorLinkUpdateChain.eq).toHaveBeenCalledWith('org_id', 'org-1');
  });

  it('skip: updates status without anchor creation', async () => {
    const versionRow = {
      id: VERSION_UUID,
      external_file_id: 'file-abc',
      fingerprint: 'fp-new-123',
      org_id: 'org-1',
      source: 'google_drive',
      metadata: {},
    };

    // 1st call: version lookup
    const lookupChain = mockMaybeSingleChain(versionRow);
    // 2nd call: status update
    const updateChain = mockUpdateChain({ ...versionRow, status: 'skipped' });
    // 3rd call: version_reviews insert (NO anchor insert for skip)
    const reviewInsertChain = mockInsertChain();

    fromMock
      .mockReturnValueOnce(lookupChain)
      .mockReturnValueOnce(updateChain)
      .mockReturnValueOnce(reviewInsertChain);

    const { res, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: VERSION_UUID },
        body: { decision: 'skip' },
      }),
      res,
    );

    expect(json).toHaveBeenCalledWith({
      success: true,
      decision: 'skip',
      version_id: VERSION_UUID,
    });
    // Should NOT have called anchors insert
    const anchorsCalls = fromMock.mock.calls.filter((c) => c[0] === 'anchors');
    expect(anchorsCalls).toHaveLength(0);
  });

  it('flag: updates status without anchor creation', async () => {
    const versionRow = {
      id: VERSION_UUID,
      external_file_id: 'file-abc',
      fingerprint: 'fp-new-123',
      org_id: 'org-1',
      source: 'google_drive',
      metadata: {},
    };

    // 1st call: version lookup
    const lookupChain = mockMaybeSingleChain(versionRow);
    // 2nd call: status update
    const updateChain = mockUpdateChain({ ...versionRow, status: 'flagged' });
    // 3rd call: version_reviews insert
    const reviewInsertChain = mockInsertChain();

    fromMock
      .mockReturnValueOnce(lookupChain)
      .mockReturnValueOnce(updateChain)
      .mockReturnValueOnce(reviewInsertChain);

    const { res, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: VERSION_UUID },
        body: { decision: 'flag', notes: 'Looks suspicious' },
      }),
      res,
    );

    expect(json).toHaveBeenCalledWith({
      success: true,
      decision: 'flag',
      version_id: VERSION_UUID,
    });
    // Should NOT have called anchors insert
    const anchorsCalls = fromMock.mock.calls.filter((c) => c[0] === 'anchors');
    expect(anchorsCalls).toHaveLength(0);
  });
});
