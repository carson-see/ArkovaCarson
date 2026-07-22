import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRpc = vi.fn();

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { fetchCourtOpinions } = await import('./courtlistenerFetcher.js');

function makeSupabase(opts: { flagEnabled?: boolean } = {}) {
  const enabled = opts.flagEnabled ?? false;
  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'get_flag') return Promise.resolve({ data: enabled });
    // get_source_date_range: no prior rows, so no date-based resume kicks in.
    return Promise.resolve({ data: null });
  });
  return { rpc: mockRpc } as unknown as Parameters<typeof fetchCourtOpinions>[0];
}

/**
 * A `fetch` stub that simulates a stalled upstream: it never resolves on its
 * own, but DOES honour `init.signal` the way real fetch does — rejecting with
 * the signal's abort reason once the signal fires. This is what lets the test
 * prove `AbortSignal.timeout` actually bounds the call without waiting for a
 * real network hang.
 */
function makeHangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal wired — would hang forever (the bug)
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  });
}

describe('courtlistenerFetcher (SCRUM-2975 unbounded-fetch fix)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('returns zero results and never calls fetch when the switchboard flag is off', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await fetchCourtOpinions(makeSupabase({ flagEnabled: false }));

    expect(result).toEqual({ inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes an AbortSignal on every page fetch so a stalled upstream can be bounded', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ count: 0, next: null, previous: null, results: [] }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await fetchCourtOpinions(makeSupabase({ flagEnabled: true }), { maxPages: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds a hung upstream fetch instead of hanging until BULK_MAX_PAGES times out (SCRUM-2975)', async () => {
    vi.useRealTimers();
    globalThis.fetch = makeHangingFetch() as unknown as typeof fetch;

    const start = Date.now();
    const result = await fetchCourtOpinions(makeSupabase({ flagEnabled: true }), {
      maxPages: 1,
      fetchTimeoutMs: 50,
    });
    const elapsed = Date.now() - start;

    // Pre-fix this call never resolved. Post-fix it must resolve well within
    // a small multiple of the 50ms fetch timeout, not hang indefinitely.
    expect(elapsed).toBeLessThan(2_000);
    expect(result.pagesProcessed).toBe(0);
    expect(result.errors).toBeGreaterThan(0);
  }, 10_000);

  it('logs a timedOut marker when the abort reason is a TimeoutError', async () => {
    const { logger } = await import('../utils/logger.js');
    vi.useRealTimers();
    globalThis.fetch = makeHangingFetch() as unknown as typeof fetch;

    await fetchCourtOpinions(makeSupabase({ flagEnabled: true }), {
      maxPages: 1,
      fetchTimeoutMs: 20,
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ timedOut: true }),
      'CourtListener API request failed',
    );
  }, 10_000);

  it('still backs off 30s and continues on an explicit 429 (existing behavior preserved)', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, ok: false })
      .mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ count: 0, next: null, previous: null, results: [] }),
      }) as unknown as typeof fetch;

    // maxPages counts loop iterations, and a 429 `continue` consumes one — need
    // 2 so the retried page after the backoff still gets its own iteration.
    const promise = fetchCourtOpinions(makeSupabase({ flagEnabled: true }), { maxPages: 2 });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(result.pagesProcessed).toBe(1);
  });
});
