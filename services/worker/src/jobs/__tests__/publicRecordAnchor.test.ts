/**
 * Unit tests for Public Record Batch Anchoring
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readMigration } from '../../test-utils/migrations.js';
import { createMockSupabase as _createMockSupabase, grantedRunLeaseTable } from './__testHelpers.js';

// ---- Hoisted mocks ----
const {
  mockRpc, mockInsert, mockUpdate, mockSelectChain,
  mockSubmitFingerprint, mockLogger, mockAnchorProofsUpsert,
} = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockInsert = vi.fn();
  const mockUpdate = vi.fn();
  const mockSubmitFingerprint = vi.fn();
  const mockAnchorProofsUpsert = vi.fn().mockResolvedValue({ error: null });
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockSingle = vi.fn();
  const mockLimit = vi.fn();
  const mockRange = vi.fn(() => ({ data: [] as Record<string, unknown>[], error: null }));
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
    mockAnchorProofsUpsert,
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
  // SCRUM-3031: passthrough by default so existing tests are unaffected;
  // the dedicated retry/backoff tests live in
  // publicRecordAnchor-rpc-hardening.test.ts, which mocks this directly.
  withDbTimeout: vi.fn((operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../chain/client.js', () => ({
  getInitializedChainClient: () => ({
    submitFingerprint: mockSubmitFingerprint,
  }),
  getChainClientAsync: () => Promise.resolve({
    submitFingerprint: mockSubmitFingerprint,
  }),
}));

const captureCreditRpcFailureAlert = vi.hoisted(() => vi.fn());
vi.mock('../../utils/sentry.js', () => ({ captureCreditRpcFailureAlert }));

function makeMock(
  records: Array<Record<string, unknown>> = [],
  options: { revertError?: unknown; claimError?: unknown; fetchError?: unknown } = {},
) {
  const anchorRows = records.map((record, i) => ({
    id: `anchor-uuid-${i}`,
    fingerprint: record.content_hash,
    status: 'PENDING',
    chain_tx_id: null,
    metadata: {},
  }));
  const claimedAnchorRows = anchorRows.map((row) => ({ ...row, status: 'BROADCASTING' }));

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

  mockSelectChain.limit.mockResolvedValue({ data: records, error: null });
  mockSelectChain.range.mockResolvedValue({ data: records, error: null });

  const anchorsSelectByIds = {
    in: vi.fn(() => ({
      is: vi.fn().mockResolvedValue(
        options.fetchError
          ? { data: null, error: options.fetchError }
          : { data: anchorRows, error: null },
      ),
    })),
  };
  const anchorsBroadcastingUpdate = {
    in: vi.fn(() => ({
      eq: vi.fn(() => ({
        select: vi.fn().mockResolvedValue(
          options.claimError
            ? { data: null, error: options.claimError }
            : { data: claimedAnchorRows, error: null },
        ),
      })),
    })),
  };
  // The revert path: BROADCASTING → PENDING after a failed chain submission.
  const anchorsPendingUpdate = {
    in: vi.fn(() => ({
      eq: vi.fn().mockResolvedValue({ error: options.revertError ?? null }),
    })),
  };

  return _createMockSupabase({
    rpcMock: mockRpc,
    fromImpl: vi.fn((table: string) => {
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
          select: vi.fn(() => anchorsSelectByIds),
          insert: mockInsert,
          update: vi.fn((payload: Record<string, unknown>) => (
            payload.status === 'BROADCASTING' ? anchorsBroadcastingUpdate : anchorsPendingUpdate
          )),
        };
      }
      if (table === 'anchor_proofs') {
        return {
          upsert: mockAnchorProofsUpsert,
        };
      }
      // SCRUM-3031: these tests exercise the anchoring pipeline, not the
      // cross-instance run lease — grant it and move on.
      if (table === 'job_queue') {
        return grantedRunLeaseTable();
      }
      return {
        select: vi.fn(() => mockSelectChain.chain),
        insert: mockInsert,
        update: mockUpdate,
      };
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAnchorProofsUpsert.mockResolvedValue({ error: null });
});

describe('publicRecordAnchor', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    const result = await processPublicRecordAnchoring(makeMock().client);

    expect(result.processed).toBe(0);
    expect(mockRpc).toHaveBeenCalledWith('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORD_ANCHORING',
    });
  });

  it('skips batch when no unanchored records exist', async () => {
    mockRpc.mockResolvedValue({ data: true });
    const { client: mockSupa } = makeMock([]);

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    const result = await processPublicRecordAnchoring(mockSupa);

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

    // RPC calls: get_flag, batch_insert_anchors, finalize_public_record_anchor_batch
    const anchorResults = records.map((r, i) => ({ id: `anchor-uuid-${i}`, fingerprint: r.content_hash }));
    mockRpc
      .mockResolvedValueOnce({ data: true })  // get_flag
      .mockResolvedValueOnce({ data: anchorResults })  // batch_insert_anchors
      .mockResolvedValueOnce({ data: { records_updated: records.length, anchors_updated: records.length } });  // finalize

    const { client: mockSupa } = makeMock(records);

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_mock_123',
      blockHeight: 0,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0,
    });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    const result = await processPublicRecordAnchoring(mockSupa);

    expect(mockSubmitFingerprint).toHaveBeenCalledOnce();
    expect(result.merkleRoot).toBeTruthy();
    expect(result.txId).toBe('tx_mock_123');
    expect(result.batchId).toMatch(/^pr_batch_/);
    expect(result.processed).toBe(records.length);
    // Happy path — no alert.
    expect(captureCreditRpcFailureAlert).not.toHaveBeenCalled();
  });

  it('falls back to serial inserts AND alerts Sentry when batch_insert_anchors RPC fails', async () => {
    const records = Array.from({ length: 2 }, (_, i) => ({
      id: `record-${i}`,
      content_hash: (i.toString(16).padStart(2, '0')).repeat(32),
      metadata: {},
      source: 'edgar',
      source_id: `CIK-${i}`,
      source_url: `https://sec.gov/filing/${i}`,
      record_type: '10-K',
      title: `Test Filing ${i}`,
    }));

    mockRpc
      .mockResolvedValueOnce({ data: true }) // get_flag
      .mockResolvedValueOnce({ data: null, error: { message: 'batch_insert_anchors RPC failed' } }) // batch_insert_anchors fails
      .mockResolvedValueOnce({ data: { records_updated: records.length, anchors_updated: records.length } }); // finalize

    const { client: mockSupa } = makeMock(records);

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_mock_456',
      blockHeight: 0,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0,
    });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    await processPublicRecordAnchoring(mockSupa);

    // Serial-insert fallback engaged (per-anchor .insert() on the 'anchors' table).
    expect(mockInsert).toHaveBeenCalled();

    expect(captureCreditRpcFailureAlert).toHaveBeenCalledTimes(1);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        rpc: 'batch_insert_anchors',
        operation: 'publicRecordAnchor.insertAnchorChunk',
        failMode: 'retried',
        orgId: 'admin-user-id',
      }),
    );
  });

  it('persists proof rows outside anchors metadata after finalize', async () => {
    const records = Array.from({ length: 2 }, (_, i) => ({
      id: `record-${i}`,
      content_hash: (i.toString(16).padStart(2, '0')).repeat(32),
      metadata: {},
      source: 'edgar',
      source_id: `CIK-${i}`,
      source_url: `https://sec.gov/filing/${i}`,
      record_type: '10-K',
      title: `Test Filing ${i}`,
    }));

    const anchorResults = records.map((r, i) => ({ id: `anchor-uuid-${i}`, fingerprint: r.content_hash }));
    mockRpc
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: anchorResults })
      .mockResolvedValueOnce({ data: { records_updated: records.length, anchors_updated: records.length } });

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_mock_123',
      blockHeight: 0,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0,
    });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    await processPublicRecordAnchoring(makeMock(records).client);

    expect(mockAnchorProofsUpsert).toHaveBeenCalledOnce();
    expect(mockAnchorProofsUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          anchor_id: 'anchor-uuid-0',
          receipt_id: 'tx_mock_123',
          merkle_root: expect.any(String),
          batch_id: expect.stringMatching(/^pr_batch_/),
        }),
      ]),
      expect.objectContaining({ onConflict: 'anchor_id' }),
    );
  });

  it('uses the shared 10k Bitcoin batch cap', async () => {
    const { PUBLIC_RECORD_BATCH_SIZE } = await import('../publicRecordAnchor.js');
    expect(PUBLIC_RECORD_BATCH_SIZE).toBe(10_000);
  });

  it('keeps duplicate record links eligible after the shared anchor is finalized', () => {
    const sql = readMigration('0248_finalize_public_record_anchor_duplicates.sql');

    expect(sql).toContain("a.status IN ('SUBMITTED', 'SECURED')");
    expect(sql).toContain('a.chain_tx_id = p_tx_id');
    expect(sql).toContain('UPDATE public_records pr');
  });
});

/**
 * The claim-revert escalation (PR #1812), covered through the real entrypoint
 * rather than an export.
 *
 * `revertClaimedAnchors` used to chunk its id filter by `POSTGREST_ROW_LIMIT`,
 * so every chunk took 400 Bad Request and a failed submission released none of
 * its claimed anchors. The width is now `chunkForInFilter`'s guarantee
 * (asserted once, in anchor-batching.test.ts); what still needs a behavioral
 * test is the part a width assertion never covered — that a revert which
 * releases nothing is escalated instead of being swallowed by the chain error
 * that triggered it.
 */
