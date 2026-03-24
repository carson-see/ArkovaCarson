/**
 * Tests for global error handler (ARCH-4)
 */

import { describe, it, expect, vi } from 'vitest';
import { AppError, globalErrorHandler } from './errorHandler.js';

// Mock config
vi.mock('../config.js', () => ({
  config: { nodeEnv: 'development' },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createMockRes() {
  const res: any = {
    headersSent: false,
    statusCode: 200,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

describe('globalErrorHandler', () => {
  it('returns structured error for AppError', () => {
    const err = new AppError(400, 'INVALID_INPUT', 'Bad request', { field: 'name' });
    const res = createMockRes();

    globalErrorHandler(err, {} as any, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INVALID_INPUT',
        message: 'Bad request',
        details: { field: 'name' },
      },
    });
  });

  it('returns generic 500 for unhandled errors', () => {
    const err = new Error('something broke');
    const res = createMockRes();

    globalErrorHandler(err, {} as any, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  });

  it('does nothing if headers already sent', () => {
    const err = new Error('late error');
    const res = createMockRes();
    res.headersSent = true;

    globalErrorHandler(err, {} as any, res, vi.fn());

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('AppError', () => {
  it('extends Error with status code and error code', () => {
    const err = new AppError(404, 'NOT_FOUND', 'Resource not found');
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Resource not found');
    expect(err.name).toBe('AppError');
  });
});
