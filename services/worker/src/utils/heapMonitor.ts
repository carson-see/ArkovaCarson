/**
 * Heap Monitor — periodic memory usage logging + pressure detection.
 *
 * Logs V8 heap stats after every cron job and on a 5-minute interval.
 * Emits warnings when heap utilization exceeds thresholds so we catch
 * memory pressure before OOM kills the Cloud Run instance.
 *
 * Constitution 1.4: No PII or secrets in log output.
 */

import v8 from 'v8';
import { logger } from './logger.js';
import { getRateLimitStoreSize } from './rateLimit.js';
import { getIdempotencyStoreSize } from '../middleware/idempotency.js';
import { getCircuitBreakerSize } from '../webhooks/delivery.js';

const HEAP_WARN_THRESHOLD = 0.80; // 80%
const HEAP_CRITICAL_THRESHOLD = 0.90; // 90%

/** Snapshot of heap state for structured logging */
export interface HeapSnapshot {
  heapUsedMB: number;
  heapTotalMB: number;
  heapLimitMB: number;
  rssMB: number;
  externalMB: number;
  heapUtilizationPct: number;
  stores: {
    rateLimit: number;
    idempotency: number;
    circuitBreaker: number;
  };
}

/** Capture current heap state without side effects */
export function captureHeapSnapshot(): HeapSnapshot {
  const mem = process.memoryUsage();
  const stats = v8.getHeapStatistics();
  return {
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    heapLimitMB: Math.round(stats.heap_size_limit / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
    externalMB: Math.round(mem.external / 1024 / 1024),
    heapUtilizationPct: Math.round((mem.heapUsed / stats.heap_size_limit) * 1000) / 10,
    stores: {
      rateLimit: getRateLimitStoreSize(),
      idempotency: getIdempotencyStoreSize(),
      circuitBreaker: getCircuitBreakerSize(),
    },
  };
}

/**
 * Log heap state with appropriate severity based on utilization.
 * Call after cron jobs, batch operations, or on a timer.
 */
export function logHeapStatus(context?: string): HeapSnapshot {
  const snap = captureHeapSnapshot();
  const utilization = snap.heapUtilizationPct / 100;

  const logData = { ...snap, context: context ?? 'periodic' };

  if (utilization >= HEAP_CRITICAL_THRESHOLD) {
    logger.error(logData, `HEAP CRITICAL: ${snap.heapUtilizationPct}% utilization (${snap.heapUsedMB}/${snap.heapLimitMB} MB)`);
  } else if (utilization >= HEAP_WARN_THRESHOLD) {
    logger.warn(logData, `HEAP WARNING: ${snap.heapUtilizationPct}% utilization (${snap.heapUsedMB}/${snap.heapLimitMB} MB)`);
  } else {
    logger.info(logData, `Heap: ${snap.heapUtilizationPct}% (${snap.heapUsedMB}/${snap.heapLimitMB} MB)`);
  }

  return snap;
}

/**
 * Start periodic heap monitoring (every 5 minutes).
 * Returns cleanup function for graceful shutdown.
 */
let monitorIntervalRef: ReturnType<typeof setInterval> | null = null;

export function startHeapMonitor(): void {
  if (monitorIntervalRef) return; // Already running
  monitorIntervalRef = setInterval(() => logHeapStatus('interval'), 5 * 60 * 1000);
  monitorIntervalRef.unref(); // Don't prevent process exit
  logger.info('Heap monitor started (5m interval)');
}

export function stopHeapMonitor(): void {
  if (monitorIntervalRef) {
    clearInterval(monitorIntervalRef);
    monitorIntervalRef = null;
  }
}
