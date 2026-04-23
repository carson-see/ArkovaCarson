/**
 * Tests for ARK-104 anchor lineage + supersede API (SCRUM-1014).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const rpcMock = vi.fn();

vi.mock('../utils/db.js', () => ({
  db: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
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
  beforeEach(() => rpcMock.mockReset());
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
});
