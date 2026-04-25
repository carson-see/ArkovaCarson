import { Request, Response, NextFunction } from 'express';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { sanitizeErrorMessage } from '../../middleware/errorSanitizer.js';

const BASE_URI = 'https://arkova.ai/problems';

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

export const ProblemTypes = {
  RATE_LIMITED: `${BASE_URI}/rate-limited`,
  INVALID_SCOPE: `${BASE_URI}/invalid-scope`,
  AUTHENTICATION_REQUIRED: `${BASE_URI}/authentication-required`,
  INVALID_API_KEY: `${BASE_URI}/invalid-api-key`,
  API_KEY_REVOKED: `${BASE_URI}/api-key-revoked`,
  API_KEY_EXPIRED: `${BASE_URI}/api-key-expired`,
  VALIDATION_ERROR: `${BASE_URI}/validation-error`,
  NOT_FOUND: `${BASE_URI}/not-found`,
  FORBIDDEN: `${BASE_URI}/forbidden`,
  INTERNAL_ERROR: `${BASE_URI}/internal-error`,
  SERVICE_UNAVAILABLE: `${BASE_URI}/service-unavailable`,
  FEATURE_DISABLED: `${BASE_URI}/feature-disabled`,
} as const;

export class ProblemError extends Error {
  public readonly problem: ProblemDetail;
  public readonly retryAfter?: number;

  constructor(
    type: string,
    title: string,
    status: number,
    detail?: string,
    instance?: string,
  ) {
    super(detail ?? title);
    this.name = 'ProblemError';
    this.problem = { type, title, status, detail, instance };
  }

  static rateLimited(retryAfter: number, detail?: string): ProblemError {
    const err = new ProblemError(
      ProblemTypes.RATE_LIMITED,
      'Rate Limit Exceeded',
      429,
      detail ?? 'You have exceeded the allowed request rate. Please retry after the indicated period.',
    );
    (err as { retryAfter: number }).retryAfter = retryAfter;
    return err;
  }

  static invalidScope(required: string, granted: string[]): ProblemError {
    return new ProblemError(
      ProblemTypes.INVALID_SCOPE,
      'Insufficient Scope',
      403,
      `This API key does not have the required scope: ${required}. Granted: ${granted.join(', ') || 'none'}.`,
    );
  }

  static authenticationRequired(): ProblemError {
    return new ProblemError(
      ProblemTypes.AUTHENTICATION_REQUIRED,
      'Authentication Required',
      401,
      'API key required. Pass via Authorization: Bearer ak_... or X-API-Key header.',
    );
  }

  static invalidApiKey(): ProblemError {
    return new ProblemError(
      ProblemTypes.INVALID_API_KEY,
      'Invalid API Key',
      401,
      'The provided API key is invalid or does not exist.',
    );
  }

  static apiKeyRevoked(): ProblemError {
    return new ProblemError(
      ProblemTypes.API_KEY_REVOKED,
      'API Key Revoked',
      401,
      'This API key has been revoked.',
    );
  }

  static apiKeyExpired(): ProblemError {
    return new ProblemError(
      ProblemTypes.API_KEY_EXPIRED,
      'API Key Expired',
      401,
      'This API key has expired.',
    );
  }

  static validationError(detail: string): ProblemError {
    return new ProblemError(
      ProblemTypes.VALIDATION_ERROR,
      'Validation Error',
      400,
      detail,
    );
  }

  static notFound(detail?: string): ProblemError {
    return new ProblemError(
      ProblemTypes.NOT_FOUND,
      'Not Found',
      404,
      detail ?? 'The requested resource was not found.',
    );
  }

  static forbidden(detail?: string): ProblemError {
    return new ProblemError(
      ProblemTypes.FORBIDDEN,
      'Forbidden',
      403,
      detail ?? 'You do not have permission to access this resource.',
    );
  }

  static internalError(detail?: string): ProblemError {
    return new ProblemError(
      ProblemTypes.INTERNAL_ERROR,
      'Internal Server Error',
      500,
      detail,
    );
  }

  static serviceUnavailable(detail?: string): ProblemError {
    return new ProblemError(
      ProblemTypes.SERVICE_UNAVAILABLE,
      'Service Unavailable',
      503,
      detail ?? 'The service is temporarily unavailable.',
    );
  }
}

export function sendProblem(res: Response, problem: ProblemDetail): void {
  const safe: ProblemDetail = {
    ...problem,
    detail: problem.detail && config.nodeEnv === 'production'
      ? sanitizeErrorMessage(problem.detail)
      : problem.detail,
  };
  res.status(safe.status).type('application/problem+json').json(safe);
}

export function v2ErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (err instanceof ProblemError) {
    logger.warn({ type: err.problem.type, status: err.problem.status }, err.message);
    const problem: ProblemDetail = {
      ...err.problem,
      instance: req.originalUrl,
    };
    if (err.retryAfter) {
      res.setHeader('Retry-After', String(err.retryAfter));
    }
    sendProblem(res, problem);
    return;
  }

  logger.error({ error: err }, 'Unhandled v2 error');
  sendProblem(res, {
    type: ProblemTypes.INTERNAL_ERROR,
    title: 'Internal Server Error',
    status: 500,
    detail: config.nodeEnv === 'development' ? err.message : undefined,
    instance: req.originalUrl,
  });
}
