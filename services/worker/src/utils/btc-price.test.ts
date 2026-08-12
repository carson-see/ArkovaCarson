/**
 * Unit tests for the cached BTC/USD quote reader (SCRUM-3128, BUG-2026-08-11).
 *
 * The reader is the ONLY sanctioned way for a request-path caller to get a
 * BTC/USD figure. These tests pin the two properties that make it safe to use
 * on a hot path: it never issues an HTTP call, and it returns null rather than
 * a wrong number for every way the cache can be unusable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockMaybeSingle, mockSelect, mockFrom, mockLogger } = vi.hoisted(() => {
  const mockMaybeSingle = vi.fn();
  const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
  const mockSelect = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ select: mockSelect }));
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mockMaybeSingle, mockSelect, mockFrom, mockLogger };
});

vi.mock('./db.js', () => ({ db: { from: mockFrom } }));
vi.mock('./logger.js', () => ({ logger: mockLogger }));

const NOW = new Date('2026-08-11T12:00:00.000Z');

/** A treasury_cache row shaped like the cron writes it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      btc_price_usd: 100_000,
      updated_at: NOW.toISOString(),
      ...overrides,
    },
    error: null,
  };
}

/** Fresh module per test — the reader memoizes in module scope on purpose. */
async function loadReader() {
  vi.resetModules();
  return import('./btc-price.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockMaybeSingle.mockResolvedValue(row());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeBtcPrice', () => {
  it('accepts a positive finite quote', async () => {
    const { normalizeBtcPrice } = await loadReader();
    expect(normalizeBtcPrice(100_000)).toBe(100_000);
    expect(normalizeBtcPrice(0.5)).toBe(0.5);
  });

  it.each([
    ['the mempool.space non-mainnet sentinel', -1],
    ['zero', 0],
    ['negative', -100_000],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['undefined', undefined],
    ['a numeric string', '100000'],
  ])('rejects %s', async (_label, raw) => {
    const { normalizeBtcPrice } = await loadReader();
    expect(normalizeBtcPrice(raw)).toBeNull();
  });
});

describe('getCachedBtcPriceUsd', () => {
  it('returns the cached quote when the row is usable and fresh', async () => {
    const { getCachedBtcPriceUsd } = await loadReader();

    await expect(getCachedBtcPriceUsd()).resolves.toBe(100_000);
    expect(mockFrom).toHaveBeenCalledWith('treasury_cache');
    expect(mockSelect).toHaveBeenCalledWith('btc_price_usd, updated_at');
  });

  it('never issues an HTTP request — the cron owns the oracle call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { getCachedBtcPriceUsd } = await loadReader();
    await getCachedBtcPriceUsd();

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each([
    ['null (oracle outage recorded by the cron)', null],
    ['the -1 non-mainnet sentinel', -1],
    ['zero', 0],
  ])('returns null and warns when the cached quote is %s', async (_label, price) => {
    mockMaybeSingle.mockResolvedValue(row({ btc_price_usd: price }));
    const { getCachedBtcPriceUsd } = await loadReader();

    await expect(getCachedBtcPriceUsd()).resolves.toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns null when no treasury_cache row exists yet', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { getCachedBtcPriceUsd } = await loadReader();

    await expect(getCachedBtcPriceUsd()).resolves.toBeNull();
  });

  it('returns null and logs when the cache read errors', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const { getCachedBtcPriceUsd } = await loadReader();

    await expect(getCachedBtcPriceUsd()).resolves.toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns null when the cache read throws', async () => {
    mockMaybeSingle.mockRejectedValue(new Error('socket hang up'));
    const { getCachedBtcPriceUsd } = await loadReader();

    await expect(getCachedBtcPriceUsd()).resolves.toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('rejects a quote older than the staleness bound — a dead cron must not price money', async () => {
    const { BTC_PRICE_MAX_AGE_MS, getCachedBtcPriceUsd } = await loadReader();
    mockMaybeSingle.mockResolvedValue(
      row({ updated_at: new Date(NOW.getTime() - BTC_PRICE_MAX_AGE_MS - 1_000).toISOString() }),
    );

    await expect(getCachedBtcPriceUsd()).resolves.toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('accepts a quote just inside the staleness bound', async () => {
    const { BTC_PRICE_MAX_AGE_MS, getCachedBtcPriceUsd } = await loadReader();
    mockMaybeSingle.mockResolvedValue(
      row({ updated_at: new Date(NOW.getTime() - BTC_PRICE_MAX_AGE_MS + 1_000).toISOString() }),
    );

    await expect(getCachedBtcPriceUsd()).resolves.toBe(100_000);
  });

  it.each([
    ['null', null],
    ['an unparseable string', 'not-a-date'],
  ])('rejects a row whose updated_at is %s — unknown age is not fresh', async (_label, updatedAt) => {
    mockMaybeSingle.mockResolvedValue(row({ updated_at: updatedAt }));
    const { getCachedBtcPriceUsd } = await loadReader();

    await expect(getCachedBtcPriceUsd()).resolves.toBeNull();
  });

  it('memoizes within the TTL so a request burst costs one DB read', async () => {
    const { getCachedBtcPriceUsd } = await loadReader();

    await getCachedBtcPriceUsd();
    await getCachedBtcPriceUsd();
    await getCachedBtcPriceUsd();

    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent callers into a single DB read', async () => {
    const { getCachedBtcPriceUsd } = await loadReader();

    const results = await Promise.all([
      getCachedBtcPriceUsd(),
      getCachedBtcPriceUsd(),
      getCachedBtcPriceUsd(),
    ]);

    expect(results).toEqual([100_000, 100_000, 100_000]);
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the memo expires and picks up the new quote', async () => {
    const { BTC_PRICE_MEMO_TTL_MS, getCachedBtcPriceUsd } = await loadReader();

    await expect(getCachedBtcPriceUsd()).resolves.toBe(100_000);

    mockMaybeSingle.mockResolvedValue(row({ btc_price_usd: 90_000 }));
    vi.setSystemTime(new Date(NOW.getTime() + BTC_PRICE_MEMO_TTL_MS + 1));

    await expect(getCachedBtcPriceUsd()).resolves.toBe(90_000);
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it('memoizes an unusable result too, so an outage cannot stampede the DB', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'down' } });
    const { getCachedBtcPriceUsd } = await loadReader();

    await getCachedBtcPriceUsd();
    await getCachedBtcPriceUsd();

    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('recovers after a rejected read rather than wedging on the in-flight promise', async () => {
    const { BTC_PRICE_MEMO_TTL_MS, getCachedBtcPriceUsd } = await loadReader();
    mockMaybeSingle.mockRejectedValueOnce(new Error('socket hang up'));

    await expect(getCachedBtcPriceUsd()).resolves.toBeNull();

    mockMaybeSingle.mockResolvedValue(row());
    vi.setSystemTime(new Date(NOW.getTime() + BTC_PRICE_MEMO_TTL_MS + 1));

    await expect(getCachedBtcPriceUsd()).resolves.toBe(100_000);
  });
});
