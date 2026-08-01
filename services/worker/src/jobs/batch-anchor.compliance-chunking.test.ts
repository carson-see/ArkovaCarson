/**
 * CML-02 `compliance_controls` back-fill must chunk its `.in('id', …)` filter.
 *
 * Same defect family as the 2026-07-29 → 2026-08-01 public-record anchoring
 * outage (see `jobs/agents.md`): `ids` here is a per-credential-type group of
 * `orderedAnchors`, bounded only by BATCH_SIZE (10,000). A real batch
 * concentrates in a handful of credential types, so an unchunked filter is a
 * ~390 KB query string and PostgREST answers 400 Bad Request.
 *
 * It failed inside a non-fatal `try/catch` that only warned, so the symptom was
 * silent: large batches got NO `compliance_controls` at all, and because the
 * throw escaped the per-type loop, every credential type after the first was
 * skipped too. Nothing downstream notices — `audit-export` and the GRC evidence
 * path just emit empty control lists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { ChainReceipt } from '../chain/types.js';
import { POSTGREST_IN_FILTER_CHUNK, POSTGREST_URL_FILTER_BUDGET_BYTES } from './anchor-batching.js';

const fp = (seed: string) => createHash('sha256').update(seed).digest('hex');

const {
  mockSubmitFingerprint,
  mockEstimateCurrentFee,
  mockGetChainClientAsync,
  mockDbRpc,
  mockLogger,
  complianceUpdates,
  oldestRef,
  setOldest,
} = vi.hoisted(() => ({
  mockSubmitFingerprint: vi.fn(),
  mockEstimateCurrentFee: vi.fn(),
  mockGetChainClientAsync: vi.fn(),
  mockDbRpc: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  /** id arrays passed to `anchors.update({ compliance_controls }).in('id', …)`. */
  complianceUpdates: [] as string[][],
  oldestRef: { value: null as { created_at: string } | null },
  setOldest: (v: { created_at: string } | null) => { /* replaced below */ void v; },
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../config.js', () => ({
  config: { nodeEnv: 'test', useMocks: true, enableOrgCreditEnforcement: false, maxFeeThresholdSatPerVbyte: 50 },
}));
vi.mock('../chain/client.js', () => ({
  getChainClientAsync: mockGetChainClientAsync,
  getInitializedChainClient: vi.fn(),
  getChainClient: vi.fn(),
}));
vi.mock('../utils/complianceMapping.js', () => ({
  getComplianceControlIds: () => ['SOC2-CC6.1'],
}));
vi.mock('../utils/orgCredits.js', () => ({
  deductOrgCredit: vi.fn(async () => ({ allowed: true, reason: 'feature_disabled', balance: null })),
}));
vi.mock('../utils/anchorProofs.js', () => ({ upsertAnchorProofs: vi.fn(async () => undefined) }));
vi.mock('../middleware/flagRegistry.js', () => ({
  flagRegistry: { getFlag: vi.fn(() => true) },
}));

vi.mock('../utils/db.js', () => {
  const anchorsSelectChain: Record<string, unknown> = {};
  anchorsSelectChain.eq = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.is = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.order = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.limit = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.range = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.maybeSingle = vi.fn(async () => ({ data: oldestRef.value, error: null }));

  function makeUpdateChain(capture: boolean): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    chain.in = vi.fn((_column: string, ids: string[]) => {
      if (capture) complianceUpdates.push([...ids]);
      return chain;
    });
    chain.then = (resolve?: (v: unknown) => unknown) =>
      Promise.resolve({ error: null, count: 1 }).then(resolve);
    return chain;
  }

  return {
    db: {
      rpc: mockDbRpc,
      from: vi.fn((table: string) => {
        if (table === 'anchors') {
          return {
            select: vi.fn(() => anchorsSelectChain),
            update: vi.fn((payload: Record<string, unknown>) =>
              makeUpdateChain(Object.hasOwn(payload, 'compliance_controls')),
            ),
          };
        }
        return { upsert: vi.fn(async () => ({ error: null })) };
      }),
    },
    withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

import { processBatchAnchors } from './batch-anchor.js';

const RECEIPT: ChainReceipt = {
  receiptId: 'tx_compliance_chunking_001',
  blockHeight: 880_000,
  blockTimestamp: '2026-06-15T12:00:00Z',
  confirmations: 0,
};

/** Encoded query-string value PostgREST receives for one `.in('id', ids)` chunk. */
function encodedInFilterBytes(ids: string[]): number {
  return encodeURIComponent(`in.(${ids.join(',')})`).length;
}

function primeChainAndClaims(anchors: Array<Record<string, unknown>>) {
  oldestRef.value = { created_at: '2026-01-01T00:00:00Z' };
  mockGetChainClientAsync.mockResolvedValue({
    submitFingerprint: mockSubmitFingerprint,
    estimateCurrentFee: mockEstimateCurrentFee,
    hasFunds: async () => true,
  });
  mockSubmitFingerprint.mockResolvedValue(RECEIPT);
  mockEstimateCurrentFee.mockResolvedValue(1);

  let claimCalls = 0;
  mockDbRpc.mockImplementation(async (rpcName: string) => {
    if (rpcName === 'claim_pending_anchors') {
      claimCalls += 1;
      return claimCalls === 1 ? { data: anchors, error: null } : { data: [], error: null };
    }
    if (rpcName === 'submit_batch_anchors') return { data: anchors.length, error: null };
    return { data: null, error: null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  complianceUpdates.length = 0;
  oldestRef.value = null;
  void setOldest;
});

describe('batch-anchor CML-02 compliance_controls back-fill', () => {
  /** Wider than one chunk, in a single credential type — the real-world shape. */
  const ANCHOR_COUNT = POSTGREST_IN_FILTER_CHUNK * 2 + 31;

  it('chunks the id filter so a large single-credential-type batch stays inside the URL budget', async () => {
    const anchors = Array.from({ length: ANCHOR_COUNT }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      fingerprint: fp(`compliance-${i}`),
      metadata: null,
      org_id: 'o1',
      public_id: `P${i}`,
      credential_type: 'DEGREE',
    }));
    primeChainAndClaims(anchors);

    const result = await processBatchAnchors({ force: true });
    expect(result.processed).toBeGreaterThan(0);

    // Every anchor is still covered exactly once...
    expect(complianceUpdates.flat()).toHaveLength(ANCHOR_COUNT);
    expect(new Set(complianceUpdates.flat()).size).toBe(ANCHOR_COUNT);

    // ...and no single filter exceeds what PostgREST accepts. Unchunked, this
    // was one 431-id filter; at a full 10k batch it is ~390 KB and 400s.
    expect(complianceUpdates.map((chunk) => chunk.length)).toEqual([
      POSTGREST_IN_FILTER_CHUNK,
      POSTGREST_IN_FILTER_CHUNK,
      ANCHOR_COUNT - POSTGREST_IN_FILTER_CHUNK * 2,
    ]);
    for (const chunk of complianceUpdates) {
      expect(encodedInFilterBytes(chunk)).toBeLessThan(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }
  }, 30_000);
});
