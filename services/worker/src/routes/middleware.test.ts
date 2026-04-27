/**
 * Tests for routes/middleware.ts CORS handling.
 *
 * Regression: rules enable/disable/edit fail in browser because the global
 * CORS middleware (mounted in index.ts:89) historically advertised only
 * `POST, GET, DELETE, OPTIONS`, which makes Chrome reject PATCH preflight.
 * The /api/v1/* router fixed this in router.ts:116 but /api/rules/* uses
 * the global middleware.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

// `routes/middleware.ts` imports `../config.js`, which validates the full
// worker env at import time. Stub it so the test can run without a populated
// .env (matches the lightweight pattern used by sibling route tests that
// inject deps directly).
vi.mock('../config.js', () => ({
  config: {
    frontendUrl: 'https://arkova-26.vercel.app',
    corsAllowedOrigins: 'https://arkova-26.vercel.app,https://app.arkova.ai',
  },
}));
// Auth + logger imports also pull config indirectly; stub the surface this
// test actually exercises (none — we only call setCorsHeaders).
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
