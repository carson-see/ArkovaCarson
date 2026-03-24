/**
 * Correlation ID Middleware
 *
 * Adds correlation IDs to all requests for tracing.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// Store for correlation context
const correlationStorage = new AsyncLocalStorage<{ correlationId: string }>();

/**
 * Generate a correlation ID
 */
export function generateCorrelationId(): string {
  return `req_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Get the current correlation ID
 */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

/**
 * Express middleware to add correlation ID
 */
export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Use existing header or generate new ID
  const correlationId =
    (req.headers['x-correlation-id'] as string) ||
    (req.headers['x-request-id'] as string) ||
    generateCorrelationId();

  // Set response headers (X-Request-Id for external devs, X-Correlation-ID for internal tracing)
  res.setHeader('X-Request-Id', correlationId);
  res.setHeader('X-Correlation-ID', correlationId);

  // Run the rest of the request in correlation context
  correlationStorage.run({ correlationId }, () => {
    next();
  });
}

/**
 * Run a function with a correlation ID
 */
export function withCorrelationId<T>(
  correlationId: string,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return correlationStorage.run({ correlationId }, fn);
}
