import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseArgs, runDriver, runSelfTest } from './pr1408-chain-resilience-driver';

describe('pr1408-chain-resilience-driver', () => {
  it('defaults to local self-test mode', () => {
    expect(parseArgs([])).toEqual({ mode: 'self-test' });
  });

  it('parses live admission arguments', () => {
    expect(parseArgs([
      '--live',
      '--target-url', 'https://worker.example',
      '--admission-json', '/tmp/admission.json',
      '--evidence-jsonl', '/tmp/evidence.jsonl',
      '--cron-secret', 'secret',
    ])).toEqual({
      mode: 'live',
      targetUrl: 'https://worker.example',
      admissionJson: '/tmp/admission.json',
      evidenceJsonl: '/tmp/evidence.jsonl',
      cronSecret: 'secret',
    });
  });

  it('self-test covers #1408 behavior but is explicitly not soak evidence', async () => {
    const row = await runSelfTest();
    expect(row.pr).toBe(1408);
    expect(row.tier).toBe('T3');
    expect(row.mode).toBe('self-test');
    expect(row.evidenceForSoak).toBe(false);
    expect(row.status).toBe('pass');
    expect(row.changedBehavior).toMatch(/bounded retry\/backoff/);
    expect(row.counts.boundedTerminatesAtHardCap).toBe(true);
    expect(row.counts.rateLimitRetryable).toBe(true);
    expect(row.counts.rpcApplicationErrorNonRetryable).toBe(true);
    expect(row.counts.duplicateKnown).toBe(true);
    expect(row.counts.duplicateAlreadyInChain).toBe(true);
    expect(row.counts.transientProofPending).toBe(true);
    expect(row.counts.definitiveProofStale).toBe(true);
    expect(row.counts.mempoolShapePendingNoFabricatedProof).toBe(true);
  });

  it('live mode fails closed when admission inputs are missing', async () => {
    const row = await runDriver({ mode: 'live' });
    expect(row.status).toBe('fail');
    expect(row.evidenceForSoak).toBe(false);
    expect(row.blockers).toEqual([
      'missing --target-url',
      'missing --admission-json',
      'missing --evidence-jsonl',
      'missing --cron-secret or --bearer-token',
    ]);
  });
});
