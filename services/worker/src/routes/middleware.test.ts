import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

// Stub config: importing middleware.ts otherwise pulls config validation,
// which fails without a populated .env in test runs.
vi.mock('../config.js', () => ({
  config: {
    frontendUrl: 'https://arkova-26.vercel.app',
    corsAllowedOrigins: 'https://arkova-26.vercel.app,https://app.arkova.ai',
  },
}));
vi.mock('../auth.js', () => ({ verifyAuthToken: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { setCorsHeaders } = await import('./middleware.js');

function makeReqRes(method: string, origin?: string) {
  const headers: Record<string, string> = {};
  const req = { method, headers: { origin } } as unknown as Request;
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
  } as unknown as Response;
  return { req, res, headers };
}

describe('setCorsHeaders', () => {
  it('advertises PATCH in Allow-Methods so /api/rules PATCH preflight passes', () => {
    const { req, res, headers } = makeReqRes('OPTIONS', 'https://arkova-26.vercel.app');
    setCorsHeaders(req, res);
    expect(headers['Access-Control-Allow-Methods']).toContain('PATCH');
  });

  it('keeps GET, POST, DELETE, OPTIONS alongside PATCH', () => {
    const { req, res, headers } = makeReqRes('OPTIONS', 'https://arkova-26.vercel.app');
    setCorsHeaders(req, res);
    const methods = headers['Access-Control-Allow-Methods'] ?? '';
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(methods).toContain(m);
    }
  });

  it('skips header set for unknown origins', () => {
    const { req, res, headers } = makeReqRes('GET', 'https://evil.example.com');
    setCorsHeaders(req, res);
    expect(headers['Access-Control-Allow-Methods']).toBeUndefined();
  });
});
