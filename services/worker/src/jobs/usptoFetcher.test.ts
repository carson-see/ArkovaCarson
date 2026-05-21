import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { fetchUsptoPAtents } = await import('./usptoFetcher.js');

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
});