describe('publicRecordAnchor claim-revert escalation', () => {
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

  function armFailedSubmission() {
    const anchorResults = records.map((r, i) => ({
      id: `anchor-uuid-${i}`,
      fingerprint: r.content_hash,
    }));
    mockRpc
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: anchorResults });
    mockSubmitFingerprint.mockRejectedValue(new Error('chain node unreachable'));
  }

  function strandedAlerts() {
    return mockLogger.error.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('claim could not be fully released'),
    );
  }

  it('escalates at error level when the revert releases nothing', async () => {
    armFailedSubmission();
    const { client } = makeMock(records, { revertError: { message: 'Bad Request' } });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    const result = await processPublicRecordAnchoring(client);

    // The job still reports the submission failure — the revert problem is
    // additive signal, never a replacement for the real chain error.
    expect(result.txId).toBeNull();

    const alerts = strandedAlerts();
    expect(alerts).toHaveLength(1);
    const [context] = alerts[0];
    expect(context).toMatchObject({
      strandedAnchorIds: records.length,
      claimed: records.length,
    });
    expect((context as { failedChunks: number }).failedChunks).toBeGreaterThan(0);
  });

  it('stays quiet when the revert succeeds', async () => {
    armFailedSubmission();
    const { client } = makeMock(records);

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    await processPublicRecordAnchoring(client);

    expect(strandedAlerts()).toHaveLength(0);
  });
});

