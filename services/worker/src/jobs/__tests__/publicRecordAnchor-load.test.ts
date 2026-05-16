/**
 * Load + pool-saturation tests for Public Record Batch Anchoring (SCRUM-1296).
 *
 * AC:
 *   - 1000 anchors processed in < 30s p95
 *   - No connection-pool saturation (max concurrent DB calls < pool limit)
 *   - Priority sources fetched in parallel (not sequential)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks with call tracking ----
const {
  mockRpc, mockSubmitFingerprint, mockLogger, mockAnchorProofsUpsert,
  concurrencyTracker,
} = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockSubmitFingerprint = vi.fn();
  const mockAnchorProofsUpsert = vi.fn().mockResolvedValue({ error: null });
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // Track max concurrent DB operations for pool saturation test
  const concurrencyTracker = {
    current: 0,
    max: 0,
    calls: 0,
    reset() {
      this.current = 0;
      this.max = 0;
      this.calls = 0;
    },
    enter() {
      this.calls++;
      this.current++;
      if (this.current > this.max) this.max = this.current;
    },
    exit() {
      this.current--;
    },
  };

  return {
    mockRpc, mockSubmitFingerprint, mockLogger,
    mockAnchorProofsUpsert, concurrencyTracker,
  };
});

vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'info',
    nodeEnv: 'test',
    useMocks: true,
    enableProdNetworkAnchoring: false,
    bitcoinNetwork: 'signet',
    batchAnchorMaxSize: 10_000,
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../../utils/db.js', () => ({
  db: {},
}));

vi.mock('../../chain/client.js', () => ({
  getInitializedChainClient: () => ({
    submitFingerprint: mockSubmitFingerprint,
  }),
  getChainClientAsync: () => Promise.resolve({
    submitFingerprint: mockSubmitFingerprint,
  }),
}));

vi.mock('../../utils/anchorProofs.js', () => ({
  upsertAnchorProofs: mockAnchorProofsUpsert,
}));

/** DB pool limit — Supabase default */
const POOL_LIMIT = 20;

function makeRecord(i: number, source: string) {
  return {
    id: `record-${source}-${i}`,
    content_hash: `${i.toString(16).padStart(8, '0')}${source.slice(0, 4).padEnd(4, '0')}`.padEnd(64, 'a'),
    metadata: {},
    source,
    source_id: `${source}-${i}`,
    source_url: `https://example.com/${source}/${i}`,
    record_type: 'filing',
    title: `Test ${source} Record ${i}`,
  };
}

/**
 * Creates a mock Supabase client that tracks concurrent calls.
 * Distributes records across priority sources to test parallel fetching.
 */
