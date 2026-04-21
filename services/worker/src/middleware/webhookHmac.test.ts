/**
 * Tests for SEC-01 uniform webhook HMAC middleware.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { webhookHmac, computeHmac } from './webhookHmac.js';

function mockRes(): {
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

function mockReq(opts: {
  body?: unknown;
  rawBody?: Buffer | string;
  headers?: Record<string, string>;
}): Request {
  const req = {
    body: opts.body,
    rawBody: opts.rawBody,
    headers: Object.fromEntries(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    path: '/webhook/test',
  } as unknown as Request;
  return req;
}

const SECRET = 'test-secret-do-not-use-in-prod';

describe('computeHmac', () => {
  it('is deterministic for the same inputs', () => {
    const a = computeHmac(SECRET, '1600000000', 'body');
    const b = computeHmac(SECRET, '1600000000', 'body');
    expect(a).toBe(b);
  });

  it('changes when any input changes', () => {
    const base = computeHmac(SECRET, '1600000000', 'body');
    expect(computeHmac(SECRET, '1600000000', 'BODY')).not.toBe(base);
    expect(computeHmac(SECRET, '1600000001', 'body')).not.toBe(base);
    expect(computeHmac('other', '1600000000', 'body')).not.toBe(base);
  });

  it('produces 64-char hex digests', () => {
    expect(computeHmac(SECRET, 'ts', 'body')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('webhookHmac middleware', () => {
  const originalEnv = process.env.ENABLE_WEBHOOK_HMAC;

  beforeEach(() => {
    process.env.ENABLE_WEBHOOK_HMAC = 'true';
  });
  afterEach(() => {
    process.env.ENABLE_WEBHOOK_HMAC = originalEnv;
    vi.useRealTimers();
  });

  it('rejects with 401 when signature header is missing', async () => {
    const mw = webhookHmac({ getSecret: () => SECRET });
    const next = vi.fn() as NextFunction;
    const { res, status } = mockRes();
    await mw(mockReq({ body: { a: 1 }, headers: {} }), res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 when timestamp is missing', async () => {
    const mw = webhookHmac({ getSecret: () => SECRET });
    const next = vi.fn() as NextFunction;
    const { res, status } = mockRes();
    await mw(
      mockReq({ body: { a: 1 }, headers: { 'x-signature-sha256': 'abc' } }),
      res,
      next,
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 when timestamp is non-numeric', async () => {
    const mw = webhookHmac({ getSecret: () => SECRET });
    const next = vi.fn() as NextFunction;
    const { res, status } = mockRes();
    await mw(
      mockReq({
        body: {},
        headers: {
          'x-signature-sha256': 'a'.repeat(64),
          'x-signature-timestamp': 'not-a-number',
        },
      }),
      res,
      next,
    );
    expect(status).toHaveBeenCalledWith(401);
  });

  it('rejects timestamps outside 5-minute skew', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    const staleTs = now - 301; // 5m1s old
    const mw = webhookHmac({ getSecret: () => SECRET });
    const next = vi.fn() as NextFunction;
    const { res, status } = mockRes();
    const body = JSON.stringify({ a: 1 });
    const sig = computeHmac(SECRET, String(staleTs), body);
    await mw(
      mockReq({
        rawBody: Buffer.from(body),
        headers: {
          'x-signature-sha256': sig,
          'x-signature-timestamp': String(staleTs),
        },
      }),
      res,
      next,
    );
    expect(status).toHaveBeenCalledWith(401);
  });

  it('accepts a valid signature', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'));
    const now = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event: 'envelope-completed' });
    const sig = computeHmac(SECRET, now, body);
    const mw = webhookHmac({ getSecret: () => SECRET });
    const next = vi.fn() as NextFunction;
    const { res, status } = mockRes();
    await mw(
      mockReq({
        rawBody: Buffer.from(body),
        headers: {
          'x-signature-sha256': sig,
          'x-signature-timestamp': now,
        },
      }),
      res,
      next,
    );
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects when the body does not match (tampered payload)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'));
    const now = String(Math.floor(Date.now() / 1000));
    const originalBody = JSON.stringify({ a: 1 });
    const tamperedBody = JSON.stringify({ a: 2 });
    const sig = computeHmac(SECRET, now, originalBody);
    const mw = webhookHmac({ getSecret: () => SECRET });
    const next = vi.fn() as NextFunction;
    const { res, status } = mockRes();
    await mw(
      mockReq({
        rawBody: Buffer.from(tamperedBody),
        headers: {
          'x-signature-sha256': sig,
          'x-signature-timestamp': now,
        },
      }),
      res,
      next,
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when tenant secret is not found', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'));
    const now = String(Math.floor(Date.now() / 1000));
    const sig = computeHmac(SECRET, now, '{}');
    const mw = webhookHmac({ getSecret: () => null });
    const next = vi.fn() as NextFunction;
    const { res, status } = mockRes();
    await mw(
      mockReq({
        rawBody: Buffer.from('{}'),
        headers: {
          'x-signature-sha256': sig,
          'x-signature-timestamp': now,
        },
      }),
      res,
      next,
    );
    expect(status).toHaveBeenCalledWith(401);
  });

  it('rejects bodies larger than maxBodyBytes with 413', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'));
    const now = String(Math.floor(Date.now() / 1000));
    const bigBody = Buffer.alloc(11, 'x');
    const sig = computeHmac(SECRET, now, bigBody);
    const mw = webhookHmac({ getSecret: () => SECRET, maxBodyBytes: 10 });
    const next = vi.fn() as NextFunction;
    const { res, status } = mockRes();
    await mw(
      mockReq({
        rawBody: bigBody,
        headers: {
          'x-signature-sha256': sig,
          'x-signature-timestamp': now,
        },
      }),
      res,
      next,
    );
    expect(status).toHaveBeenCalledWith(413);
  });

  it('calls onHmacFail hook with the internal reason', async () => {
    const hook = vi.fn();
    const mw = webhookHmac({ getSecret: () => SECRET, onHmacFail: hook });
    const next = vi.fn() as NextFunction;
    const { res } = mockRes();
    await mw(mockReq({ body: {}, headers: {} }), res, next);
    expect(hook).toHaveBeenCalledOnce();
    const call = hook.mock.calls[0][0] as { reason: string };
    expect(call.reason).toBe('missing_signature');
  });

  it('skips verification in non-prod when ENABLE_WEBHOOK_HMAC=false', async () => {
    process.env.ENABLE_WEBHOOK_HMAC = 'false';
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const mw = webhookHmac({ getSecret: () => null });
      const next = vi.fn() as NextFunction;
      const { res, status } = mockRes();
      await mw(mockReq({ body: {}, headers: {} }), res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(status).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('refuses to run with HMAC disabled in production', async () => {
    process.env.ENABLE_WEBHOOK_HMAC = 'false';
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const mw = webhookHmac({ getSecret: () => SECRET });
      const next = vi.fn() as NextFunction;
      const { res, status } = mockRes();
      await mw(mockReq({ body: {}, headers: {} }), res, next);
      expect(status).toHaveBeenCalledWith(500);
      expect(next).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
