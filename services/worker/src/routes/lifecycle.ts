/**
 * Server Lifecycle Management
 *
 * Graceful shutdown and active operation tracking.
 * Extracted from index.ts as part of ARCH-1 refactor.
 */

import { Server } from 'http';
import { logger } from '../utils/logger.js';
import { stopRateLimitCleanup } from '../utils/rateLimit.js';
import { stopIdempotencyCleanup, clearIdempotencyStore } from '../middleware/idempotency.js';
import { resetCircuitBreakers } from '../webhooks/delivery.js';

// ERR-3: Track active job operations for graceful shutdown
const activeOps = new Set<Promise<unknown>>();

/** Register an in-flight operation for graceful shutdown tracking */
export function trackOperation<T>(promise: Promise<T>): Promise<T> {
  activeOps.add(promise);
  const cleanup = () => activeOps.delete(promise);
  promise.then(cleanup, cleanup);
  return promise;
}

/** Get count of active operations (for diagnostics) */
export function getActiveOperationCount(): number {
  return activeOps.size;
}

/** Set up graceful shutdown handlers for the HTTP server */
export function setupGracefulShutdown(server: Server): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal, activeOps: activeOps.size }, 'Received shutdown signal');

    // LEAK-5: Clear all intervals and in-memory caches to allow clean event loop drain
    stopRateLimitCleanup();
    stopIdempotencyCleanup();
    clearIdempotencyStore();
    resetCircuitBreakers();

    // Force exit after 30 seconds if server.close() hangs
    const forceTimer = setTimeout(() => {
      logger.warn('Forcing shutdown after timeout');
      process.exit(1);
    }, 30000);
    forceTimer.unref();

    // ERR-3: Await all in-flight job operations before closing
    if (activeOps.size > 0) {
      logger.info({ count: activeOps.size }, 'Awaiting in-flight operations before shutdown');
      await Promise.allSettled([...activeOps]);
      logger.info('All in-flight operations completed');
    }

    server.close(() => {
      logger.info('HTTP server closed — all connections drained');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