function createLoadMockSupabase(totalRecords: number) {
  const sources = ['courtlistener', 'edgar', 'federal_register', 'dapip'];
  const perSource = Math.ceil(totalRecords / sources.length);
  const recordsBySource: Record<string, ReturnType<typeof makeRecord>[]> = {};

  for (const source of sources) {
    recordsBySource[source] = Array.from(
      { length: perSource },
      (_, i) => makeRecord(i, source),
    );
  }

  const allRecords = sources.flatMap((s) => recordsBySource[s]).slice(0, totalRecords);
  const anchorResults = allRecords.map((r, i) => ({ id: `anchor-uuid-${i}`, fingerprint: r.content_hash }));
  const anchorRows = anchorResults.map((a) => ({
    id: a.id,
    fingerprint: a.fingerprint,
    status: 'PENDING',
    chain_tx_id: null,
    metadata: {},
  }));
  const claimedRows = anchorRows.map((a) => ({ ...a, status: 'BROADCASTING' }));

  mockRpc
    .mockImplementation((fnName: string) => {
      if (fnName === 'get_flag') return Promise.resolve({ data: true });
      if (fnName === 'batch_insert_anchors') return Promise.resolve({ data: anchorResults });
      if (fnName === 'finalize_public_record_anchor_batch') {
        return Promise.resolve({ data: { records_updated: totalRecords, anchors_updated: totalRecords } });
      }
      if (fnName === 'link_public_records_to_anchors') {
        return Promise.resolve({ data: { records_updated: 0 } });
      }
      return Promise.resolve({ data: null });
    });

  async function trackedDbCall<T>(result: T): Promise<T> {
    concurrencyTracker.enter();
    // Simulate minimal network latency (1ms) to reveal concurrency issues
    await new Promise((r) => setTimeout(r, 1));
    concurrencyTracker.exit();
    return result;
  }

  const client = {
    rpc: mockRpc,
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => trackedDbCall({
                data: { id: 'admin-user-id', org_id: 'admin-org-id' },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'anchors') {
        return {
          select: vi.fn(() => ({
            in: vi.fn(() => ({
              is: vi.fn(() => trackedDbCall({ data: anchorRows, error: null })),
            })),
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(() => trackedDbCall({
                data: anchorResults[0],
                error: null,
              })),
            })),
          })),
          update: vi.fn(() => ({
            in: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => trackedDbCall({ data: claimedRows, error: null })),
              })),
            })),
          })),
        };
      }
      if (table === 'anchor_proofs') {
        return {
          upsert: vi.fn(() => trackedDbCall({ error: null })),
        };
      }
      // public_records table — this is where the parallelization matters
      if (table === 'public_records') {
        return {
          select: vi.fn(() => {
            // Build a chainable query builder that tracks calls
            const chain: Record<string, unknown> = {};
            let selectedSource: string | null = null;
            let isNonPriority = false;

            chain.is = vi.fn(() => chain);
            chain.eq = vi.fn((field: string, value: string) => {
              if (field === 'source') selectedSource = value;
              return chain;
            });
            chain.not = vi.fn(() => {
              isNonPriority = true;
              return chain;
            });
            chain.order = vi.fn(() => chain);
            chain.range = vi.fn((_from: number, _to: number) => {
              // Return source-specific records
              if (isNonPriority) {
                return trackedDbCall({ data: [], error: null });
              }
              const src = selectedSource ?? 'edgar';
              const srcRecords = recordsBySource[src] ?? [];
              const slice = srcRecords.slice(_from, _to + 1);
              return trackedDbCall({ data: slice, error: null });
            });

            return chain;
          }),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => trackedDbCall({ data: null, error: null })),
          })),
        })),
      };
    }),
  };

  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  concurrencyTracker.reset();
  mockAnchorProofsUpsert.mockResolvedValue({ error: null });
});

