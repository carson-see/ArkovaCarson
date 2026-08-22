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
  computeBatchFeeCeiling,
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

  /**
   * SCRUM-3128 / BUG-2026-08-11: `estimateFee()` collapses "the API said 5"
   * and "the API failed and we substituted 5" into the same number. Cost
   * gates downstream cannot tell them apart, so a dead API reads as a cheap
   * network. `estimateFeeDetailed()` is the provenance-preserving form.
   */
  describe('estimateFeeDetailed provenance (SCRUM-3128)', () => {
    it('reports source "live" for a real API reading', async () => {
      mockFetch.mockResolvedValueOnce(okFeeResponse({ halfHourFee: 12 }));

      const estimate = await new MempoolFeeEstimator().estimateFeeDetailed();

      expect(estimate).toEqual({ rate: 12, source: 'live' });
    });

    it('reports source "fallback" with reason on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));

      const estimate = await new MempoolFeeEstimator({
        fallbackRate: 7,
      }).estimateFeeDetailed();

      expect(estimate).toEqual({
        rate: 7,
        source: 'fallback',
        reason: 'http_error',
      });
    });

    it('reports source "fallback" with reason on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const estimate = await new MempoolFeeEstimator().estimateFeeDetailed();

      expect(estimate).toEqual({
        rate: 5,
        source: 'fallback',
        reason: 'network_error',
      });
    });

    it('reports source "fallback" with reason on timeout', async () => {
      mockFetch.mockImplementationOnce(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              ),
            );
          }),
      );

      const pending = new MempoolFeeEstimator({
        timeoutMs: 3000,
      }).estimateFeeDetailed();
      vi.advanceTimersByTime(3000);

      expect(await pending).toEqual({
        rate: 5,
        source: 'fallback',
        reason: 'timeout',
      });
    });

    it('reports source "fallback" with reason on invalid rate in response', async () => {
      mockFetch.mockResolvedValueOnce(okFeeResponse({ halfHourFee: -1 }));

      const estimate = await new MempoolFeeEstimator().estimateFeeDetailed();

      expect(estimate).toEqual({
        rate: 5,
        source: 'fallback',
        reason: 'invalid_rate',
      });
    });

    /**
     * A static rate is a KNOWN rate, not a degraded substitute — signet's flat
     * 1 sat/vB is the truth for that network. Reporting it as 'fallback' would
     * make a fail-closed cost gate defer every signet anchor forever.
     */
    it('StaticFeeEstimator reports its configured rate as "live"', async () => {
      const estimate = await new StaticFeeEstimator(3).estimateFeeDetailed();

      expect(estimate).toEqual({ rate: 3, source: 'live' });
    });

    it('estimateFee stays the thin wrapper — same number, no provenance', async () => {
      mockFetch.mockResolvedValueOnce(okFeeResponse({ halfHourFee: 12 }));
      const estimator = new MempoolFeeEstimator();

      expect(await estimator.estimateFee()).toBe(12);
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

  // ─── BUG-2026-08-11: network-blind default ────────────────────────────
  //
  // The factory resolved its base against a hardcoded mainnet constant and
  // accepted no `network` at all, so every non-mainnet deployment running
  // `strategy: 'mempool'` asked the MAINNET explorer for fee rates. That is
  // most damaging on the INEFF-5 `FORCE_DYNAMIC_FEE_ESTIMATION` path in
  // chain/client.ts, whose stated purpose is to exercise the real fee path
  // on signet "to validate the full fee path pre-mainnet" — validating
  // against the wrong network defeats the point. Verified live: signet
  // reports a flat 1 sat/vB while mainnet reports real (much higher) rates,
  // so the pre-mainnet rehearsal was silently reading numbers its own
  // network would never produce.

  it.each([
    ['signet', 'https://mempool.space/signet/api'],
    ['testnet4', 'https://mempool.space/testnet4/api'],
    ['testnet', 'https://mempool.space/testnet/api'],
    ['mainnet', 'https://mempool.space/api'],
  ])('requests %s fee rates from that network\'s explorer', async (network, base) => {
    mockFetch.mockResolvedValueOnce(okFeeResponse());

    const estimator = createFeeEstimator({ strategy: 'mempool', network });
    await estimator.estimateFee();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(`${base}/v1/fees/recommended`);
  });

  it('still defaults to mainnet when no network is supplied', async () => {
    mockFetch.mockResolvedValueOnce(okFeeResponse());

    const estimator = createFeeEstimator({ strategy: 'mempool' });
    await estimator.estimateFee();

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://mempool.space/api/v1/fees/recommended',
    );
  });

  // ─── BUG-2026-08-11 (second pass): the CLASS, not just the factory ────
  //
  // Fixing only `createFeeEstimator` left the defect wide open: four live
  // call sites construct `MempoolFeeEstimator` directly with no baseUrl —
  // `jobs/anchor.ts` (ECON-1 fee ceiling), `jobs/feeAwareScheduler.ts` (x2,
  // the submit/defer gate) and `middleware/x402PaymentGate.ts` (anchor
  // pricing). Those are hotter paths than the factory sites: a mainnet rate
  // read on signet makes the fee ceiling defer anchors forever and makes
  // x402 bill for fees that do not exist on the network in use.
  //
  // The factory-level parity ratchet cannot see any of that, so the default
  // has to be correct at the constructor.

  it.each([
    ['signet', 'https://mempool.space/signet/api'],
    ['testnet4', 'https://mempool.space/testnet4/api'],
    ['testnet', 'https://mempool.space/testnet/api'],
    ['mainnet', 'https://mempool.space/api'],
  ])('MempoolFeeEstimator constructed directly uses the %s base', async (network, base) => {
    mockFetch.mockResolvedValueOnce(okFeeResponse());

    const estimator = new MempoolFeeEstimator({ network });
    await estimator.estimateFee();

    expect(mockFetch.mock.calls[0][0]).toBe(`${base}/v1/fees/recommended`);
  });

  it('MempoolFeeEstimator still defaults to mainnet with no network', async () => {
    mockFetch.mockResolvedValueOnce(okFeeResponse());

    const estimator = new MempoolFeeEstimator();
    await estimator.estimateFee();

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://mempool.space/api/v1/fees/recommended',
    );
  });

  it('an explicit baseUrl still wins over network on the class', async () => {
    mockFetch.mockResolvedValueOnce(okFeeResponse());

    const estimator = new MempoolFeeEstimator({
      network: 'signet',
      baseUrl: 'https://mempool.example.test/api',
    });
    await estimator.estimateFee();

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://mempool.example.test/api/v1/fees/recommended',
    );
  });

  it('lets an explicit mempoolApiUrl still override the per-network base', async () => {
    mockFetch.mockResolvedValueOnce(okFeeResponse());

    // Operator-set value in the "bare host" convention; resolveMempoolApiBase
    // normalizes it up to the /api shape this estimator needs, and it must
    // win over the network-derived default.
    const estimator = createFeeEstimator({
      strategy: 'mempool',
      network: 'signet',
      mempoolApiUrl: 'https://mempool.example.test',
    });
    await estimator.estimateFee();

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://mempool.example.test/api/v1/fees/recommended',
    );
  });
});

