/**
 * Uniform Webhook HMAC Middleware (SEC-01 — SCRUM-1025)
 *
 * Every inbound connector webhook MUST pass through this middleware. The
 * middleware verifies an `X-Signature-Sha256` HMAC computed over the RAW
 * request body using a per-tenant secret, with a 5-minute replay window
 * enforced via `X-Signature-Timestamp`.
 *
 * Compile-time enforcement lives in the route registry — a new route tagged
 * `kind: 'connector_webhook'` requires `hmacSecretRef` or TS fails. That type
 * is in routes/middleware.ts / route-registry.ts (Sprint 3+ story).
 *
 * Constitution refs:
 *   - 1.4: No hardcoded secrets; per-tenant secrets from Secret Manager
 *   - 1.9: `ENABLE_WEBHOOK_HMAC` flag (default true). Disable ONLY for
 *          local development; production fails loudly if flag is false.
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface WebhookHmacOptions {
  /**
   * Resolve the per-tenant secret. Return `null` if the tenant is unknown
   * or if the secret has not been provisioned — the middleware will reject
   * with 401 either way.
   */
  getSecret: (req: Request) => Promise<string | null> | string | null;
  /** Max skew between client timestamp and server clock. Default 300 s. */
  maxSkewSeconds?: number;
  /** Max body size in bytes. Default 1 MB. */
  maxBodyBytes?: number;
  /** Header name for the signature. Default 'x-signature-sha256'. */
  signatureHeader?: string;
  /** Header name for the timestamp. Default 'x-signature-timestamp'. */
  timestampHeader?: string;
  /**
   * For emitting structured audit events. Caller supplies an emitter so the
   * middleware stays DB-agnostic and trivially mockable. Return quickly —
   * the audit emit should not block the request path.
   */
  onHmacFail?: (details: {
    req: Request;
    reason: string;
  }) => void | Promise<void>;
}

const DEFAULT_MAX_SKEW_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/**
 * Express middleware factory. The caller should attach a raw-body parser
 * BEFORE this middleware so `req.body` / `(req as any).rawBody` contains
 * the bytes used to compute the signature. Uses `req.rawBody` when present;
 * else stringifies `req.body`.
 */
export function webhookHmac(options: WebhookHmacOptions) {
  const maxSkewSec = options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const sigHeader = (options.signatureHeader ?? 'x-signature-sha256').toLowerCase();
  const tsHeader = (options.timestampHeader ?? 'x-signature-timestamp').toLowerCase();

  return async function middleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Flag read per-request so dev/test can flip it mid-run; production is
    // protected by the explicit NODE_ENV check below.
    const enabled = process.env.ENABLE_WEBHOOK_HMAC !== 'false';
    if (!enabled && process.env.NODE_ENV === 'production') {
      logger.error('ENABLE_WEBHOOK_HMAC=false in production — refusing');
      reject(req, res, 500, 'misconfigured', options.onHmacFail);
      return;
    }
    if (!enabled) {
      next();
      return;
    }

    const rawSig = req.headers[sigHeader];
    const rawTs = req.headers[tsHeader];
    const signature = Array.isArray(rawSig) ? rawSig[0] : rawSig;
    const timestampStr = Array.isArray(rawTs) ? rawTs[0] : rawTs;

    if (!signature || typeof signature !== 'string') {
      reject(req, res, 401, 'missing_signature', options.onHmacFail);
      return;
    }
    if (!timestampStr || typeof timestampStr !== 'string') {
      reject(req, res, 401, 'missing_timestamp', options.onHmacFail);
      return;
    }

    const ts = Number(timestampStr);
    if (!Number.isFinite(ts)) {
      reject(req, res, 401, 'invalid_timestamp', options.onHmacFail);
      return;
    }
    const skewSec = Math.abs(Date.now() / 1000 - ts);
    if (skewSec > maxSkewSec) {
      reject(req, res, 401, 'stale_timestamp', options.onHmacFail);
      return;
    }

    // Size gate BEFORE secret fetch — don't force a Secret Manager round-trip
    // to reject an oversized body.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawBody: Buffer | string | undefined = (req as any).rawBody;
    const bodyBytes = bodyToBytes(rawBody, req.body);
    if (bodyBytes.length > maxBodyBytes) {
      reject(req, res, 413, 'body_too_large', options.onHmacFail);
      return;
    }

    const secret = await options.getSecret(req);
    if (!secret) {
      reject(req, res, 401, 'unknown_tenant', options.onHmacFail);
      return;
    }

    const expected = computeHmac(secret, timestampStr, bodyBytes);
    if (!safeEquals(expected, signature)) {
      reject(req, res, 401, 'invalid_signature', options.onHmacFail);
      return;
    }

    next();
  };
}

function bodyToBytes(rawBody: Buffer | string | undefined, parsed: unknown): Buffer {
  if (rawBody != null) {
    return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  }
  if (parsed == null) return Buffer.alloc(0);
  if (typeof parsed === 'string') return Buffer.from(parsed);
  return Buffer.from(JSON.stringify(parsed));
}

/**
 * `sha256HMAC(secret, `${timestamp}.${body}`)` — the timestamp binds the
 * signature to its replay-window so an attacker can't replay an old body
 * with a fresh timestamp (and vice versa).
 */
export function computeHmac(
  secret: string,
  timestamp: string,
  body: Buffer | string,
): string {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), bodyBuf]);
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function reject(
  req: Request,
  res: Response,
  status: number,
  reason: string,
  hook?: WebhookHmacOptions['onHmacFail'],
): void {
  // Generic error body — never leak which check failed to the caller.
  // The internal reason IS logged + audit-emitted so operators can diagnose.
  const errBody =
    status === 413
      ? { error: { code: 'payload_too_large', message: 'Webhook body exceeds size limit' } }
      : { error: { code: 'invalid_signature', message: 'Webhook signature verification failed' } };
  res.status(status).json(errBody);

  logger.warn({ reason, path: req.path }, 'Webhook HMAC rejected');
  if (hook) {
    try {
      void Promise.resolve(hook({ req, reason }));
    } catch {
      // never let a failed audit emit crash the request path
    }
  }
}
