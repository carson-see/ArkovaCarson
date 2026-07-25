/**
 * Tests for ARK-104 anchor lineage + supersede API (SCRUM-1014).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const rpcMock = vi.fn();
// SCRUM-2937: the supersede producer re-reads anchors via db.from('anchors')
// .select().eq().single(). `anchorSingleMock` is a queue-aware stub — each call
// to .single() shifts the next queued result (parent row, then child row).
const anchorSingleMock = vi.fn();

vi.mock('../utils/db.js', () => ({
  db: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: (...args: unknown[]) => anchorSingleMock(...args),
    })),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// SCRUM-2937: mock the outbound webhook dispatcher so producer tests assert the
// anchor.superseded / credential.status_changed payloads without contacting the
// delivery system. Hoisted — vi.mock factories run before top-level statements.
const { mockDispatchWebhookEvent } = vi.hoisted(() => ({
  mockDispatchWebhookEvent: vi.fn(),
}));
vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

import {
  handleAnchorLineage,
  handleSupersedeAnchor,
  SupersedeInput,
} from './anchor-lineage.js';

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

function mockReq(opts: { params?: Record<string, string>; body?: unknown } = {}): Request {
  return {
    params: opts.params ?? {},
    body: opts.body ?? {},
    headers: {},
    query: {},
  } as unknown as Request;
}

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_PUBLIC_ID = 'pub-anchor-abc123';
const VALID_HASH = 'a'.repeat(64);

describe('SupersedeInput', () => {
  it('accepts a 64-char hex fingerprint', () => {
    const r = SupersedeInput.safeParse({ new_fingerprint: VALID_HASH });
    expect(r.success).toBe(true);
  });

  it('rejects short fingerprints', () => {
    const r = SupersedeInput.safeParse({ new_fingerprint: 'abc' });
    expect(r.success).toBe(false);
  });

  it('rejects non-hex characters', () => {
    const r = SupersedeInput.safeParse({ new_fingerprint: 'z'.repeat(64) });
    expect(r.success).toBe(false);
  });

  it('caps reason at 2000 chars', () => {
    const r = SupersedeInput.safeParse({
      new_fingerprint: VALID_HASH,
      reason: 'x'.repeat(2001),
    });
    expect(r.success).toBe(false);
  });
});

describe('handleAnchorLineage', () => {
  beforeEach(() => rpcMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('400s an empty public_id', async () => {
    const { res, status } = mockRes();
    await handleAnchorLineage(mockReq({ params: { id: '' } }), res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('400s a public_id over 128 chars', async () => {
    const { res, status } = mockRes();
    await handleAnchorLineage(mockReq({ params: { id: 'x'.repeat(129) } }), res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('calls RPC with p_public_id (never internal UUID)', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { res } = mockRes();
    await handleAnchorLineage(mockReq({ params: { id: VALID_PUBLIC_ID } }), res);
    // The second arg is the RPC params payload — must be the public-id key.
    expect(rpcMock).toHaveBeenCalledWith('get_anchor_lineage', { p_public_id: VALID_PUBLIC_ID });
  });

  it('returns items + head_public_id with is_current item', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          public_id: 'pub-root',
          version_number: 1,
          parent_public_id: null,
          status: 'SUPERSEDED',
          is_current: false,
        },
        {
          public_id: 'pub-head',
          version_number: 2,
          parent_public_id: 'pub-root',
          status: 'SECURED',
          is_current: true,
        },
      ],
      error: null,
    });
    const { res, json } = mockRes();
    await handleAnchorLineage(mockReq({ params: { id: VALID_PUBLIC_ID } }), res);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, head_public_id: 'pub-head' }),
    );
  });

  it('falls back to last item when no is_current flag', async () => {
    rpcMock.mockResolvedValue({
      data: [{ public_id: 'pub-only', is_current: false }],
      error: null,
    });
    const { res, json } = mockRes();
    await handleAnchorLineage(mockReq({ params: { id: VALID_PUBLIC_ID } }), res);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ head_public_id: 'pub-only' }),
    );
  });

  it('maps 404 on RPC "not found"', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Anchor not found' } });
    const { res, status } = mockRes();
    await handleAnchorLineage(mockReq({ params: { id: VALID_PUBLIC_ID } }), res);
    expect(status).toHaveBeenCalledWith(404);
  });

  it('returns empty array when RPC returns null data', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { res, json } = mockRes();
    await handleAnchorLineage(mockReq({ params: { id: VALID_PUBLIC_ID } }), res);
    expect(json).toHaveBeenCalledWith({ items: [], count: 0, head_public_id: null });
  });
});

describe('handleSupersedeAnchor', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    anchorSingleMock.mockReset();
    mockDispatchWebhookEvent.mockReset();
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('400s on invalid id', async () => {
    const { res, status } = mockRes();
    await handleSupersedeAnchor(
      mockReq({ params: { id: 'not-uuid' }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
  });

  it('400s on bad body', async () => {
    const { res, status } = mockRes();
    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: 'short' } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
  });

  it('returns new_anchor_id on success', async () => {
    rpcMock.mockResolvedValue({ data: 'new-id', error: null });
    const { res, json } = mockRes();
    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );
    expect(json).toHaveBeenCalledWith({ new_anchor_id: 'new-id' });
  });

  it('maps 403 for privilege errors', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Only organization administrators can supersede anchors' },
    });
    const { res, status, json } = mockRes();
    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'forbidden' }),
    });
  });

  it('maps 409 when already superseded', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Anchor has already been superseded by some-id' },
    });
    const { res, status } = mockRes();
    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(409);
  });

  it('maps 404 on not-found', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Anchor not found' } });
    const { res, status } = mockRes();
    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(404);
  });

  // ── SCRUM-2937: anchor.superseded producer wiring (webhook↔dashboard parity) ──
  const PARENT_ROW = {
    public_id: VALID_PUBLIC_ID,
    org_id: '22222222-2222-4222-8222-222222222222',
    credential_type: 'transcript',
    chain_tx_id: 'a'.repeat(64),
    chain_block_height: 850000,
    revoked_at: '2026-07-22T00:00:00Z',
    updated_at: '2026-07-22T00:00:01Z',
  };

  it('dispatches anchor.superseded with a public-only payload on success', async () => {
    rpcMock.mockResolvedValue({ data: 'new-anchor-uuid', error: null });
    // First .single() → parent row; second → child slug lookup.
    anchorSingleMock
      .mockResolvedValueOnce({ data: PARENT_ROW, error: null })
      .mockResolvedValueOnce({ data: { public_id: 'pub-child-xyz' }, error: null });
    const { res, json } = mockRes();

    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH, reason: 'corrected' } }),
      res,
    );

    expect(json).toHaveBeenCalledWith({ new_anchor_id: 'new-anchor-uuid' });
    const supersededCall = mockDispatchWebhookEvent.mock.calls.find((c) => c[1] === 'anchor.superseded');
    expect(supersededCall).toBeDefined();
    expect(supersededCall?.[0]).toBe(PARENT_ROW.org_id); // org-scoped dispatch
    expect(supersededCall?.[2]).toBe(VALID_PUBLIC_ID);
    const payload = supersededCall?.[3];
    expect(payload).toMatchObject({
      public_id: VALID_PUBLIC_ID,
      status: 'SUPERSEDED',
      chain_tx_id: PARENT_ROW.chain_tx_id,
      chain_block_height: PARENT_ROW.chain_block_height,
      superseded_at: PARENT_ROW.revoked_at,
      superseded_by_public_id: 'pub-child-xyz',
      supersession_reason: 'corrected',
    });
    // No internal UUIDs / fingerprint leaked into the payload (CLAUDE.md §6/§1.6).
    expect(payload).not.toHaveProperty('org_id');
    expect(payload).not.toHaveProperty('anchor_id');
    expect(payload).not.toHaveProperty('fingerprint');
  });

  it('also dispatches credential.status_changed (SECURED→SUPERSEDED) for credentials', async () => {
    rpcMock.mockResolvedValue({ data: 'new-anchor-uuid', error: null });
    anchorSingleMock
      .mockResolvedValueOnce({ data: PARENT_ROW, error: null })
      .mockResolvedValueOnce({ data: { public_id: 'pub-child-xyz' }, error: null });
    const { res } = mockRes();

    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );

    const credCall = mockDispatchWebhookEvent.mock.calls.find((c) => c[1] === 'credential.status_changed');
    expect(credCall).toBeDefined();
    expect(credCall?.[3]).toMatchObject({
      previous_status: 'SECURED',
      new_status: 'SUPERSEDED',
      credential_type: 'transcript',
    });
  });

  it('skips credential.status_changed when the anchor has no credential_type', async () => {
    rpcMock.mockResolvedValue({ data: 'new-anchor-uuid', error: null });
    anchorSingleMock
      .mockResolvedValueOnce({ data: { ...PARENT_ROW, credential_type: null }, error: null })
      .mockResolvedValueOnce({ data: { public_id: 'pub-child-xyz' }, error: null });
    const { res } = mockRes();

    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );

    expect(mockDispatchWebhookEvent.mock.calls.some((c) => c[1] === 'anchor.superseded')).toBe(true);
    expect(mockDispatchWebhookEvent.mock.calls.some((c) => c[1] === 'credential.status_changed')).toBe(false);
  });

  it('still returns 200 when the webhook dispatch throws (best-effort, non-fatal)', async () => {
    rpcMock.mockResolvedValue({ data: 'new-anchor-uuid', error: null });
    anchorSingleMock
      .mockResolvedValueOnce({ data: PARENT_ROW, error: null })
      .mockResolvedValueOnce({ data: { public_id: 'pub-child-xyz' }, error: null });
    mockDispatchWebhookEvent.mockRejectedValue(new Error('delivery down'));
    const { res, json, status } = mockRes();

    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );

    expect(json).toHaveBeenCalledWith({ new_anchor_id: 'new-anchor-uuid' });
    expect(status).not.toHaveBeenCalledWith(500);
  });

  it('skips the webhook (but still 200s) when the parent is missing chain fields', async () => {
    rpcMock.mockResolvedValue({ data: 'new-anchor-uuid', error: null });
    anchorSingleMock.mockResolvedValueOnce({
      data: { ...PARENT_ROW, chain_tx_id: null, chain_block_height: null },
      error: null,
    });
    const { res, json } = mockRes();

    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );

    expect(json).toHaveBeenCalledWith({ new_anchor_id: 'new-anchor-uuid' });
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when the RPC failed', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Anchor not found' } });
    const { res } = mockRes();

    await handleSupersedeAnchor(
      mockReq({ params: { id: VALID_UUID }, body: { new_fingerprint: VALID_HASH } }),
      res,
    );

    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });
});