/**
 * The silent-empty guards on the two steps that read anchors back.
 *
 * Both are the 70-hour-outage shape: a chunked `.in()` loop that logs each
 * failure and continues returns `[]` when EVERY chunk 400s, which downstream
 * cannot tell apart from "nothing matched", so the job logs a benign line and
 * returns 200 forever.
 *
 *  - FETCH step (`fetchAnchorRows`): an empty read feeds `partitionRecordAnchors`
 *    zero pending items -> "No new pending public record anchors to submit".
 *    This is literally the 2026-07-29 outage; the guard shipped in #1795 but
 *    until now had NO test, so any future edit (the in-flight run-lease rebase
 *    on this same file, say) could drop the line with the suite still green.
 *  - CLAIM step (`claimPendingPipelineAnchors`): an empty claim reads as
 *    "nothing was PENDING" -> "No public record anchors claimed".
 *
 * Both are asserted through the real entrypoint, so what is covered is the
 * end-to-end silent-success path, not the helper in isolation.
 */
describe('publicRecordAnchor all-chunks-failed guards', () => {
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

  /** get_flag -> true, then batch_insert_anchors -> one anchor per record. */
  function armAnchorInserts() {
    mockRpc
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({
        data: records.map((r, i) => ({ id: `anchor-uuid-${i}`, fingerprint: r.content_hash })),
      });
  }

  it('refuses to treat an all-chunks-failed anchor fetch as "nothing was pending"', async () => {
    armAnchorInserts();
    const { client } = makeMock(records, { fetchError: { message: 'Bad Request' } });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');

    await expect(processPublicRecordAnchoring(client)).rejects.toThrow(
      /fetchAnchorRows: all \d+ chunk\(s\) failed/,
    );
    // …and it never logged the benign "nothing to submit" line, nor broadcast.
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'No new pending public record anchors to submit',
    );
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  it('refuses to treat an all-chunks-failed claim as "nothing was pending"', async () => {
    armAnchorInserts();
    const { client } = makeMock(records, { claimError: { message: 'Bad Request' } });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');

    await expect(processPublicRecordAnchoring(client)).rejects.toThrow(
      /claimPendingPipelineAnchors: all \d+ chunk\(s\) failed/,
    );
    // …and it never reached the chain with an empty batch.
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });
});
