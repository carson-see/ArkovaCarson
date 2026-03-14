/**
 * Unit tests for fee-estimator.ts (DH-07: MempoolFeeEstimator request timeout)
 *
 * TDD: Tests written first to define timeout behavior, then implementation.
 *
 * Story: DH-07 — Add AbortController timeout to MempoolFeeEstimator
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Hoisted mocks ----

const { mockLogger, mockFetch } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockFetch = vi.fn();

  return { mockLogger, mockFetch };
});

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

// Mock global fetch
vi.stubGlobal('fetch', mockFetch);

// ---- Imports (after mocks) ----

import {
  StaticFeeEstimator,
  MempoolFeeEstimator,
  createFeeEstimator,
} from './fee-estimator.js';

// ---- Helpers ----

const DEFAULT_FEES: Record<string, number> = { halfHourFee: 12 };

function okFeeResponse(fees: Record<string, number> = DEFAULT_FEES) {
  return new Response(JSON.stringify(fees), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---- Tests ----

describe('StaticFeeEstimator', () => {
  it('returns the configured rate', async () => {
    const estimator = new StaticFeeEstimator(3);
    expect(await estimator.estimateFee()).toBe(3);
  });

  it('defaults to 1 sat/vbyte', async () => {
    const estimator = new StaticFeeEstimator();
    expect(await estimator.estimateFee()).toBe(1);
  });

  it('throws for rate < 1', () => {
    expect(() => new StaticFeeEstimator(0)).toThrow('at least 1');
  });

  it('has name "Static"', () => {
    expect(new StaticFeeEstimator().name).toBe('Static');
  });
});

describe('MempoolFeeEstimator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('successful fetch', () => {
    it('returns the fee rate from mempool API', async () => {
      mockFetch.mockResolvedValueOnce(okFeeResponse({ halfHourFee: 15 }));
      const estimator = new MempoolFeeEstimator();

      const rate = await estimator.estimateFee();

      expect(rate).toBe(15);
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('passes an AbortSignal to fetch', async () => {
      mockFetch.mockResolvedValueOnce(okFeeResponse());
      const estimator = new MempoolFeeEstimator();

      await estimator.estimateFee();

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1]).toBeDefined();
      expect(fetchCall[1].signal).toBeInstanceOf(AbortSignal);
    });

    it('uses configured target field', async () => {
      mockFetch.mockResolvedValueOnce(okFeeResponse({ fastestFee: 25 }));
      const estimator = new MempoolFeeEstimator({ target: 'fastest' });

      const rate = await estimator.estimateFee();

      expect(rate).toBe(25);
    });

    it('uses configured base URL', async () => {
      mockFetch.mockResolvedValueOnce(okFeeResponse());
      const estimator = new MempoolFeeEstimator({
        baseUrl: 'https://mempool.custom.io/api',
      });

      await estimator.estimateFee();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://mempool.custom.io/api/v1/fees/recommended',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  describe('timeout behavior (DH-07)', () => {
    it('defaults to 5000ms timeout', async () => {
      // Simulate a fetch that rejects when aborted via signal
      mockFetch.mockImplementationOnce(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );

      const estimator = new MempoolFeeEstimator();
      const feePromise = estimator.estimateFee();

      // Advance past the 5s default timeout
      vi.advanceTimersByTime(5000);

      const rate = await feePromise;
      expect(rate).toBe(5); // default fallback rate
    });

    it('uses custom timeoutMs from config', async () => {
      mockFetch.mockImplementationOnce(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );

      const estimator = new MempoolFeeEstimator({ timeoutMs: 2000 });
      const feePromise = estimator.estimateFee();

      vi.advanceTimersByTime(2000);

      const rate = await feePromise;
      expect(rate).toBe(5); // fallback
    });

    it('logs a warning with URL and duration on timeout', async () => {
      mockFetch.mockImplementationOnce(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );

      const estimator = new MempoolFeeEstimator({ timeoutMs: 3000 });
      const feePromise = estimator.estimateFee();

      vi.advanceTimersByTime(3000);

      await feePromise;

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/v1/fees/recommended'),
          timeoutMs: 3000,
        }),
        expect.stringContaining('timed out'),
      );
    });

    it('does not abort when fetch succeeds before timeout', async () => {
      mockFetch.mockResolvedValueOnce(okFeeResponse({ halfHourFee: 10 }));

      const estimator = new MempoolFeeEstimator({ timeoutMs: 5000 });
      const rate = await estimator.estimateFee();

      expect(rate).toBe(10);
      // The warn logger should NOT have been called for timeout
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('returns fallback rate on timeout with custom fallback', async () => {
      mockFetch.mockImplementationOnce(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );

      const estimator = new MempoolFeeEstimator({
        timeoutMs: 1000,
        fallbackRate: 8,
      });
      const feePromise = estimator.estimateFee();

      vi.advanceTimersByTime(1000);

      const rate = await feePromise;
      expect(rate).toBe(8);
    });
  });

  describe('error handling', () => {
    it('returns fallback on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('error', { status: 500 }),
      );

      const estimator = new MempoolFeeEstimator({ fallbackRate: 7 });
      const rate = await estimator.estimateFee();

      expect(rate).toBe(7);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('returns fallback on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const estimator = new MempoolFeeEstimator();
      const rate = await estimator.estimateFee();

      expect(rate).toBe(5); // default fallback
    });

    it('returns fallback on invalid rate in response', async () => {
      mockFetch.mockResolvedValueOnce(
        okFeeResponse({ halfHourFee: -1 }),
      );

      const estimator = new MempoolFeeEstimator();
      const rate = await estimator.estimateFee();

      expect(rate).toBe(5);
    });

    it('throws on invalid fallback rate', () => {
      expect(() => new MempoolFeeEstimator({ fallbackRate: 0 })).toThrow(
        'Fallback fee rate must be a finite number >= 1',
      );
    });

    it('throws on timeoutMs of 0', () => {
      expect(() => new MempoolFeeEstimator({ timeoutMs: 0 })).toThrow(
        'timeoutMs must be a positive finite number',
      );
    });

    it('throws on negative timeoutMs', () => {
      expect(() => new MempoolFeeEstimator({ timeoutMs: -100 })).toThrow(
        'timeoutMs must be a positive finite number',
      );
    });

    it('throws on Infinity timeoutMs', () => {
      expect(() => new MempoolFeeEstimator({ timeoutMs: Infinity })).toThrow(
        'timeoutMs must be a positive finite number',
      );
    });

    it('throws on NaN timeoutMs', () => {
      expect(() => new MempoolFeeEstimator({ timeoutMs: NaN })).toThrow(
        'timeoutMs must be a positive finite number',
      );
    });

    it('strips trailing slash from base URL', async () => {
      mockFetch.mockResolvedValueOnce(okFeeResponse());
      const estimator = new MempoolFeeEstimator({
        baseUrl: 'https://example.com/api/',
      });

      await estimator.estimateFee();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/fees/recommended',
        expect.any(Object),
      );
    });
  });

  describe('name property', () => {
    it('returns "Mempool.space"', () => {
      expect(new MempoolFeeEstimator().name).toBe('Mempool.space');
    });
  });
});

describe('createFeeEstimator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates StaticFeeEstimator for "static" strategy', () => {
    const estimator = createFeeEstimator({ strategy: 'static', staticRate: 2 });
    expect(estimator.name).toBe('Static');
  });

  it('creates MempoolFeeEstimator for "mempool" strategy', () => {
    const estimator = createFeeEstimator({ strategy: 'mempool' });
    expect(estimator.name).toBe('Mempool.space');
  });

  it('passes timeoutMs to MempoolFeeEstimator', async () => {
    mockFetch.mockImplementationOnce(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    vi.useFakeTimers();

    const estimator = createFeeEstimator({
      strategy: 'mempool',
      timeoutMs: 2000,
    });

    const feePromise = estimator.estimateFee();
    vi.advanceTimersByTime(2000);

    const rate = await feePromise;
    expect(rate).toBe(5); // fallback after timeout

    vi.useRealTimers();
  });

  it('throws for unknown strategy', () => {
    expect(() =>
      createFeeEstimator({ strategy: 'unknown' as 'static' }),
    ).toThrow('Unknown fee strategy');
  });
});
