import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockMaybeSingle = vi.fn();
const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({ select: mockSelect })),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { requirePaymentCurrent } from './requirePaymentCurrent.js';

function mockReq(orgId?: string): Request {
  return { orgId, apiKey: orgId ? { orgId } : undefined } as unknown as Request;
}

function mockRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json = vi.fn((data: unknown) => { res.body = data; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

beforeEach(() => vi.clearAllMocks());

describe('requirePaymentCurrent', () => {
  const mw = requirePaymentCurrent();

  it('passes through when no orgId is present', async () => {
    const next = vi.fn();
    await mw(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('passes through when payment_state is current', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { payment_state: 'current' }, error: null });
    const next = vi.fn();
    await mw(mockReq('org-1'), mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('passes through when payment_state is null (no state set yet)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { payment_state: null }, error: null });
    const next = vi.fn();
    await mw(mockReq('org-1'), mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('returns 402 when payment_state is suspended', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { payment_state: 'suspended' }, error: null });
    const next = vi.fn();
    const res = mockRes();
    await mw(mockReq('org-1'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
  });

  it('returns 402 when payment_state is cancelled', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { payment_state: 'cancelled' }, error: null });
    const next = vi.fn();
    const res = mockRes();
    await mw(mockReq('org-1'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
  });

  it('passes through on DB error (fail-open for availability)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const next = vi.fn();
    await mw(mockReq('org-1'), mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});
