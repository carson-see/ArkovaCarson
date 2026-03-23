/**
 * Global Express Error Handler (ARCH-4)
 *
 * Centralized error handling middleware that provides consistent
 * error response formatting across all endpoints.
 *
 * Standard error response schema:
 * {
 *   error: {
 *     code: string,     // Machine-readable error code
 *     message: string,  // Human-readable error description
 *     details?: any     // Optional additional context (dev only)
 *   }
 * }
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Application error with typed code for consistent API responses */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Global Express error middleware.
 * Must be registered AFTER all routes and AFTER Sentry error handler.
 */
export function globalErrorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  // Already sent a response — let Express handle the close
  if (res.headersSent) {
    return;
  }

  if (err instanceof AppError) {
    logger.warn({ code: err.code, statusCode: err.statusCode }, err.message);
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(config.nodeEnv !== 'production' && err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Unhandled errors — log full stack, return generic message
  logger.error({ error: err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
