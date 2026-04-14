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

  it('maps all pipeline sources to correct credential types', async () => {
    // NPH-01: Verify every pipeline source maps to its correct credential_type
    const { mapCredentialType } = await import('../publicRecordAnchor.js') as unknown as {
      mapCredentialType: (source: string) => string;
    };

    // Original mappings (migration 0091)
    expect(mapCredentialType('edgar')).toBe('SEC_FILING');
    expect(mapCredentialType('uspto')).toBe('PATENT');
    expect(mapCredentialType('openalex')).toBe('PUBLICATION');
    expect(mapCredentialType('federal_register')).toBe('REGULATION');
    expect(mapCredentialType('courtlistener')).toBe('LEGAL');

    // NPH-01 fixes: sources that were incorrectly mapped to OTHER
    expect(mapCredentialType('npi')).toBe('MEDICAL');
    expect(mapCredentialType('finra')).toBe('FINANCIAL');
    expect(mapCredentialType('dapip')).toBe('ACCREDITATION');
    expect(mapCredentialType('calbar')).toBe('LICENSE');
    expect(mapCredentialType('sec_iapd')).toBe('FINANCIAL');
    expect(mapCredentialType('acnc')).toBe('CHARITY');
    expect(mapCredentialType('fcc')).toBe('LICENSE');
    expect(mapCredentialType('openstates')).toBe('REGULATION');
    expect(mapCredentialType('sam_gov')).toBe('CERTIFICATE');
    expect(mapCredentialType('sam_gov_exclusions')).toBe('CERTIFICATE');

    // Unknown sources still fall back to OTHER
    expect(mapCredentialType('unknown_source')).toBe('OTHER');
  });

  it('builds correct filename prefixes for all sources', async () => {
    const { buildAnchorFilename } = await import('../publicRecordAnchor.js') as unknown as {
      buildAnchorFilename: (record: { source: string; source_id: string; title: string | null; record_type: string }) => string;
    };

    expect(buildAnchorFilename({ source: 'npi', source_id: '123', title: 'Dr. Smith', record_type: 'provider' }))
      .toBe('[NPI] Dr. Smith');
    expect(buildAnchorFilename({ source: 'finra', source_id: '456', title: 'Broker Check', record_type: 'broker' }))
      .toBe('[FINRA] Broker Check');
    expect(buildAnchorFilename({ source: 'dapip', source_id: '789', title: 'State University', record_type: 'institution' }))
      .toBe('[DAPIP] State University');
    expect(buildAnchorFilename({ source: 'calbar', source_id: '101', title: 'Attorney Record', record_type: 'attorney' }))
      .toBe('[CALBAR] Attorney Record');
    expect(buildAnchorFilename({ source: 'sec_iapd', source_id: '202', title: 'Investment Advisor', record_type: 'advisor' }))
      .toBe('[IAPD] Investment Advisor');
    expect(buildAnchorFilename({ source: 'acnc', source_id: '303', title: 'Charity Name', record_type: 'charity' }))
      .toBe('[ACNC] Charity Name');
    expect(buildAnchorFilename({ source: 'fcc', source_id: '404', title: 'License Record', record_type: 'license' }))
      .toBe('[FCC] License Record');
    expect(buildAnchorFilename({ source: 'openstates', source_id: '505', title: 'Bill HB-101', record_type: 'bill' }))
      .toBe('[BILL] Bill HB-101');
    expect(buildAnchorFilename({ source: 'sam_gov', source_id: '606', title: 'Contractor Entity', record_type: 'entity' }))
      .toBe('[SAM] Contractor Entity');
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
