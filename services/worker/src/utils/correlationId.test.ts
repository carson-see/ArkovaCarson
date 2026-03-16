/**
 * Unit tests for correlationId utilities
 *
 * HARDENING-5: ID generation, middleware, AsyncLocalStorage context.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  generateCorrelationId,
  getCorrelationId,
  correlationIdMiddleware,
  withCorrelationId,
} from './correlationId.js';

describe('generateCorrelationId', () => {
  it('returns a string with req_ prefix', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('generates unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
    expect(ids.size).toBe(100);
  });
});

describe('getCorrelationId', () => {
  it('returns undefined when called outside correlation context', () => {
    expect(getCorrelationId()).toBeUndefined();
  });
});

describe('withCorrelationId', () => {
  it('makes correlation ID available inside sync callback', () => {
    const result = withCorrelationId('test-123', () => {
      return getCorrelationId();
    });
    expect(result).toBe('test-123');
  });

  it('makes correlation ID available inside async callback', async () => {
    const result = await withCorrelationId('async-456', async () => {
      return getCorrelationId();
    });
    expect(result).toBe('async-456');
  });

  it('isolates contexts — nested calls do not leak', () => {
    withCorrelationId('outer', () => {
      expect(getCorrelationId()).toBe('outer');

      withCorrelationId('inner', () => {
        expect(getCorrelationId()).toBe('inner');
      });

      // Outer context restored
      expect(getCorrelationId()).toBe('outer');
    });
  });

  it('returns undefined after context exits', () => {
    withCorrelationId('temp', () => {
      // inside
    });
    expect(getCorrelationId()).toBeUndefined();
  });
});

describe('correlationIdMiddleware', () => {
  let req: Request;
  let res: Response;
  let next: NextFunction;

  beforeEach(() => {
    req = { headers: {} } as unknown as Request;
    res = { setHeader: vi.fn() } as unknown as Response;
    next = vi.fn() as unknown as NextFunction;
  });

  it('generates a new correlation ID when no header present', () => {
    correlationIdMiddleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.stringMatching(/^req_[0-9a-f]{24}$/)
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('uses x-correlation-id header when present', () => {
    req.headers['x-correlation-id'] = 'existing-id-999';

    correlationIdMiddleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', 'existing-id-999');
    expect(next).toHaveBeenCalledOnce();
  });

  it('falls back to x-request-id header when x-correlation-id is absent', () => {
    req.headers['x-request-id'] = 'request-id-xyz';

    correlationIdMiddleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', 'request-id-xyz');
    expect(next).toHaveBeenCalledOnce();
  });

  it('prefers x-correlation-id over x-request-id', () => {
    req.headers['x-correlation-id'] = 'corr-id';
    req.headers['x-request-id'] = 'req-id';

    correlationIdMiddleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', 'corr-id');
  });

  it('sets correlation context for downstream handlers', () => {
    let capturedId: string | undefined;

    (next as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      capturedId = getCorrelationId();
    });

    correlationIdMiddleware(req, res, next);

    expect(capturedId).toMatch(/^req_[0-9a-f]{24}$/);
  });
});
