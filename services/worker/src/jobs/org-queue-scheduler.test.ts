import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockDbRpc = vi.fn();
const mockDbFrom = vi.fn();
const mockProcessBatchAnchors = vi.fn();
const mockEmitOrgAdminNotifications = vi.fn();

vi.mock('../utils/db.js', () => ({
  db: { rpc: (...args: unknown[]) => mockDbRpc(...args), from: (...args: unknown[]) => mockDbFrom(...args) },
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('./batch-anchor.js', () => ({
  processBatchAnchors: (...args: unknown[]) => mockProcessBatchAnchors(...args),
}));

vi.mock('../notifications/dispatcher.js', () => ({
  emitOrgAdminNotifications: (...args: unknown[]) => mockEmitOrgAdminNotifications(...args),
}));

const { runOrgQueueScheduler, recordOrgQueueRunResult } = await import('./org-queue-scheduler.js');

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setupWriteTables() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  mockDbFrom.mockImplementation((table: string) => {
    if (table === 'organization_queue_runs') return { insert };
    if (table === 'organization_queue_run_state') return { upsert };
    throw new Error(`unexpected table ${table}`);
  });
  return { insert, upsert };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENABLE_ORG_QUEUE_SCHEDULER;
  mockDbRpc.mockResolvedValue({ data: [], error: null });
  mockProcessBatchAnchors.mockResolvedValue({
    processed: 0,
    batchId: null,
    merkleRoot: null,
    txId: null,
  });
  setupWriteTables();
});

describe('runOrgQueueScheduler', () => {
  it('does nothing when disabled by flag', async () => {
    process.env.ENABLE_ORG_QUEUE_SCHEDULER = 'false';

    const result = await runOrgQueueScheduler();

    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0, processed: 0 });
    expect(mockDbRpc).not.toHaveBeenCalled();
    expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
  });

  it('claims due organizations through the RPC and runs the org-scoped batch path', async () => {
    const { insert, upsert } = setupWriteTables();
    mockDbRpc.mockResolvedValue({
      data: [{ org_id: ORG_A, last_run_at: null }],
      error: null,
    });
    mockProcessBatchAnchors.mockResolvedValue({
      processed: 3,
      batchId: 'batch-1',
      merkleRoot: 'a'.repeat(64),
      txId: 'tx-1',
    });

    const result = await runOrgQueueScheduler(
      { limit: 10 },
      {
        now: () => new Date('2026-05-05T17:00:00.000Z'),
        workerId: 'worker-1',
      },
    );

    expect(mockDbRpc).toHaveBeenCalledWith('claim_due_org_queue_runs', {
      p_now: '2026-05-05T17:00:00.000Z',
      p_worker_id: 'worker-1',
      p_limit: 10,
    });
    expect(mockProcessBatchAnchors).toHaveBeenCalledWith({ force: true, orgId: ORG_A });
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, processed: 3 });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: ORG_A,
      trigger: 'scheduled',
      status: 'succeeded',
      processed_count: 3,
      batch_id: 'batch-1',
    }));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: ORG_A,
        last_run_status: 'succeeded',
        last_run_trigger: 'scheduled',
        locked_at: null,
        locked_by: null,
      }),
      { onConflict: 'org_id' },
    );
    expect(mockEmitOrgAdminNotifications).toHaveBeenCalledWith({
      type: 'queue_run_completed',
      organizationId: ORG_A,
      payload: expect.objectContaining({ trigger: 'scheduled', processed: 3 }),
    });
  });

  it('records failures and continues with the next claimed organization', async () => {
    const { upsert } = setupWriteTables();
    mockDbRpc.mockResolvedValue({
      data: [
        { org_id: ORG_A, last_run_at: null },
        { org_id: ORG_B, last_run_at: null },
      ],
      error: null,
    });
    mockProcessBatchAnchors
      .mockRejectedValueOnce(new Error('chain submit failed'))
      .mockResolvedValueOnce({
        processed: 1,
        batchId: 'batch-2',
        merkleRoot: 'b'.repeat(64),
        txId: 'tx-2',
      });

    const result = await runOrgQueueScheduler(
      {},
      {
        now: () => new Date('2026-05-05T17:30:00.000Z'),
        workerId: 'worker-2',
      },
    );

    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1, processed: 1 });
    expect(mockProcessBatchAnchors).toHaveBeenNthCalledWith(1, { force: true, orgId: ORG_A });
    expect(mockProcessBatchAnchors).toHaveBeenNthCalledWith(2, { force: true, orgId: ORG_B });
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty('last_success_at');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A }),
      'scheduled org queue run failed',
    );
  });

  it('fails loudly when the claim RPC returns malformed rows', async () => {
    mockDbRpc.mockResolvedValue({ data: [{ org_id: 'not-a-uuid' }], error: null });

    await expect(runOrgQueueScheduler()).rejects.toThrow(/invalid rows/i);
    expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
  });
});

describe('recordOrgQueueRunResult', () => {
  it('persists manual run history and resets the due timer state', async () => {
    const { insert, upsert } = setupWriteTables();

    await recordOrgQueueRunResult({
      orgId: ORG_A,
      trigger: 'manual',
      status: 'succeeded',
      startedAt: new Date('2026-05-05T18:00:00.000Z'),
      finishedAt: new Date('2026-05-05T18:01:00.000Z'),
      processed: 7,
      batchId: 'batch-manual',
      merkleRoot: 'c'.repeat(64),
      txId: 'tx-manual',
      triggeredBy: 'user-1',
    });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: ORG_A,
      trigger: 'manual',
      status: 'succeeded',
      triggered_by: 'user-1',
      processed_count: 7,
      idempotency_key: `manual:${ORG_A}:2026-05-05T18:00:00.000Z:user-1`,
    }));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: ORG_A,
        last_run_at: '2026-05-05T18:01:00.000Z',
        last_success_at: '2026-05-05T18:01:00.000Z',
        last_run_status: 'succeeded',
        last_run_trigger: 'manual',
      }),
      { onConflict: 'org_id' },
    );
  });
});
