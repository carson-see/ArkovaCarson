/**
 * CML-02 `compliance_controls` stamping — id-filter width + failure visibility.
 *
 * Two defects met in six lines, on the chain/treasury path:
 *
 *  1. `.in('id', ids)` took every anchor of one credential type with no
 *     chunking. `BATCH_SIZE` is 10,000, so a single-credential-type batch put
 *     10,000 UUIDs — ~390 KB of query string — on one request line. PostgREST
 *     answers 400 Bad Request.
 *  2. The result was not destructured at all (`await db…in(...)`, no
 *     `{ error }`). postgrest-js RESOLVES a 400, so nothing threw, and the
 *     `catch (complianceErr)` labelled "Non-fatal" never ran for the failure it
 *     was written for: it is dead code for the only failure mode that occurs.
 *
 * Net effect: a full batch is broadcast and SUBMITTED with
 * `compliance_controls` silently unset, and the job logs nothing at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger, mockFrom, controlsByType } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockFrom: vi.fn(),
  controlsByType: new Map<string | null, string[]>([['DEGREE', ['CTRL-1']]]),
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/db.js', () => ({
  db: { from: mockFrom, rpc: vi.fn() },
  withDbTimeout: <T>(p: T) => p,
}));
vi.mock('../config.js', () => ({
  config: { nodeEnv: 'test', useMocks: true, enableOrgCreditEnforcement: false, maxFeeThresholdSatPerVbyte: 50 },
}));
vi.mock('../chain/client.js', () => ({
  getChainClientAsync: vi.fn(),
  getInitializedChainClient: vi.fn(),
  getChainClient: vi.fn(),
}));
vi.mock('../utils/complianceMapping.js', () => ({
  getComplianceControlIds: (t: string | null) => controlsByType.get(t) ?? [],
}));
vi.mock('../utils/orgCredits.js', () => ({ deductOrgCredit: vi.fn() }));
vi.mock('../utils/anchorProofs.js', () => ({ upsertAnchorProofs: vi.fn() }));
vi.mock('../middleware/flagRegistry.js', () => ({
  flagRegistry: { getFlag: vi.fn(async () => true) },
}));

import { applyComplianceControls, BATCH_SIZE } from './batch-anchor.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from '../utils/postgrest-filter.js';
import { encodedInFilterBytesFor } from '../test-utils/postgrestWire.js';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

interface UpdateCall { controls: unknown; ids: string[] }

function mockDb(state: { calls: UpdateCall[]; failEveryChunk?: boolean }) {
  mockFrom.mockImplementation(() => {
    let payload: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {};
    builder.update = vi.fn((p: unknown) => {
      payload = p;
      return builder;
    });
    builder.in = vi.fn((_column: string, ids: string[]) => {
      state.calls.push({ controls: payload, ids });
      // The wire truth: an oversized request line is a 400, and postgrest-js
      // RESOLVES it as `{ error }` rather than throwing.
      if (state.failEveryChunk || encodedInFilterBytesFor(ids) > POSTGREST_URL_FILTER_BUDGET_BYTES) {
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST', message: 'Bad Request', details: null, hint: null },
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    return builder;
  });
}

describe('applyComplianceControls (CML-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps every id filter inside the URL budget at a full 10,000-anchor batch', async () => {
    const calls: UpdateCall[] = [];
    mockDb({ calls });
    const anchors = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      id: uuid(i),
      credential_type: 'DEGREE',
    }));

    await applyComplianceControls(anchors, 'batch-1');

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(encodedInFilterBytesFor(call.ids)).toBeLessThanOrEqual(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }
    // Chunking must not drop the tail: every anchor gets stamped exactly once.
    const stamped = calls.flatMap((c) => c.ids);
    expect(stamped).toHaveLength(BATCH_SIZE);
    expect(new Set(stamped).size).toBe(BATCH_SIZE);
  });

  it('keeps each credential type on its own controls payload while chunking', async () => {
    const calls: UpdateCall[] = [];
    controlsByType.set('LICENSE', ['CTRL-9']);
    mockDb({ calls });
    const anchors = [
      ...Array.from({ length: 300 }, (_, i) => ({ id: uuid(i), credential_type: 'DEGREE' })),
      ...Array.from({ length: 300 }, (_, i) => ({ id: uuid(1000 + i), credential_type: 'LICENSE' })),
    ];

    await applyComplianceControls(anchors, 'batch-2');

    for (const call of calls) {
      const expected = call.ids[0].includes('0000001') ? ['CTRL-9'] : ['CTRL-1'];
      expect(call.controls).toEqual({ compliance_controls: expected });
    }
    controlsByType.delete('LICENSE');
  });

  it('reports a failed chunk instead of returning as though every row was stamped', async () => {
    const calls: UpdateCall[] = [];
    mockDb({ calls, failEveryChunk: true });
    const anchors = Array.from({ length: 10 }, (_, i) => ({ id: uuid(i), credential_type: 'DEGREE' }));

    // Explicitly NOT a throw — see the production comment on the opt-out.
    await expect(applyComplianceControls(anchors, 'batch-3')).resolves.toBeUndefined();

    // ...but it must be LOUD. The old code observed nothing at all.
    expect(mockLogger.error).toHaveBeenCalled();
    const summary = mockLogger.error.mock.calls.at(-1) as [Record<string, unknown>, string];
    expect(summary[0]).toMatchObject({
      batchId: 'batch-3',
      failedChunks: 1,
      attemptedChunks: 1,
      unstampedAnchors: 10,
    });
  });

  it('stays silent on a clean run', async () => {
    const calls: UpdateCall[] = [];
    mockDb({ calls });
    await applyComplianceControls(
      [{ id: uuid(1), credential_type: 'DEGREE' }],
      'batch-4',
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
