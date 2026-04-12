/**
 * Idempotency-Key Middleware (DX-4)
 *
 * Accepts an Idempotency-Key header on POST endpoints. Stores the
 * response in a short-lived cache. On duplicate key, returns the cached response.
 * Follows the Stripe pattern.
 *
 * Supports pluggable stores:
 *   - In-memory Map (default, single instance)
 *   - Upstash Redis (horizontal scaling — call setIdempotencyStore() at startup)
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

const IDEMPOTENCY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const IDEMPOTENCY_MAX_SIZE = 10_000; // cap for in-memory store

interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  createdAt: number;
}

/**
 * Pluggable idempotency store interface.
 * Default: in-memory Map. For horizontal scaling: Upstash Redis adapter.
 */
export interface IIdempotencyStore {
  get(key: string): CachedResponse | undefined | Promise<CachedResponse | undefined>;
  set(key: string, entry: CachedResponse): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

/** In-memory idempotency store (single instance). */
let idempotencyStore: IIdempotencyStore = new Map<string, CachedResponse>();

/** Swap the backing store (e.g., to Upstash Redis adapter). */
export function setIdempotencyStore(store: IIdempotencyStore): void {
  idempotencyStore = store;
}

// Cleanup expired entries every 10 minutes (in-memory only — Redis uses TTL)
let idempotencyCleanupRef: ReturnType<typeof setInterval> | null = setInterval(() => {
  if (!(idempotencyStore instanceof Map)) return; // Redis handles its own TTL
  const now = Date.now();
  for (const [key, entry] of (idempotencyStore as Map<string, CachedResponse>).entries()) {
    if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(key);
    }
  }
}, 10 * 60 * 1000);

/** Stop the idempotency cleanup interval (for graceful shutdown) */
export function stopIdempotencyCleanup(): void {
  if (idempotencyCleanupRef) {
    clearInterval(idempotencyCleanupRef);
    idempotencyCleanupRef = null;
  }
}

/** Clear the idempotency store (for graceful shutdown / testing) */
export function clearIdempotencyStore(): void {
  idempotencyStore.clear();
}

/** Get current store size (for diagnostics / testing) */
export function getIdempotencyStoreSize(): number {
  return idempotencyStore.size;
}

/**
 * Idempotency middleware for POST endpoints.
 *
 * If Idempotency-Key header is present:
 *   - Check cache: if hit, return cached response
 *   - If miss: intercept response, cache it, then send
 *
 * If Idempotency-Key header is absent: pass through (no-op).
 */
export function idempotencyMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Only apply to POST/PUT/PATCH mutations
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      next();
      return;
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      next();
      return;
    }

    // Scope the key to the API key or IP to prevent cross-tenant collisions
    const scopeId = req.apiKey?.keyId ?? req.ip ?? 'anon';
    const cacheKey = `${scopeId}:${idempotencyKey}`;

    // Check cache (may be async for Redis stores)
    const result = idempotencyStore.get(cacheKey);
    const handleCacheResult = (cached: CachedResponse | undefined) => {
      if (cached) {
        logger.debug({ idempotencyKey }, 'Idempotency cache hit — returning cached response');
        res.setHeader('Idempotent-Replayed', 'true');
        for (const [k, v] of Object.entries(cached.headers)) {
          res.setHeader(k, v);
        }
        res.status(cached.statusCode).json(cached.body);
        return;
      }

      // Intercept the response to cache it
      const originalJson = res.json.bind(res);
      res.json = function (body: unknown) {
        const headersToCache: Record<string, string> = {};
        const xRequestId = res.getHeader('X-Request-Id');
        if (xRequestId) headersToCache['X-Request-Id'] = String(xRequestId);

        // Evict expired/oldest entries if at capacity (in-memory only)
        if (idempotencyStore instanceof Map && idempotencyStore.size >= IDEMPOTENCY_MAX_SIZE) {
          const now = Date.now();
          for (const [k, e] of idempotencyStore) {
            if (e.createdAt < now - IDEMPOTENCY_TTL_MS || idempotencyStore.size >= IDEMPOTENCY_MAX_SIZE) {
              idempotencyStore.delete(k);
            }
            if (idempotencyStore.size < IDEMPOTENCY_MAX_SIZE * 0.8) break;
          }
        }

        idempotencyStore.set(cacheKey, {
          statusCode: res.statusCode,
          headers: headersToCache,
          body,
          createdAt: Date.now(),
        });

        return originalJson(body);
      };

      next();
    };

    // Support both sync (Map) and async (Redis) stores
    if (result instanceof Promise) {
      result.then(handleCacheResult).catch(() => next());
    } else {
      handleCacheResult(result);
    }
  };
}
