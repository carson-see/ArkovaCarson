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
  ResolveVersionInput,
} from './version-resolution.js';

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

describe('handleResolveVersion', () => {
  beforeEach(() => fromMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('returns 401 without auth', async () => {
    const { res, status, json } = mockRes();
    await handleResolveVersion(mockReq({ params: { versionId: 'v-1' } }), res);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
  });

  it('returns 403 for non-admin', async () => {
    const { res, status, json } = mockRes();
    await handleResolveVersion(
      mockReq({ userId: 'user-1', orgId: 'org-1', orgRole: 'member', params: { versionId: 'v-1' } }),
      res,
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'Organization admin role required' },
    });
  });

  it('returns 400 for invalid body', async () => {
    const { res, status, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: 'v-1' },
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
        params: { versionId: 'v-nonexistent' },
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
        params: { versionId: 'v-other-org' },
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
      id: 'v-1',
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
    // 4th call: from('version_reviews').insert() -> record review
    const reviewInsertChain = mockInsertChain();

    fromMock
      .mockReturnValueOnce(lookupChain)
      .mockReturnValueOnce(updateChain)
      .mockReturnValueOnce(anchorInsertChain)
      .mockReturnValueOnce(reviewInsertChain);

    const { res, json } = mockRes();
    await handleResolveVersion(
      mockReq({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        params: { versionId: 'v-1' },
        body: { decision: 'approve' },
      }),
      res,
    );

    expect(json).toHaveBeenCalledWith({
      success: true,
      decision: 'approve',
      version_id: 'v-1',
    });
    // Verify anchor was created
    expect(fromMock).toHaveBeenCalledWith('anchors');
    // Verify review was recorded
    expect(fromMock).toHaveBeenCalledWith('version_reviews');
  });

  it('skip: updates status without anchor creation', async () => {
    const versionRow = {
      id: 'v-1',
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
        params: { versionId: 'v-1' },
        body: { decision: 'skip' },
      }),
      res,
    );

    expect(json).toHaveBeenCalledWith({
      success: true,
      decision: 'skip',
      version_id: 'v-1',
    });
    // Should NOT have called anchors insert
    const anchorsCalls = fromMock.mock.calls.filter((c) => c[0] === 'anchors');
    expect(anchorsCalls).toHaveLength(0);
  });

  it('flag: updates status without anchor creation', async () => {
    const versionRow = {
      id: 'v-1',
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
        params: { versionId: 'v-1' },
        body: { decision: 'flag', notes: 'Looks suspicious' },
      }),
      res,
    );

    expect(json).toHaveBeenCalledWith({
      success: true,
      decision: 'flag',
      version_id: 'v-1',
    });
    // Should NOT have called anchors insert
    const anchorsCalls = fromMock.mock.calls.filter((c) => c[0] === 'anchors');
    expect(anchorsCalls).toHaveLength(0);
  });
});
