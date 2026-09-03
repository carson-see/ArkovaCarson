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
  // Real implementation — pure string/shape matcher, safe to use unmocked so the
  // retry test below exercises the same transient-error classification prod uses.
  isTransientConnectionError: (err: unknown): boolean => {
    const msg = err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ''}` : String(err);
    return /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|UND_ERR_SOCKET|other side closed|terminated/i.test(msg);
  },
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

    expect(result).toEqual({ claimed: 0, succeeded: 0, skipped: 0, failed: 0, processed: 0, quarantined: 0 });
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
    expect(result).toEqual({ claimed: 1, succeeded: 1, skipped: 0, failed: 0, processed: 3, quarantined: 0 });
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

    expect(result).toEqual({ claimed: 2, succeeded: 1, skipped: 0, failed: 1, processed: 1, quarantined: 0 });
    expect(mockProcessBatchAnchors).toHaveBeenNthCalledWith(1, { force: true, orgId: ORG_A });
    expect(mockProcessBatchAnchors).toHaveBeenNthCalledWith(2, { force: true, orgId: ORG_B });
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty('last_success_at');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A }),
      'scheduled org queue run failed',
    );
  });

  /**
   * SCRUM-3031. `processBatchAnchors` now returns `skipped: true` when the
   * cross-instance run lease is held by another instance (or is unverifiable
   * and we fail closed) — the drain DID NOT RUN.
   *
   * Recording that as `succeeded` would be worse than a cosmetic audit lie:
   * `recordOrgQueueRunResult` writes `last_run_at`, and
   * `claim_due_org_queue_runs` only considers an org due once `last_run_at` is
   * 24 hours old. A single long global drain holding the lease could therefore
   * defer up to CLAIM_LIMIT_DEFAULT (25) orgs' dedicated runs by a full day
   * each, while filing 25 `organization_queue_runs` rows saying they succeeded.
   */
  it('does not burn an org 24-hour slot when the run lease refuses the drain', async () => {
    const { insert, upsert } = setupWriteTables();
    mockDbRpc.mockResolvedValue({ data: [{ org_id: ORG_A, last_run_at: null }], error: null });
    mockProcessBatchAnchors.mockResolvedValue({
      processed: 0,
      batchId: null,
      merkleRoot: null,
      txId: null,
      skipped: true,
    });

    const result = await runOrgQueueScheduler(
      {},
      { now: () => new Date('2026-08-02T01:00:00.000Z'), workerId: 'worker-3' },
    );

    expect(result).toEqual({ claimed: 1, succeeded: 0, skipped: 1, failed: 0, processed: 0, quarantined: 0 });
    // No false run-evidence row.
    expect(insert).not.toHaveBeenCalled();
    // The claim IS released — otherwise the org stays locked and is never
    // re-claimable — but WITHOUT advancing the due clock.
    expect(upsert).toHaveBeenCalledTimes(1);
    const state = upsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(state).toMatchObject({ org_id: ORG_A, locked_at: null, locked_by: null });
    expect(state).not.toHaveProperty('last_run_at');
    expect(state).not.toHaveProperty('last_run_status');
    expect(state).not.toHaveProperty('last_success_at');
  });

  it('still records a genuinely empty queue as a completed run', async () => {
    const { insert, upsert } = setupWriteTables();
    mockDbRpc.mockResolvedValue({ data: [{ org_id: ORG_A, last_run_at: null }], error: null });
    // No `skipped` flag: the drain ran and found nothing. That IS a run.
    mockProcessBatchAnchors.mockResolvedValue({
      processed: 0,
      batchId: null,
      merkleRoot: null,
      txId: null,
    });

    const result = await runOrgQueueScheduler(
      {},
      { now: () => new Date('2026-08-02T01:00:00.000Z'), workerId: 'worker-3' },
    );

    expect(result).toEqual({ claimed: 1, succeeded: 1, skipped: 0, failed: 0, processed: 0, quarantined: 0 });
    expect(insert).toHaveBeenCalled();
    expect(upsert.mock.calls[0]?.[0]).toHaveProperty('last_run_at');
  });

  // BUG-2026-08-12-003 / FD-15. The pre-fix parse was a wholesale
  // `z.array(ClaimedOrgSchema).safeParse(data)` that THREW on the first bad
  // row, so a single malformed value denied service to every other org in the
  // claim batch — the whole scheduler pass returned INTERNAL. The blast radius
  // was the defect, not the literal. A bad row must now be quarantined and
  // logged loudly while the rest of the batch runs.
  it('quarantines a malformed row instead of denying service to the whole batch (FD-15)', async () => {
    mockDbRpc.mockResolvedValue({
      data: [{ org_id: 'not-a-uuid' }, { org_id: ORG_A, last_run_at: null }],
      error: null,
    });
    mockProcessBatchAnchors.mockResolvedValue({
      processed: 2,
      batchId: 'batch-ok',
      merkleRoot: 'c'.repeat(64),
      txId: 'tx-ok',
    });

    const result = await runOrgQueueScheduler({ limit: 10 }, { workerId: 'worker-fd15' });

    // The healthy org still got its run.
    expect(mockProcessBatchAnchors).toHaveBeenCalledWith({ force: true, orgId: ORG_A });
    expect(mockProcessBatchAnchors).toHaveBeenCalledTimes(1);
    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.processed).toBe(2);
    // The bad row is surfaced, not swallowed.
    expect(result.quarantined).toBe(1);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('still runs the batch when EVERY claimed row is malformed does not throw (FD-15)', async () => {
    mockDbRpc.mockResolvedValue({
      data: [{ org_id: 'not-a-uuid' }, { org_id: 42 }],
      error: null,
    });

    const result = await runOrgQueueScheduler({ limit: 10 }, { workerId: 'worker-fd15-all' });

    // No throw: an all-bad batch is an observable, alertable outcome — not an
    // exception that takes the cron endpoint to INTERNAL.
    expect(result.claimed).toBe(0);
    expect(result.quarantined).toBe(2);
    expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  // FD-15 literal: the seeded fixture org UUIDs have zero version/variant
  // nibbles. Postgres `uuid` accepts and stores them; Zod 4.4.3's strict
  // RFC-9562 `.uuid()` rejected them. The DB-sourced column type is the
  // authority here, so the row must parse.
  it('accepts a DB-sourced UUID with zero version/variant nibbles (FD-15)', async () => {
    const FIXTURE_ORG = 'aaaaaaaa-0000-0000-0000-000000000001';
    mockDbRpc.mockResolvedValue({
      data: [{ org_id: FIXTURE_ORG, last_run_at: null }],
      error: null,
    });
    mockProcessBatchAnchors.mockResolvedValue({
      processed: 1,
      batchId: 'batch-fx',
      merkleRoot: 'e'.repeat(64),
      txId: 'tx-fx',
    });

    const result = await runOrgQueueScheduler({ limit: 10 }, { workerId: 'worker-fixture' });

    expect(mockProcessBatchAnchors).toHaveBeenCalledWith({ force: true, orgId: FIXTURE_ORG });
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, quarantined: 0 });
  });

  // A non-array RPC payload is NOT "one bad row" — there is nothing to salvage
  // and no per-row recovery is meaningful. That must still fail loudly.
  it('still fails loudly when the claim RPC returns a non-array payload', async () => {
    mockDbRpc.mockResolvedValue({ data: { org_id: ORG_A }, error: null });

    await expect(runOrgQueueScheduler()).rejects.toThrow(/expected an array/i);
    expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
  });

  // BUG-2026-08-01-F9: prod org 40383eb2-f1cd-4a85-8099-afafff95e5cf,
  // 2026-08-01T18:49:31Z — a preceding org's broadcast consumed both treasury
  // UTXOs, so this org's batch broadcast was definitively rejected and the
  // intent correctly unwound (3 anchors back to PENDING). processBatchAnchors
  // did NOT throw (by design — a definitive reject is not an exception, it's a
  // resolved, self-healing outcome), so the pre-fix scheduler recorded
  // organization_queue_runs as status='succeeded', processed_count=0, error=NULL
  // — indistinguishable from "nothing was due" to anyone reading run history.
  // This test reproduces that exact shape via BatchAnchorResult.rejectedReason
  // (batch-anchor.ts's new signal) and pins that the scheduler now records the
  // run as status='failed' with the rejection reason in `error`, and counts it
  // under `failed`, not `succeeded`.
  it('records a definitive broadcast rejection as failed, not succeeded (BUG-2026-08-01-F9)', async () => {
    const { insert, upsert } = setupWriteTables();
    mockDbRpc.mockResolvedValue({
      data: [{ org_id: ORG_A, last_run_at: null }],
      error: null,
    });
    mockProcessBatchAnchors.mockResolvedValue({
      processed: 0,
      batchId: null,
      merkleRoot: 'd'.repeat(64),
      txId: null,
      rejectedReason: 'BroadcastRejectedError: min relay fee not met (code -26)',
    });

    const result = await runOrgQueueScheduler(
      { limit: 10 },
      {
        now: () => new Date('2026-08-01T18:49:31.000Z'),
        workerId: 'worker-f9',
      },
    );

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1, processed: 0, skipped: 0, quarantined: 0 });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: ORG_A,
      trigger: 'scheduled',
      status: 'failed',
      processed_count: 0,
      tx_id: null,
      error: expect.stringContaining('min relay fee not met'),
    }));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: ORG_A,
        last_run_status: 'failed',
        last_run_trigger: 'scheduled',
      }),
      { onConflict: 'org_id' },
    );
    // A rejected-but-not-thrown run must not be silently absorbed into the
    // "succeeded" notification path either.
    expect(mockEmitOrgAdminNotifications).not.toHaveBeenCalled();
  });

  // Incident 2026-07-29: launch-72h/legacy-soak signet rigs — claim_due_org_queue_runs
  // committed the row lock (organization_queue_run_state.locked_at set, status
  // 'running') on every single tick that actually had due orgs, yet
  // organization_queue_runs stayed EMPTY the entire soak. Root cause: the RPC is a
  // PostgREST POST, and db.ts's fetch wrapper deliberately never auto-retries
  // POST/RPC calls (SCRUM-2899 — a retried WRITE could double-apply after the
  // server already committed). A rotten idle socket under loadgen connection
  // pressure threw a transport error (fetch failed / ECONNRESET) on the RPC
  // *after* Postgres had already committed the claim, so the throw escaped
  // BEFORE the per-org try/catch (which is what actually clears locked_at) —
  // stranding the org in 'running' until the RPC's own 15-minute lock timeout,
  // at which point the next tick reclaims it and repeats the same failure.
  // claim_due_org_queue_runs is uniquely safe to retry here (unlike a generic
  // RPC write): it uses `FOR UPDATE SKIP LOCKED`, so a retry can only pick up
  // orgs NOT already locked by a prior attempt — it can never double-claim.
  it('retries the claim RPC once on a transient transport error, then proceeds normally', async () => {
    mockDbRpc.mockReset();
    const transportError = Object.assign(new Error('fetch failed'), { cause: new Error('other side closed') });
    mockDbRpc
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce({ data: [{ org_id: ORG_A, last_run_at: null }], error: null });
    mockProcessBatchAnchors.mockResolvedValue({
      processed: 2,
      batchId: 'batch-3',
      merkleRoot: 'c'.repeat(64),
      txId: 'tx-3',
    });

    const result = await runOrgQueueScheduler({}, { workerId: 'worker-3' });

    expect(mockDbRpc).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ claimed: 1, succeeded: 1, skipped: 0, failed: 0, processed: 2, quarantined: 0 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(String) }),
      expect.stringContaining('retrying once'),
    );
  });

  it('surfaces the error when the claim RPC fails twice in a row (no infinite retry)', async () => {
    mockDbRpc.mockReset();
    const transportError = Object.assign(new Error('fetch failed'), { cause: new Error('ECONNRESET') });
    mockDbRpc.mockRejectedValue(transportError);

    await expect(runOrgQueueScheduler()).rejects.toThrow(/fetch failed/i);
    expect(mockDbRpc).toHaveBeenCalledTimes(2);
    expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
  });

  it('does not retry a non-transient claim RPC error', async () => {
    mockDbRpc.mockReset();
    mockDbRpc.mockRejectedValue(new Error('permission denied for function claim_due_org_queue_runs'));

    await expect(runOrgQueueScheduler()).rejects.toThrow(/permission denied/i);
    expect(mockDbRpc).toHaveBeenCalledTimes(1);
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
