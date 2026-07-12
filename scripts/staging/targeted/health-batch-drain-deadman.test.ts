import { describe, expect, it } from 'vitest';

import {
  assertBatchDrainHealthPayload,
  buildDetailedHealthUrl,
  type BatchDrainHealthExpectations,
} from './health-batch-drain-deadman';

const warningPayload = {
  status: 'healthy',
  checks: {
    anchoring: {
      status: 'warning',
      pendingCount: 250,
      lastBatchAt: '2026-07-08T03:10:00.000Z',
      drainStalled: true,
      drainReason: 'backlog_aged',
    },
  },
};

const okPayload = {
  status: 'healthy',
  checks: {
    anchoring: {
      status: 'ok',
      pendingCount: 0,
      lastBatchAt: '2026-07-08T03:10:00.000Z',
      drainStalled: false,
      drainReason: 'ok',
    },
  },
};

describe('targeted batch-drain /health detailed driver', () => {
  it('builds the exact detailed health URL, not generic /health', () => {
    expect(buildDetailedHealthUrl('https://pr-1461---arkova-worker-staging-abc.run.app'))
      .toBe('https://pr-1461---arkova-worker-staging-abc.run.app/health?detailed=true');
  });

  it('asserts the batch-drain warning fields from checks.anchoring', () => {
    const expectations: BatchDrainHealthExpectations = {
      anchoringStatus: 'warning',
      drainStalled: true,
      drainReason: 'backlog_aged',
      pendingCount: 250,
    };

    expect(assertBatchDrainHealthPayload(warningPayload, expectations)).toMatchObject({
      status: 'warning',
      drainStalled: true,
      drainReason: 'backlog_aged',
      pendingCount: 250,
    });
  });

  it('asserts the empty-queue steady-state fields without treating old batches as failures', () => {
    expect(
      assertBatchDrainHealthPayload(okPayload, {
        anchoringStatus: 'ok',
        drainStalled: false,
        drainReason: 'ok',
        pendingCount: 0,
      }),
    ).toMatchObject({
      status: 'ok',
      drainStalled: false,
      drainReason: 'ok',
      pendingCount: 0,
    });
  });

  it('rejects generic /health payloads where anchoring is just a compact status string', () => {
    expect(() =>
      assertBatchDrainHealthPayload({ checks: { anchoring: 'ok' } }, { anchoringStatus: 'ok' }),
    ).toThrow(/health\?detailed=true/);
  });

  it('fails closed when the actual detailed JSON field does not match the expected reason', () => {
    expect(() =>
      assertBatchDrainHealthPayload(warningPayload, {
        anchoringStatus: 'warning',
        drainStalled: true,
        drainReason: 'batch_stale',
      }),
    ).toThrow(/drainReason/);
  });

  it('rejects negative pending-count sentinels as unknown rather than evidence', () => {
    expect(() =>
      assertBatchDrainHealthPayload({
        status: 'healthy',
        checks: {
          anchoring: {
            status: 'ok',
            pendingCount: -1,
            lastBatchAt: null,
            drainStalled: false,
            drainReason: 'ok',
          },
        },
      }),
    ).toThrow(/pendingCount/);
  });
});
