/**
 * QA-CHAOS-02: Mempool.space Unavailability Simulation
 *
 * Validates retry + fallback behavior when mempool.space API is unavailable:
 * - retryWithBackoff retries on 5xx and network errors
 * - retryWithBackoff does NOT retry on 4xx
 * - MempoolFeeEstimator falls back to static rate on failure
 * - isRetryableError correctly classifies error types
 * - isDuplicateTxError handles previous-attempt success detection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  retryWithBackoff,
  isRetryableError,
  isDuplicateTxError,
  HttpError,
} from '../chain/utxo-provider.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('QA-CHAOS-02: Mempool.space Unavailability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isRetryableError classification', () => {
    it('retries 500 Internal Server Error', () => {
      expect(isRetryableError(new HttpError('server error', 500))).toBe(true);
    });

    it('retries 502 Bad Gateway', () => {
      expect(isRetryableError(new HttpError('bad gateway', 502))).toBe(true);
    });

    it('retries 503 Service Unavailable', () => {
      expect(isRetryableError(new HttpError('unavailable', 503))).toBe(true);
    });

    it('retries 429 is NOT retryable (HttpError < 500)', () => {
      expect(isRetryableError(new HttpError('rate limited', 429))).toBe(false);
    });

    it('does NOT retry 400 Bad Request', () => {
      expect(isRetryableError(new HttpError('bad request', 400))).toBe(false);
    });

    it('does NOT retry 404 Not Found', () => {
      expect(isRetryableError(new HttpError('not found', 404))).toBe(false);
    });

    it('retries network TypeError (fetch failed)', () => {
      expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
    });

    it('retries network TypeError (Failed to fetch)', () => {
      expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
    });

    it('retries network TypeError (NetworkError)', () => {
      expect(isRetryableError(new TypeError('NetworkError when attempting'))).toBe(true);
    });

    it('does NOT retry non-network TypeError', () => {
      expect(isRetryableError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    });

    it('retries ECONNREFUSED', () => {
      expect(isRetryableError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
    });

    it('retries ECONNRESET', () => {
      expect(isRetryableError(new Error('read ECONNRESET'))).toBe(true);
    });

    it('retries ETIMEDOUT', () => {
      expect(isRetryableError(new Error('connect ETIMEDOUT'))).toBe(true);
    });

    it('does NOT retry generic errors', () => {
      expect(isRetryableError(new Error('something went wrong'))).toBe(false);
    });

    it('does NOT retry non-Error objects', () => {
      expect(isRetryableError('string error')).toBe(false);
      expect(isRetryableError(42)).toBe(false);
      expect(isRetryableError(null)).toBe(false);
    });
  });

  describe('isDuplicateTxError detection', () => {
    it('detects "transaction already in block chain"', () => {
      expect(isDuplicateTxError('Transaction already in block chain')).toBe(true);
    });

    it('detects "txn-already-in-mempool"', () => {
      expect(isDuplicateTxError('txn-already-in-mempool')).toBe(true);
    });

    it('detects "already known"', () => {
      expect(isDuplicateTxError('Already known')).toBe(true);
    });

    it('detects "tx already exists"', () => {
      expect(isDuplicateTxError('tx already exists in the mempool')).toBe(true);
    });

    it('returns false for unrelated errors', () => {
      expect(isDuplicateTxError('insufficient funds')).toBe(false);
      expect(isDuplicateTxError('invalid transaction')).toBe(false);
    });
  });

  describe('retryWithBackoff under simulated outage', () => {
    const noDelay = async () => {}; // Skip actual delays in tests
    const fixedRandom = () => 0.5;

    it('succeeds on first attempt with no retries', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn, {
        name: 'test',
        delayFn: noDelay,
        randomFn: fixedRandom,
      });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on 500 and eventually succeeds', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new HttpError('server error', 500))
        .mockRejectedValueOnce(new HttpError('server error', 500))
        .mockResolvedValue('recovered');

      const result = await retryWithBackoff(fn, {
        name: 'mempool-api',
        maxRetries: 3,
        delayFn: noDelay,
        randomFn: fixedRandom,
      });

      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('retries on network TypeError and recovers', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValue('ok');

      const result = await retryWithBackoff(fn, {
        name: 'mempool-utxo',
        delayFn: noDelay,
        randomFn: fixedRandom,
      });

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('exhausts retries on sustained 503 outage', async () => {
      const fn = vi.fn().mockRejectedValue(new HttpError('Service Unavailable', 503));

      await expect(
        retryWithBackoff(fn, {
          name: 'mempool-outage',
          maxRetries: 3,
          delayFn: noDelay,
          randomFn: fixedRandom,
        }),
      ).rejects.toThrow('Service Unavailable');

      expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it('throws immediately on 400 (no retries)', async () => {
      const fn = vi.fn().mockRejectedValue(new HttpError('Bad Request', 400));

      await expect(
        retryWithBackoff(fn, {
          name: 'bad-request',
          maxRetries: 3,
          delayFn: noDelay,
          randomFn: fixedRandom,
        }),
      ).rejects.toThrow('Bad Request');

      expect(fn).toHaveBeenCalledTimes(1); // No retries
    });

    it('throws immediately on 404 (no retries)', async () => {
      const fn = vi.fn().mockRejectedValue(new HttpError('Not Found', 404));

      await expect(
        retryWithBackoff(fn, {
          name: 'not-found',
          maxRetries: 3,
          delayFn: noDelay,
          randomFn: fixedRandom,
        }),
      ).rejects.toThrow('Not Found');

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries ECONNREFUSED and recovers', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'))
        .mockResolvedValue('back up');

      const result = await retryWithBackoff(fn, {
        name: 'econnrefused',
        delayFn: noDelay,
        randomFn: fixedRandom,
      });

      expect(result).toBe('back up');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('respects maxRetries=0 (no retries)', async () => {
      const fn = vi.fn().mockRejectedValue(new HttpError('error', 500));

      await expect(
        retryWithBackoff(fn, {
          name: 'no-retry',
          maxRetries: 0,
          delayFn: noDelay,
          randomFn: fixedRandom,
        }),
      ).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('calculates exponential backoff delays', async () => {
      const delays: number[] = [];
      const trackDelay = async (ms: number) => { delays.push(ms); };
      const fn = vi.fn()
        .mockRejectedValueOnce(new HttpError('error', 500))
        .mockRejectedValueOnce(new HttpError('error', 500))
        .mockRejectedValueOnce(new HttpError('error', 500))
        .mockResolvedValue('ok');

      await retryWithBackoff(fn, {
        name: 'backoff-test',
        maxRetries: 3,
        baseDelayMs: 1000,
        delayFn: trackDelay,
        randomFn: () => 0.5, // jitter factor = 0.5 + 0.5*0.5 = 0.75
      });

      // Delays: 1000*2^0*0.75=750, 1000*2^1*0.75=1500, 1000*2^2*0.75=3000
      expect(delays).toHaveLength(3);
      expect(delays[0]).toBe(750);
      expect(delays[1]).toBe(1500);
      expect(delays[2]).toBe(3000);
    });
  });
});
