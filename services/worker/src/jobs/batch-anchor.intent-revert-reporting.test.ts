/**
 * `summarizeIntentRevert` — what the intent-revert summary line may claim.
 *
 * `revertIntentAnchors` used to end with an UNCONDITIONAL
 * "Reverted definitively-rejected intent anchors BROADCASTING → PENDING" at
 * INFO, emitted even when every chunk had just logged a failure on the line
 * directly above it. That is the same reported-success-over-real-failure shape
 * as #1812, where a claim-revert that released nothing reported success — and
 * it is what makes this class of outage invisible in the logs.
 *
 * The revert deliberately does NOT throw (it runs inside the broadcast-failure
 * path, where a secondary throw would mask the real chain error), so the log
 * line is the ONLY signal that exists. It has to be true.
 */
import { describe, it, expect, vi } from 'vitest';

// Same module stubs the sibling batch-anchor suites use — importing the module
// pulls in config/db/chain, none of which this pure function touches.
const { mockLogger, mockFrom } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockFrom: vi.fn(),
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
vi.mock('../utils/complianceMapping.js', () => ({ getComplianceControlIds: () => [] }));
vi.mock('../utils/orgCredits.js', () => ({ deductOrgCredit: vi.fn() }));
vi.mock('../utils/anchorProofs.js', () => ({ upsertAnchorProofs: vi.fn() }));
vi.mock('../middleware/flagRegistry.js', () => ({
  flagRegistry: { getFlag: vi.fn(async () => true) },
}));

import { summarizeIntentRevert } from './batch-anchor.js';

describe('summarizeIntentRevert', () => {
  it('claims success only when no chunk failed', () => {
    const out = summarizeIntentRevert({
      total: 1_000,
      reverted: 1_000,
      attemptedChunks: 5,
      failedChunks: 0,
    });

    expect(out.level).toBe('info');
    expect(out.message).toMatch(/Reverted definitively-rejected intent anchors/);
    expect(out.detail).toEqual({
      reverted: 1_000,
      stranded: 0,
      attemptedChunks: 5,
      failedChunks: 0,
    });
  });

  it('never claims success when EVERY chunk failed — the #1812 shape', () => {
    const out = summarizeIntentRevert({
      total: 1_000,
      reverted: 0,
      attemptedChunks: 5,
      failedChunks: 5,
    });

    expect(out.level).toBe('error');
    expect(out.message).not.toMatch(/^Reverted definitively-rejected/);
    expect(out.message).toMatch(/reverted NOTHING/);
    // The number that matters operationally: everything is still BROADCASTING.
    expect(out.detail.stranded).toBe(1_000);
    expect(out.detail.reverted).toBe(0);
  });

  it('reports a partial failure as a warning that names the stranded count', () => {
    const out = summarizeIntentRevert({
      total: 1_000,
      reverted: 800,
      attemptedChunks: 5,
      failedChunks: 1,
    });

    expect(out.level).toBe('warn');
    expect(out.message).toMatch(/partially failed/);
    expect(out.detail.stranded).toBe(200);
    expect(out.detail.failedChunks).toBe(1);
  });

  it('does not report success for an empty revert that had no chunks to run', () => {
    const out = summarizeIntentRevert({
      total: 0,
      reverted: 0,
      attemptedChunks: 0,
      failedChunks: 0,
    });

    // Nothing failed, so INFO is correct — but it must not imply work happened.
    expect(out.level).toBe('info');
    expect(out.detail.reverted).toBe(0);
    expect(out.detail.stranded).toBe(0);
  });
});
