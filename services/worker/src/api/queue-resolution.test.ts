/**
 * Tests for ARK-101 queue resolution API (SCRUM-1011).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock db + logger BEFORE importing the SUT so the SUT captures the mocked modules.
const rpcMock = vi.fn();
const fromMock = vi.fn();
const emitOrgAdminNotificationsMock = vi.fn();
const processBatchAnchorsMock = vi.fn();

vi.mock('../utils/db.js', () => ({
  db: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../notifications/dispatcher.js', () => ({
  emitOrgAdminNotifications: (...args: unknown[]) => emitOrgAdminNotificationsMock(...args),
}));

vi.mock('../jobs/batch-anchor.js', () => ({
  processBatchAnchors: (...args: unknown[]) => processBatchAnchorsMock(...args),
}));

import {
  handleListPendingResolution,
  handleResolveQueue,
  handleRunOrgAnchorQueue,
  ResolveQueueInput,
  mapRpcErrorToStatus,
} from './queue-resolution.js';

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

function mockReq(opts: { body?: unknown; query?: Record<string, string> } = {}): Request {
  return {
    body: opts.body ?? {},
    query: opts.query ?? {},
    headers: {},
  } as unknown as Request;
}

function selectMaybeSingle(data: unknown, error: unknown = null) {
  const chain: {
    eq: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
  } = {
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  chain.eq.mockReturnValue(chain);
  return {
    select: vi.fn().mockReturnValue(chain),
    chain,
  };
}

describe('ResolveQueueInput', () => {
  it('accepts minimal valid input with public_id', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: 'drive-123',
      selected_public_id: 'ARK-DEMO-CRD-AB12CD34',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty selected_public_id', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: 'drive-123',
      selected_public_id: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects internal UUID in selected_public_id (defense-in-depth)', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: 'drive-123',
      selected_public_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty external_file_id', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: '',
      selected_public_id: 'ARK-DEMO-CRD-AB12CD34',
    });
    expect(result.success).toBe(false);
  });

  it('caps reason at 2000 chars', () => {
    const result = ResolveQueueInput.safeParse({
      external_file_id: 'drive-123',
      selected_public_id: 'ARK-DEMO-CRD-AB12CD34',
      reason: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('mapRpcErrorToStatus', () => {
  it.each([
    // Resource-not-found (generic) → 404
    ['Anchor not found', 404],
    ['Selected anchor not found', 404],
    ['Selected public_id not found', 404],
    // "Profile not found" is an AUTH path — the RPC raises it when auth.uid()
    // doesn't resolve. Must match 403 BEFORE the generic 'not found' check.
    ['Profile not found', 403],
    ['Only organization administrators can resolve queued anchors', 403],
    ['Cannot resolve anchor from different organization', 403],
    ['insufficient_privilege', 403],
    // Conflicts (state rejections)
    ['Anchor is not awaiting resolution (status: SUBMITTED)', 409],
    ['check_violation on something', 409],
    ['Selected anchor external_file_id (a) does not match requested collision set (b)', 409],
    // Fallthrough
    ['generic db error', 500],
  ])('maps %j → %i', (msg, code) => {
    expect(mapRpcErrorToStatus(msg)).toBe(code);
  });
});

describe('handleListPendingResolution', () => {
  beforeEach(() => rpcMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('returns items + count on success', async () => {
    rpcMock.mockResolvedValue({
      data: [
        { public_id: 'ARK-DEMO-CRD-AB12CD34', external_file_id: 'drive-123', filename: 'f.pdf', fingerprint: 'fp', created_at: 't', sibling_count: 2 },
      ],
      error: null,
    });
    const { res, status, json } = mockRes();
    await handleListPendingResolution(mockReq(), res);
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1, items: expect.any(Array) }),
    );
  });

  it('never exposes internal anchors.id (IDOR defense)', async () => {
    rpcMock.mockResolvedValue({
      data: [
        { public_id: 'ARK-DEMO-CRD-AB12CD34', external_file_id: 'drive-123', filename: 'f.pdf', fingerprint: 'fp', created_at: 't', sibling_count: 2 },
      ],
      error: null,
    });
    const { res, json } = mockRes();
    await handleListPendingResolution(mockReq(), res);
    const payload = json.mock.calls[0][0];
    expect(payload.items[0]).toHaveProperty('public_id');
    expect(payload.items[0]).not.toHaveProperty('id');
  });

  it('clamps limit to [1, 500]', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { res } = mockRes();
    await handleListPendingResolution(mockReq({ query: { limit: '10000' } }), res);
    expect(rpcMock).toHaveBeenCalledWith(
      'list_pending_resolution_anchors',
      { p_limit: 500 },
    );

    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { res: res2 } = mockRes();
    await handleListPendingResolution(mockReq({ query: { limit: '-5' } }), res2);
    expect(rpcMock).toHaveBeenCalledWith(
      'list_pending_resolution_anchors',
      { p_limit: 1 },
    );
  });

  it('returns 500 when RPC errors', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { res, status, json } = mockRes();
    await handleListPendingResolution(mockReq(), res);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Object) }));
  });

  it('coerces non-array data to empty list', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { res, json } = mockRes();
    await handleListPendingResolution(mockReq(), res);
    expect(json).toHaveBeenCalledWith({ items: [], count: 0 });
  });
});

describe('handleResolveQueue', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    emitOrgAdminNotificationsMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects invalid body with 400', async () => {
    const { res, status } = mockRes();
    await handleResolveQueue(mockReq({ body: { external_file_id: 'x' } }), res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('returns resolution_id on success', async () => {
    rpcMock.mockResolvedValue({ data: 'res-1', error: null });
    const { res, json } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'ARK-DEMO-CRD-AB12CD34',
        },
      }),
      res,
    );
    expect(json).toHaveBeenCalledWith({ resolution_id: 'res-1' });
  });

  it('notifies admins for the selected anchor organization (lookup by public_id)', async () => {
    rpcMock.mockResolvedValue({ data: 'res-1', error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { org_id: 'org-1' }, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ select });

    const { res } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'ARK-DEMO-CRD-AB12CD34',
        },
      }),
      res,
      'user-1',
    );

    expect(fromMock).toHaveBeenCalledWith('anchors');
    expect(eq).toHaveBeenCalledWith('public_id', 'ARK-DEMO-CRD-AB12CD34');
    expect(emitOrgAdminNotificationsMock).toHaveBeenCalledWith({
      type: 'queue_run_completed',
      organizationId: 'org-1',
      payload: expect.objectContaining({
        resolutionId: 'res-1',
        actorUserId: 'user-1',
        selectedPublicId: 'ARK-DEMO-CRD-AB12CD34',
      }),
    });
  });

  it('maps RPC 403 for insufficient privileges', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Only organization administrators can resolve queued anchors' },
    });
    const { res, status, json } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'ARK-DEMO-CRD-AB12CD34',
        },
      }),
      res,
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'forbidden' }),
    });
  });

  it('maps RPC 409 for status conflict', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Anchor is not awaiting resolution (status: SECURED)' },
    });
    const { res, status, json } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'ARK-DEMO-CRD-AB12CD34',
        },
      }),
      res,
    );
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'conflict' }),
    });
  });

  it('maps RPC 404 for not-found', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Anchor not found' },
    });
    const { res, status, json } = mockRes();
    await handleResolveQueue(
      mockReq({
        body: {
          external_file_id: 'drive-123',
          selected_public_id: 'ARK-DEMO-CRD-AB12CD34',
        },
      }),
      res,
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'not_found' }),
    });
  });
});

describe('handleRunOrgAnchorQueue', () => {
  beforeEach(() => {
    fromMock.mockReset();
    processBatchAnchorsMock.mockReset();
    emitOrgAdminNotificationsMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects callers without an organization', async () => {
    fromMock.mockReturnValueOnce(selectMaybeSingle({ org_id: null, role: 'ORG_ADMIN' }));

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'No organization on profile' },
    });
    expect(processBatchAnchorsMock).not.toHaveBeenCalled();
  });

  it('rejects non-admin organization members', async () => {
    fromMock
      .mockReturnValueOnce(selectMaybeSingle({ org_id: 'org-1', role: 'INDIVIDUAL' }))
      .mockReturnValueOnce(selectMaybeSingle({ role: 'member' }));

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'Only organization admins can run anchoring jobs' },
    });
    expect(processBatchAnchorsMock).not.toHaveBeenCalled();
  });

  it('runs the caller org queue and notifies admins', async () => {
    fromMock
      .mockReturnValueOnce(selectMaybeSingle({ org_id: 'org-1', role: 'INDIVIDUAL' }))
      .mockReturnValueOnce(selectMaybeSingle({ role: 'admin' }));
    processBatchAnchorsMock.mockResolvedValue({
      processed: 42,
      batchId: 'batch-1',
      merkleRoot: 'a'.repeat(64),
      txId: 'tx-1',
    });

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).not.toHaveBeenCalled();
    expect(processBatchAnchorsMock).toHaveBeenCalledWith({
      orgId: 'org-1',
      force: true,
      failIfRunning: true,
      workerId: 'org-run-org-1-user-1',
    });
    expect(json).toHaveBeenCalledWith({
      ok: true,
      processed: 42,
      batchId: 'batch-1',
      merkleRoot: 'a'.repeat(64),
      txId: 'tx-1',
    });
    expect(emitOrgAdminNotificationsMock).toHaveBeenCalledWith({
      type: 'queue_run_completed',
      organizationId: 'org-1',
      payload: expect.objectContaining({
        triggeredBy: 'user-1',
        trigger: 'manual',
        processed: 42,
        batchId: 'batch-1',
      }),
    });
  });

  it('returns run_failed when the batch worker reports a scoped claim failure', async () => {
    fromMock
      .mockReturnValueOnce(selectMaybeSingle({ org_id: 'org-1', role: 'ORG_ADMIN' }))
      .mockReturnValueOnce(selectMaybeSingle(null));
    processBatchAnchorsMock.mockResolvedValue({
      processed: 0,
      batchId: null,
      merkleRoot: null,
      txId: null,
      error: 'Failed to claim organization anchors',
    });

    const { res, status, json } = mockRes();
    await handleRunOrgAnchorQueue('user-1', mockReq(), res);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'run_failed', message: 'Failed to claim organization anchors' },
    });
    expect(emitOrgAdminNotificationsMock).not.toHaveBeenCalled();
  });
});
