import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../middleware/errorSanitizer.js', () => ({
  sanitizeErrorMessage: (m: string) => m,
}));

import { requireScopeV2, VALID_SCOPES } from './scopeGuard.js';
import { ProblemError, ProblemTypes } from './problem.js';

function mockReq(apiKey?: { scopes: string[] }): Request {
  return { apiKey: apiKey as Request['apiKey'] } as Request;
}

describe('requireScopeV2', () => {
  const res = {} as Response;

  it('passes through when scope is present', () => {
    const next = vi.fn();
    const mw = requireScopeV2('read:search');
    mw(mockReq({ scopes: ['read:search', 'read:records'] }), res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it.each(VALID_SCOPES)('passes through for %s when present', (scope) => {
    const next = vi.fn();
    const mw = requireScopeV2(scope);
    mw(mockReq({ scopes: [scope] }), res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects with ProblemError when scope is missing', () => {
    const next = vi.fn();
    const mw = requireScopeV2('write:anchors');
    mw(mockReq({ scopes: ['read:search'] }), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(ProblemError));
    const err = next.mock.calls[0][0] as ProblemError;
    expect(err.problem.type).toBe(ProblemTypes.INVALID_SCOPE);
    expect(err.problem.status).toBe(403);
  });

  it('rejects with auth-required when no API key', () => {
    const next = vi.fn();
    const mw = requireScopeV2('read:search');
    mw(mockReq(), res, next);
    const err = next.mock.calls[0][0] as ProblemError;
    expect(err.problem.type).toBe(ProblemTypes.AUTHENTICATION_REQUIRED);
  });

  it('exports all valid scopes', () => {
    expect(VALID_SCOPES).toContain('read:records');
    expect(VALID_SCOPES).toContain('read:orgs');
    expect(VALID_SCOPES).toContain('read:search');
    expect(VALID_SCOPES).toContain('write:anchors');
    expect(VALID_SCOPES).toContain('admin:rules');
  });
});
