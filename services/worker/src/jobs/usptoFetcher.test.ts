import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeHangingFetch } from '../test-utils/hanging-fetch.js';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { fetchUsptoPAtents, fetchWithConnectTimeout } = await import('./usptoFetcher.js');

function makeSupabase(opts: { flagEnabled?: boolean } = {}) {
  const enabled = opts.flagEnabled ?? false;
  mockRpc.mockResolvedValue({ data: enabled });
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: [] }),
        }),
      }),
    }),
  });
  return { rpc: mockRpc, from: mockFrom } as unknown as Parameters<typeof fetchUsptoPAtents>[0];
}

describe('usptoFetcher', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns disabled when switchboard flag is off', async () => {
    const result = await fetchUsptoPAtents(makeSupabase({ flagEnabled: false }));
    expect(result.status).toBe('disabled');
  });

  it('retries once on transient TypeError: terminated', async () => {
    vi.useRealTimers();
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('terminated'))
      .mockResolvedValueOnce({ ok: false, status: 503, body: null });

    globalThis.fetch = mockFetch;

    const result = await fetchUsptoPAtents(makeSupabase({ flagEnabled: true }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('download_failed');
  }, 10_000);

  it('does not retry on non-transient fetch errors', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('DNS resolution failed'));

    globalThis.fetch = mockFetch;

    const result = await fetchUsptoPAtents(makeSupabase({ flagEnabled: true }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('download_failed');
  });

  it('bounds a hung connect instead of hanging indefinitely (unbounded-fetch bug)', async () => {
    vi.useRealTimers();
    globalThis.fetch = makeHangingFetch() as unknown as typeof fetch;

    const start = Date.now();
    const result = await fetchUsptoPAtents(makeSupabase({ flagEnabled: true }), {
      connectTimeoutMs: 50,
    });
    const elapsed = Date.now() - start;

    // Pre-fix this call never resolved. Post-fix it must resolve well within
    // a small multiple of the 50ms connect timeout, not hang indefinitely.
    expect(elapsed).toBeLessThan(2_000);
    expect(result.status).toBe('download_failed');
  }, 10_000);

  it('logs a timedOut marker when the abort reason is an AbortError', async () => {
    const { logger } = await import('../utils/logger.js');
    vi.useRealTimers();
    globalThis.fetch = makeHangingFetch() as unknown as typeof fetch;

    await fetchUsptoPAtents(makeSupabase({ flagEnabled: true }), { connectTimeoutMs: 20 });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ timedOut: true }),
      'Failed to download PatentsView bulk data',
    );
  }, 10_000);
});

describe('fetchWithConnectTimeout (unbounded-fetch bug fix)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('rejects a hung connect within the given timeout instead of hanging forever', async () => {
    vi.useRealTimers();
    globalThis.fetch = makeHangingFetch() as unknown as typeof fetch;

    const start = Date.now();
    await expect(fetchWithConnectTimeout('https://example.test/big.zip', 50)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    expect(Date.now() - start).toBeLessThan(1_000);
  }, 10_000);

  it('does NOT abort after resolving — a slow-but-healthy body stream is never cut off', async () => {
    // fetch() resolves quickly (headers arrive well inside the timeout); the
    // signal must not still be armed afterward, since a real ~230MB body read
    // can legitimately continue for minutes past the connect timeout.
    vi.useRealTimers();
    let capturedSignal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return Promise.resolve({ ok: true, status: 200, body: {} } as unknown as Response);
    }) as unknown as typeof fetch;

    await fetchWithConnectTimeout('https://example.test/big.zip', 20);

    // Wait well past the 20ms connect timeout — if the timer weren't cleared,
    // the signal would fire here and any in-flight body read would be killed.
    await new Promise((r) => setTimeout(r, 100));
    expect(capturedSignal?.aborted).toBe(false);
  });
});