describe('publicRecordAnchor — load & pool saturation (SCRUM-1296)', () => {
  it('processes 1000 anchors in < 30s wall-clock time', async () => {
    const RECORD_COUNT = 1000;
    const mockSupa = createLoadMockSupabase(RECORD_COUNT);

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_load_test',
      blockHeight: 100,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0,
    });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');

    const start = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processPublicRecordAnchoring(mockSupa as any);
    const elapsed = performance.now() - start;

    expect(result.processed).toBeGreaterThan(0);
    expect(result.txId).toBe('tx_load_test');
    // p95 budget: 30 seconds
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);

  it('max concurrent DB calls stays under pool limit', async () => {
    const RECORD_COUNT = 1000;
    const mockSupa = createLoadMockSupabase(RECORD_COUNT);

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_pool_test',
      blockHeight: 100,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0,
    });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processPublicRecordAnchoring(mockSupa as any);

    // Pool limit assertion: max concurrent calls must stay below pool size
    expect(concurrencyTracker.max).toBeLessThanOrEqual(POOL_LIMIT);
    // Sanity: we actually made DB calls
    expect(concurrencyTracker.calls).toBeGreaterThan(0);
  }, 60_000);

  it('fetches priority sources in parallel (not sequentially)', async () => {
    // This test verifies parallelization by checking that all 4 priority sources
    // are fetched concurrently. We track the timestamps of each source fetch.
    const fetchTimestamps: Array<{ source: string; start: number; end: number }> = [];

    const sources = ['courtlistener', 'edgar', 'federal_register', 'dapip'];
    const recordsBySource: Record<string, ReturnType<typeof makeRecord>[]> = {};
    for (const source of sources) {
      recordsBySource[source] = Array.from({ length: 50 }, (_, i) => makeRecord(i, source));
    }

    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_flag') return Promise.resolve({ data: true });
      if (fnName === 'batch_insert_anchors') {
        const allRecords = sources.flatMap((s) => recordsBySource[s]);
        return Promise.resolve({ data: allRecords.map((r, i) => ({ id: `a-${i}`, fingerprint: r.content_hash })) });
      }
      if (fnName === 'finalize_public_record_anchor_batch') {
        return Promise.resolve({ data: { records_updated: 200, anchors_updated: 200 } });
      }
      return Promise.resolve({ data: null });
    });

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_parallel_test',
      blockHeight: 100,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0,
    });

    const allRecords = sources.flatMap((s) => recordsBySource[s]);
    const anchorRows = allRecords.map((r, i) => ({
      id: `a-${i}`, fingerprint: r.content_hash, status: 'PENDING', chain_tx_id: null, metadata: {},
    }));
    const claimedRows = anchorRows.map((a) => ({ ...a, status: 'BROADCASTING' }));

    const client = {
      rpc: mockRpc,
      from: vi.fn((table: string) => {
        if (table === 'profiles') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'admin-user-id', org_id: 'admin-org-id' },
                  error: null,
                }),
              })),
            })),
          };
        }
        if (table === 'anchors') {
          return {
            select: vi.fn(() => ({
              in: vi.fn(() => ({
                is: vi.fn().mockResolvedValue({ data: anchorRows, error: null }),
              })),
            })),
            update: vi.fn(() => ({
              in: vi.fn(() => ({
                eq: vi.fn(() => ({
                  select: vi.fn().mockResolvedValue({ data: claimedRows, error: null }),
                })),
              })),
            })),
          };
        }
        if (table === 'anchor_proofs') {
          return { upsert: vi.fn().mockResolvedValue({ error: null }) };
        }
        // public_records — track timing per source
        return {
          select: vi.fn(() => {
            const chain: Record<string, unknown> = {};
            let selectedSource: string | null = null;
            let isNonPriority = false;

            chain.is = vi.fn(() => chain);
            chain.eq = vi.fn((field: string, value: string) => {
              if (field === 'source') selectedSource = value;
              return chain;
            });
            chain.not = vi.fn(() => { isNonPriority = true; return chain; });
            chain.order = vi.fn(() => chain);
            chain.range = vi.fn((_from: number, _to: number) => {
              if (isNonPriority) {
                return Promise.resolve({ data: [], error: null });
              }
              const src = selectedSource ?? 'edgar';
              const start = performance.now();
              return new Promise((resolve) => {
                // 5ms simulated latency per source query
                setTimeout(() => {
                  const end = performance.now();
                  fetchTimestamps.push({ source: src, start, end });
                  resolve({ data: recordsBySource[src]?.slice(_from, _to + 1) ?? [], error: null });
                }, 5);
              });
            });
            return chain;
          }),
        };
      }),
    };

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processPublicRecordAnchoring(client as any);

    // With 4 sources and 5ms each:
    // Sequential: total >= 20ms (4 * 5ms)
    // Parallel: total ~5ms (all start at ~same time)
    const priorityFetches = fetchTimestamps.filter((t) => sources.includes(t.source));
    expect(priorityFetches.length).toBeGreaterThanOrEqual(4);

    // Check overlap: if parallel, multiple sources should have overlapping time ranges
    if (priorityFetches.length >= 4) {
      const earliestStart = Math.min(...priorityFetches.map((t) => t.start));
      const latestStart = Math.max(...priorityFetches.map((t) => t.start));
      // In parallel: all start within a very short window (< 3ms)
      // In sequential: starts are spread out by ~5ms each (at least 15ms gap between first and last)
      const startSpread = latestStart - earliestStart;
      expect(startSpread).toBeLessThan(10); // Parallel: all start nearly simultaneously
    }
  }, 30_000);
});
