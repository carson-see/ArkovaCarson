/**
 * Unit tests for query performance monitor (QA-PERF-6)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  recordQueryMetric,
  monitorQuery,
  getQueryStats,
  clearQueryMetrics,
} from './queryMonitor.js';
import { logger } from './logger.js';

describe('queryMonitor', () => {
  beforeEach(() => {
    clearQueryMetrics();
    vi.clearAllMocks();
  });

  describe('recordQueryMetric', () => {
    it('logs debug for fast queries (<1s)', () => {
      recordQueryMetric('test-endpoint', 200, 10);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'test-endpoint', durationMs: 200 }),
        expect.stringContaining('Query completed')
      );
    });

    it('logs warn for slow queries (1-5s)', () => {
      recordQueryMetric('test-endpoint', 2000, 5);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'test-endpoint', durationMs: 2000 }),
        expect.stringContaining('Slow query')
      );
    });

    it('logs error for very slow queries (>5s)', () => {
      recordQueryMetric('test-endpoint', 6000, 3);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'test-endpoint', durationMs: 6000 }),
        expect.stringContaining('SLOW QUERY')
      );
    });

    it('caps metrics at 1000 entries', () => {
      for (let i = 0; i < 1100; i++) {
        recordQueryMetric('cap-test', 100, 1);
      }
      const stats = getQueryStats();
      expect(stats['cap-test'].count).toBe(1000);
    });
  });

  describe('monitorQuery', () => {
    it('wraps a query and records timing', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        data: [{ id: 1 }, { id: 2 }],
        error: null,
      });

      const result = await monitorQuery('nessie-rag', mockQuery);

      expect(result.data).toHaveLength(2);
      expect(result.error).toBeNull();
      expect(mockQuery).toHaveBeenCalledOnce();

      const stats = getQueryStats();
      expect(stats['nessie-rag']).toBeDefined();
      expect(stats['nessie-rag'].count).toBe(1);
      expect(stats['nessie-rag'].totalRows).toBe(2);
    });

    it('handles null data gracefully', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ data: null, error: 'not found' });
      const result = await monitorQuery('missing', mockQuery);
      expect(result.error).toBe('not found');
    });

    it('handles single-row responses', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ data: { id: 1 }, error: null });
      await monitorQuery('single', mockQuery);
      const stats = getQueryStats();
      expect(stats['single'].totalRows).toBe(1);
    });

    it('propagates query errors', async () => {
      const mockQuery = vi.fn().mockRejectedValue(new Error('connection failed'));
      await expect(monitorQuery('fail', mockQuery)).rejects.toThrow('connection failed');
    });
  });

  describe('getQueryStats', () => {
    it('returns empty object when no metrics', () => {
      expect(getQueryStats()).toEqual({});
    });

    it('computes avg, max, p95 correctly', () => {
      // Add 20 metrics: 10 at 100ms, 9 at 200ms, 1 at 3000ms
      for (let i = 0; i < 10; i++) recordQueryMetric('stats-test', 100, 1);
      for (let i = 0; i < 9; i++) recordQueryMetric('stats-test', 200, 1);
      recordQueryMetric('stats-test', 3000, 1);

      const stats = getQueryStats();
      expect(stats['stats-test'].count).toBe(20);
      expect(stats['stats-test'].maxMs).toBe(3000);
      expect(stats['stats-test'].slowCount).toBe(1); // only 3000ms
      expect(stats['stats-test'].avgMs).toBeGreaterThan(100);
      // p95 index = ceil(20 * 0.95) - 1 = 18 (0-indexed). Sorted: [100x10, 200x9, 3000x1] => index 18 = 200
      expect(stats['stats-test'].p95Ms).toBeGreaterThanOrEqual(200);
    });

    it('separates stats by endpoint', () => {
      recordQueryMetric('endpoint-a', 100, 5);
      recordQueryMetric('endpoint-b', 200, 10);
      const stats = getQueryStats();
      expect(Object.keys(stats)).toHaveLength(2);
      expect(stats['endpoint-a'].totalRows).toBe(5);
      expect(stats['endpoint-b'].totalRows).toBe(10);
    });
  });

  describe('clearQueryMetrics', () => {
    it('resets all metrics', () => {
      recordQueryMetric('clear-test', 100, 1);
      clearQueryMetrics();
      expect(getQueryStats()).toEqual({});
    });
  });
});
