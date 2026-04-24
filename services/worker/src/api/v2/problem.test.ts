import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  ProblemError,
  ProblemTypes,
  sendProblem,
  v2ErrorHandler,
} from './problem.js';

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as Response;
  return res;
}

function mockReq(url = '/api/v2/test'): Request {
  return { originalUrl: url } as Request;
}

describe('ProblemError', () => {
  it('creates a rate-limited error', () => {
    const err = ProblemError.rateLimited(60, 'Too many requests');
    expect(err.problem.type).toBe(ProblemTypes.RATE_LIMITED);
    expect(err.problem.status).toBe(429);
    expect(err.problem.title).toBe('Rate Limit Exceeded');
    expect(err.problem.detail).toBe('Too many requests');
  });

  it('creates an invalid-scope error', () => {
    const err = ProblemError.invalidScope('write:anchors', ['read:search']);
    expect(err.problem.type).toBe(ProblemTypes.INVALID_SCOPE);
    expect(err.problem.status).toBe(403);
    expect(err.problem.detail).toContain('write:anchors');
    expect(err.problem.detail).toContain('read:search');
  });

  it('creates an authentication-required error', () => {
    const err = ProblemError.authenticationRequired();
    expect(err.problem.status).toBe(401);
  });

  it('creates a validation error', () => {
    const err = ProblemError.validationError('Invalid cursor format');
    expect(err.problem.type).toBe(ProblemTypes.VALIDATION_ERROR);
    expect(err.problem.status).toBe(400);
    expect(err.problem.detail).toBe('Invalid cursor format');
  });

  it('creates a not-found error', () => {
    const err = ProblemError.notFound('Record does not exist');
    expect(err.problem.status).toBe(404);
  });

  it('creates a forbidden error', () => {
    const err = ProblemError.forbidden();
    expect(err.problem.status).toBe(403);
  });

  it('creates an internal error', () => {
    const err = ProblemError.internalError();
    expect(err.problem.status).toBe(500);
  });
});

describe('sendProblem', () => {
  it('sends application/problem+json with correct status', () => {
    const res = mockRes();
    sendProblem(res, {
      type: ProblemTypes.NOT_FOUND,
      title: 'Not Found',
      status: 404,
      detail: 'Missing resource',
    });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.type).toHaveBeenCalledWith('application/problem+json');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProblemTypes.NOT_FOUND,
        title: 'Not Found',
        status: 404,
        detail: 'Missing resource',
      }),
    );
  });
});

describe('v2ErrorHandler', () => {
  const next: NextFunction = vi.fn();

  it('handles ProblemError with instance URL', () => {
    const req = mockReq('/api/v2/search?q=test');
    const res = mockRes();
    const err = ProblemError.validationError('Bad query');

    v2ErrorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.type).toHaveBeenCalledWith('application/problem+json');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProblemTypes.VALIDATION_ERROR,
        instance: '/api/v2/search?q=test',
      }),
    );
  });

  it('sets Retry-After header for rate-limited errors', () => {
    const req = mockReq();
    const res = mockRes();
    const err = ProblemError.rateLimited(30);

    v2ErrorHandler(err, req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('handles unknown errors as 500', () => {
    const req = mockReq();
    const res = mockRes();
    const err = new Error('Unexpected failure');

    v2ErrorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProblemTypes.INTERNAL_ERROR,
        title: 'Internal Server Error',
      }),
    );
  });

  it('skips if headers already sent', () => {
    const req = mockReq();
    const res = mockRes();
    (res as { headersSent: boolean }).headersSent = true;
    const err = ProblemError.notFound();

    v2ErrorHandler(err, req, res, next);

    expect(res.status).not.toHaveBeenCalled();
  });
});
