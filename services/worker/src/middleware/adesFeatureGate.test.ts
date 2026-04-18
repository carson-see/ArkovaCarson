/**
 * AdES Signature Feature Gate — regression test for the 2026-04-18 prod bug
 * where the gate, mounted at `router.use('/', …)`, 503-ed every /api/v1/*
 * request (including /compliance/audit) when ENABLE_ADES_SIGNATURES was off.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: {
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: null, error: null }) }),
      }),
    }),
  },
}));

import { adesSignatureGate, _isAdesPath, _resetAdesFlagCacheForTesting } from './adesFeatureGate.js';

describe('adesSignatureGate path guard', () => {
  it('treats AdES paths as gated', () => {
    expect(_isAdesPath('/sign')).toBe(true);
    expect(_isAdesPath('/sign/foo')).toBe(true);
    expect(_isAdesPath('/signatures')).toBe(true);
    expect(_isAdesPath('/signatures/key-inventory')).toBe(true);
    expect(_isAdesPath('/signatures/abc-123/audit-proof')).toBe(true);
    expect(_isAdesPath('/verify-signature')).toBe(true);
  });

  it('does NOT treat unrelated paths as AdES', () => {
    expect(_isAdesPath('/compliance/audit')).toBe(false);
    expect(_isAdesPath('/compliance/score')).toBe(false);
    expect(_isAdesPath('/verify/abc/proof')).toBe(false);
    expect(_isAdesPath('/anchor/abc/lifecycle')).toBe(false);
    expect(_isAdesPath('/ai/extract')).toBe(false);
    // Guard against prefix collisions like `/signaturesX` that shouldn't match.
    expect(_isAdesPath('/signaturesX')).toBe(false);
    expect(_isAdesPath('/signX')).toBe(false);
  });
});

describe('adesSignatureGate middleware behaviour', () => {
  const runGate = async (reqPath: string, envEnabled: boolean) => {
    process.env.ENABLE_ADES_SIGNATURES = envEnabled ? 'true' : 'false';
    const gate = adesSignatureGate();
    const req = { path: reqPath } as Parameters<ReturnType<typeof adesSignatureGate>>[0];
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Parameters<ReturnType<typeof adesSignatureGate>>[1];
    const next = vi.fn();
    await gate(req, res, next);
    return { res, next };
  };

  beforeEach(() => {
    delete process.env.ENABLE_ADES_SIGNATURES;
    _resetAdesFlagCacheForTesting();
  });

  it('passes non-AdES paths through even when the flag is off', async () => {
    const { res, next } = await runGate('/compliance/audit', false);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('503s AdES paths when the flag is off', async () => {
    const { res, next } = await runGate('/signatures/key-inventory', false);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'AdES signature service is not currently enabled',
      code: 'ADES_SIGNATURES_DISABLED',
    });
  });

  it('lets AdES paths through when the flag is on', async () => {
    const { res, next } = await runGate('/signatures/key-inventory', true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
