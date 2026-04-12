/**
 * Heap Monitor Tests
 *
 * Validates heap snapshot capture, threshold-based logging, and
 * monitor lifecycle (start/stop).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./rateLimit.js', () => ({
  getRateLimitStoreSize: vi.fn(() => 42),
}));

vi.mock('../middleware/idempotency.js', () => ({
  getIdempotencyStoreSize: vi.fn(() => 7),
}));

vi.mock('../webhooks/delivery.js', () => ({
  getCircuitBreakerSize: vi.fn(() => 3),
}));

describe('heapMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captureHeapSnapshot returns valid heap data', async () => {
    const { captureHeapSnapshot } = await import('./heapMonitor.js');
    const snap = captureHeapSnapshot();

    expect(snap.heapUsedMB).toBeGreaterThan(0);
    expect(snap.heapTotalMB).toBeGreaterThan(0);
    expect(snap.heapLimitMB).toBeGreaterThan(0);
    expect(snap.rssMB).toBeGreaterThan(0);
    expect(snap.heapUtilizationPct).toBeGreaterThan(0);
    expect(snap.heapUtilizationPct).toBeLessThan(100);
  });

  it('captureHeapSnapshot includes store sizes', async () => {
    const { captureHeapSnapshot } = await import('./heapMonitor.js');
    const snap = captureHeapSnapshot();

    expect(snap.stores.rateLimit).toBe(42);
    expect(snap.stores.idempotency).toBe(7);
    expect(snap.stores.circuitBreaker).toBe(3);
  });

  it('logHeapStatus returns a snapshot', async () => {
    const { logHeapStatus } = await import('./heapMonitor.js');
    const snap = logHeapStatus('test');

    expect(snap.heapUsedMB).toBeGreaterThan(0);
    expect(snap.stores).toBeDefined();
  });

  it('startHeapMonitor / stopHeapMonitor lifecycle', async () => {
    const { startHeapMonitor, stopHeapMonitor } = await import('./heapMonitor.js');

    // Should not throw on double start
    startHeapMonitor();
    startHeapMonitor();

    // Should not throw on stop
    stopHeapMonitor();
    stopHeapMonitor();
  });

  it('heapUtilizationPct is calculated correctly', async () => {
    const { captureHeapSnapshot } = await import('./heapMonitor.js');
    const snap = captureHeapSnapshot();

    // heapUtilizationPct should be heapUsed/heapLimit * 100
    // Allow for rounding: the snapshot rounds to 1 decimal place
    const expectedPct = (snap.heapUsedMB / snap.heapLimitMB) * 100;
    expect(Math.abs(snap.heapUtilizationPct - expectedPct)).toBeLessThan(2);
  });
});
