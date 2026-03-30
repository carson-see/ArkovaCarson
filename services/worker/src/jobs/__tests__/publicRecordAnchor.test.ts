/**
 * Unit tests for Public Record Batch Anchoring
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const {
  mockRpc, mockInsert, mockUpdate, mockSelectChain,
  mockSubmitFingerprint, mockLogger,
} = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockInsert = vi.fn();
  const mockUpdate = vi.fn();
  const mockSubmitFingerprint = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockSingle = vi.fn();
  const mockLimit = vi.fn();
  const mockRange = vi.fn(() => ({ data: [], error: null }));
  const mockOrder = vi.fn(() => ({ limit: mockLimit, range: mockRange }));
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.is = vi.fn(() => selectChain);
  selectChain.not = vi.fn(() => selectChain);
  selectChain.order = mockOrder;
  selectChain.limit = mockLimit;
  selectChain.range = mockRange;
  selectChain.single = mockSingle;
  selectChain.select = vi.fn(() => ({ single: mockSingle }));

  return {
    mockRpc, mockInsert, mockUpdate, mockSubmitFingerprint,
    mockSelectChain: { chain: selectChain, limit: mockLimit, order: mockOrder, single: mockSingle, range: mockRange },
    mockLogger,
  };
});

vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'info',
    nodeEnv: 'test',
    useMocks: true,
    enableProdNetworkAnchoring: false,
    bitcoinNetwork: 'signet',
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

function createMockSupabase(records: Array<Record<string, unknown>> = []) {
  const _updateEq = vi.fn().mockResolvedValue({ error: null });

  let insertCallCount = 0;
  mockInsert.mockImplementation((anchor: Record<string, unknown>) => ({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: { id: `anchor-uuid-${insertCallCount++}`, fingerprint: anchor?.fingerprint ?? 'a'.repeat(64) },
        error: null,
      }),
    }),
  }));

  const mockIs = vi.fn().mockResolvedValue({ error: null });
  mockUpdate.mockReturnValue({
    eq: vi.fn().mockReturnValue({
      is: mockIs,
      eq: vi.fn().mockReturnValue({
        is: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSelectChain.limit.mockResolvedValue({ data: records as any, error: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSelectChain.range.mockResolvedValue({ data: records as any, error: null });

  return {
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
      return {
        select: vi.fn(() => mockSelectChain.chain),
        insert: mockInsert,
        update: mockUpdate,
      };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('publicRecordAnchor', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processPublicRecordAnchoring(createMockSupabase() as any);

    expect(result.processed).toBe(0);
    expect(mockRpc).toHaveBeenCalledWith('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORD_ANCHORING',
    });
  });

  it('skips batch when no unanchored records exist', async () => {
    mockRpc.mockResolvedValue({ data: true });
    const mockSupa = createMockSupabase([]);

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processPublicRecordAnchoring(mockSupa as any);

    expect(result.processed).toBe(0);
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  it('processes batch when enough records exist', async () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      id: `record-${i}`,
      content_hash: (i.toString(16).padStart(2, '0')).repeat(32),
      metadata: {},
      source: 'edgar',
      source_id: `CIK-${i}`,
      source_url: `https://sec.gov/filing/${i}`,
      record_type: '10-K',
      title: `Test Filing ${i}`,
    }));

    // First RPC call = get_flag (returns true), subsequent = batch_insert_anchors (returns anchor array)
    const anchorResults = records.map((r, i) => ({ id: `anchor-uuid-${i}`, fingerprint: r.content_hash }));
    mockRpc
      .mockResolvedValueOnce({ data: true })  // get_flag
      .mockResolvedValueOnce({ data: anchorResults });  // batch_insert_anchors

    const mockSupa = createMockSupabase(records);

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_mock_123',
      blockHeight: 0,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0,
    });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processPublicRecordAnchoring(mockSupa as any);

    expect(mockSubmitFingerprint).toHaveBeenCalledOnce();
    expect(result.merkleRoot).toBeTruthy();
    expect(result.txId).toBe('tx_mock_123');
    expect(result.batchId).toMatch(/^pr_batch_/);
  });
});