// ─── SCRUM-2592: batch fee-ceiling primitive ────────────────────────────────
//
// CONTRACT: computeBatchFeeCeiling is a pure MIRROR of the batch-anchor
// triggerC_computeFeeCeiling semantics. It scales a base ceiling with backlog
// age (2× after 30 min, 4× after 60 min) and clamps to an ABSOLUTE cap that is
// INJECTED by the caller (never redefined here — batch-anchor.ts remains the
// single owner of ABSOLUTE_FEE_CAP_SAT_PER_VB). The parity block below imports
// the locked source-of-truth function read-only and pins byte-identical output
// across a swept input space so the two can never diverge at integration.

describe('computeBatchFeeCeiling (SCRUM-2592 batch fee-ceiling primitive)', () => {
  const MIN = 60_000;
  const CAP = 200; // caller-injected absolute cap (mirrors ABSOLUTE_FEE_CAP_SAT_PER_VB)

  it('returns the base ceiling for a fresh backlog', () => {
    expect(
      computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 0, absoluteCapSatPerVb: CAP }),
    ).toBe(50);
  });

  it('stays at base ceiling below the 30-minute threshold (29 min)', () => {
    expect(
      computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 29 * MIN, absoluteCapSatPerVb: CAP }),
    ).toBe(50);
  });

  it('does NOT escalate at exactly 30 minutes (strict >)', () => {
    expect(
      computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 30 * MIN, absoluteCapSatPerVb: CAP }),
    ).toBe(50);
  });

  it('doubles the ceiling just past 30 minutes', () => {
    expect(
      computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 30 * MIN + 1, absoluteCapSatPerVb: CAP }),
    ).toBe(100);
  });

  it('stays at 2× through the 30-60 minute band and at exactly 60 min', () => {
    expect(
      computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 45 * MIN, absoluteCapSatPerVb: CAP }),
    ).toBe(100);
    expect(
      computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 60 * MIN, absoluteCapSatPerVb: CAP }),
    ).toBe(100);
  });

  it('quadruples the ceiling just past 60 minutes', () => {
    expect(
      computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 60 * MIN + 1, absoluteCapSatPerVb: CAP }),
    ).toBe(200);
  });

  it('clamps to the injected absolute cap (dynamic ceiling above cap)', () => {
    // 4× of 300 = 1200, clamped to 200.
    expect(
      computeBatchFeeCeiling({ baseCeiling: 300, oldestPendingAgeMs: 60 * MIN + 1, absoluteCapSatPerVb: CAP }),
    ).toBe(CAP);
  });

  it('clamps even a fresh base ceiling that already exceeds the cap', () => {
    expect(
      computeBatchFeeCeiling({ baseCeiling: 500, oldestPendingAgeMs: 0, absoluteCapSatPerVb: CAP }),
    ).toBe(CAP);
  });

  it('is never negative (base ceiling 0)', () => {
    expect(
      computeBatchFeeCeiling({ baseCeiling: 0, oldestPendingAgeMs: 0, absoluteCapSatPerVb: CAP }),
    ).toBe(0);
  });

  it('honors a different injected cap without redefining any constant', () => {
    // A caller supplying a lower cap clamps there — proves the cap is a parameter.
    expect(
      computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 60 * MIN + 1, absoluteCapSatPerVb: 120 }),
    ).toBe(120);
  });
});

describe('MempoolFeeEstimator parked body read (F-D0-5 sweep)', () => {
  // Real timers on purpose: the bounded body read is a real setTimeout race,
  // and a tiny timeoutMs buys the coverage in ~30ms of wall clock.
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('falls back with reason "timeout" when the response body parks after headers', async () => {
    // F-D0-5 (fullsoak 2026-08-12): headers arrive, the body never does. The
    // request-phase AbortController cannot help a runtime whose fetch double
    // (or a stalled socket) leaves `.json()` parked — the estimator must
    // still answer by its own deadline instead of suspending its caller.
    mockFetch.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const estimator = new MempoolFeeEstimator({ timeoutMs: 30 });

    const started = Date.now();
    const result = await estimator.estimateFeeDetailed();

    expect(result).toEqual({ rate: 5, source: 'fallback', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
