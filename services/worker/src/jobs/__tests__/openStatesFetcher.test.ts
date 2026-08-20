/**
 * Open States fetcher tests — BUG-022.
 *
 * The v3 API rejects a comma-joined `include` with HTTP 422:
 *
 *     include=abstracts,sponsorships        → 422
 *     include=abstracts&include=sponsorships → 200
 *
 * verified in both directions against the live API with a valid key
 * (`docs/staging/fullsoak-2026-08/side-rig-cron-coverage.md`). The 422 body
 * names it: "value is not a valid enumeration member; permitted:
 * 'sponsorships', 'abstracts', …".
 *
 * This broke `/fetch-state-bills` and `/fetch-all-state-bills` 100% of the
 * time, and both still returned HTTP 200 — so the request-shape assertions
 * below are the regression guard that a green run cannot provide.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { fetchStateBills, fetchMultipleStateBills } = await import('../openStatesFetcher.js');

/** Supabase double: flag on, no existing rows, upserts succeed. */
function makeSupabase() {
  mockRpc.mockResolvedValue({ data: true });
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        ilike: vi.fn().mockResolvedValue({ count: 0 }),
      }),
    }),
    upsert: vi.fn().mockResolvedValue({ error: null, count: 0 }),
  });
  return { rpc: mockRpc, from: mockFrom } as unknown as Parameters<typeof fetchStateBills>[0];
}

function emptyPage() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: [], pagination: { per_page: 20, page: 1, max_page: 1, total_items: 0 } }),
  };
}

describe('openStatesFetcher — include parameter (BUG-022)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    process.env.OPENSTATES_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENSTATES_API_KEY;
  });

  it('sends REPEATED include params, not a comma-joined value', async () => {
    const mockFetch = vi.fn().mockResolvedValue(emptyPage());
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await fetchStateBills(makeSupabase(), { stateCode: 'CA', maxPages: 1 });

    expect(mockFetch).toHaveBeenCalled();
    const url = new URL(String(mockFetch.mock.calls[0][0]));

    // The exact defect: a single comma-joined value is a 422 from the v3 API.
    expect(url.search).not.toContain('abstracts%2Csponsorships');
    expect(url.search).not.toContain('abstracts,sponsorships');

    // The fix: one `include` param per enumeration member.
    expect(url.searchParams.getAll('include')).toEqual(['abstracts', 'sponsorships']);
  });

  it('still sends the other query params unchanged', async () => {
    const mockFetch = vi.fn().mockResolvedValue(emptyPage());
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await fetchStateBills(makeSupabase(), { stateCode: 'NY', maxPages: 1 });

    const url = new URL(String(mockFetch.mock.calls[0][0]));
    expect(url.searchParams.get('jurisdiction')).toBe(
      'ocd-jurisdiction/country:us/state:ny/government',
    );
    expect(url.searchParams.get('sort')).toBe('updated_desc');
    expect(url.searchParams.get('per_page')).toBe('20');
    expect(url.searchParams.get('page')).toBe('1');
  });

  it('reports a missing API key as unconfigured_source rather than a silent no-op', async () => {
    delete process.env.OPENSTATES_API_KEY;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const result = await fetchStateBills(makeSupabase(), { stateCode: 'CA', maxPages: 1 });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.status).toBe('unconfigured_source');
  });

  it('counts an upstream 4xx as an error so the route cannot report success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"detail":"value is not a valid enumeration member"}',
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const result = await fetchStateBills(makeSupabase(), { stateCode: 'CA', maxPages: 1 });

    expect(result.errors).toBeGreaterThan(0);
    expect(result.inserted).toBe(0);
  });
});

describe('fetchMultipleStateBills aggregate (BUG-020)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENSTATES_API_KEY;
  });

  it('does not report totalErrors: 0 when every state failed before it could count', async () => {
    delete process.env.OPENSTATES_API_KEY;
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    const result = await fetchMultipleStateBills(makeSupabase(), ['CA', 'NY', 'TX']);

    expect(result.totalInserted).toBe(0);
    expect(result.totalErrors).toBe(3);
    expect(result.stateResults.every((s) => s.status === 'unconfigured_source')).toBe(true);
  });
});
