/**
 * Tests for the `ai_credits.reconcile_refund` consumer.
 *
 * WHY THIS EXISTS
 *
 * `api/v1/ai-extract-batch.ts` debits 1 credit per row BEFORE the provider
 * call and refunds that row's credit when the row fails. If the refund itself
 * fails after a successful debit, it enqueues an `ai_credits.reconcile_refund`
 * job rather than swallowing the error — the module's own contract
 * (`api/v1/agents.md`) says: "A lost refund is an overcharge — it is surfaced,
 * not dropped."
 *
 * It was NOT surfaced. Nothing in the worker called `claimJob` /
 * `processNextJob` with that type, so the row sat `pending` forever: never
 * claimed, never retried, never dead-lettered, and invisible to every error
 * path. The customer stayed overcharged and no signal existed anywhere.
 *
 * This suite pins the drain: claim → re-apply the refund → complete; and on a
 * refund that still fails, throw so the shared retry/dead-letter policy in
 * `processNextJob` applies AND an operator-visible signal is emitted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProcessNextJob = vi.fn();
const mockDeductAICredits = vi.fn();
const mockRefundAICredits = vi.fn();
const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();

vi.mock('../utils/jobQueue.js', () => ({
  processNextJob: (...args: unknown[]) => mockProcessNextJob(...args),
}));
vi.mock('../ai/cost-tracker.js', () => ({
  deductAICredits: (...args: unknown[]) => mockDeductAICredits(...args),
  refundAICredits: (...args: unknown[]) => mockRefundAICredits(...args),
}));
vi.mock('../utils/sentry.js', () => ({
  Sentry: {
    captureException: (...args: unknown[]) => mockCaptureException(...args),
    captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  },
}));
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: vi.fn(),
  },
}));

const {
  AI_CREDIT_RECONCILE_JOB_TYPE,
  runAiCreditReconcileJobs,
} = await import('./ai-credit-reconcile.js');

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

interface CapturedJob {
  id: string;
  type: string;
  payload: unknown;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  scheduled_for: string | null;
}

function job(payload: unknown, overrides: Partial<CapturedJob> = {}): CapturedJob {
  return {
    id: 'job-1',
    type: AI_CREDIT_RECONCILE_JOB_TYPE,
    payload,
    status: 'processing',
    priority: 5,
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    scheduled_for: null,
    ...overrides,
  };
}

const DEBITED_AT = '2026-08-31T23:59:00.000Z';

const validPayload = {
  orgId: ORG_ID,
  userId: USER_ID,
  amount: 1,
  debitedAt: DEBITED_AT,
  reason: 'batch_extraction_failed_refund_failed',
  fingerprint: 'a'.repeat(64),
  source: 'ai-extract-batch',
};

/**
 * Drive the handler `runAiCreditReconcileJobs` passes to `processNextJob`,
 * exactly as the real queue would: one claimed job, then idle.
 */
function withClaimedJob(claimed: CapturedJob): void {
  let served = false;
  mockProcessNextJob.mockImplementation(
    async (_type: string, handler: (j: CapturedJob) => Promise<void>) => {
      if (served) return { claimed: false, status: 'idle' };
      served = true;
      try {
        await handler(claimed);
      } catch (err) {
        return {
          claimed: true,
          status: 'failed',
          jobId: claimed.id,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return { claimed: true, status: 'completed', jobId: claimed.id };
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeductAICredits.mockResolvedValue(true);
  mockRefundAICredits.mockResolvedValue({ status: 'refunded', amount: 1 });
  mockProcessNextJob.mockResolvedValue({ claimed: false, status: 'idle' });
});

describe('ai_credits.reconcile_refund consumer', () => {
  it('claims the ai_credits.reconcile_refund type (the producer had no consumer at all)', async () => {
    await runAiCreditReconcileJobs({ limit: 1 });

    expect(AI_CREDIT_RECONCILE_JOB_TYPE).toBe('ai_credits.reconcile_refund');
    expect(mockProcessNextJob).toHaveBeenCalledWith(
      'ai_credits.reconcile_refund',
      expect.any(Function),
    );
  });

  // Was `deductAICredits(org, user, -amount)` until migration 0483. 0467 had
  // added `p_amount <= 0 -> RETURN false` to that RPC, so this reconciler —
  // the last line of defence against an overcharge — silently reconciled
  // nothing and dead-lettered every job it ever claimed. It now calls the
  // dedicated `refund_ai_credits` RPC with a POSITIVE amount.
  it('re-applies the lost refund through refundAICredits with a POSITIVE amount', async () => {
    withClaimedJob(job(validPayload));

    const result = await runAiCreditReconcileJobs({ limit: 5 });

    // S8 / S2: the ids AND the instant the debit was taken, replayed verbatim,
    // so a retry that runs after a month rollover still refunds the period the
    // charge is actually in, from the row the debit came from.
    expect(mockRefundAICredits).toHaveBeenCalledWith(
      { orgId: ORG_ID, userId: USER_ID, debitedAt: DEBITED_AT },
      1,
    );
    expect(mockDeductAICredits).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('honours a multi-credit amount rather than assuming 1', async () => {
    withClaimedJob(job({ ...validPayload, amount: 3 }));

    await runAiCreditReconcileJobs({ limit: 5 });

    expect(mockRefundAICredits).toHaveBeenCalledWith(
      { orgId: ORG_ID, userId: USER_ID, debitedAt: DEBITED_AT },
      3,
    );
  });

  // S1. Migration 0485 returns the number of credits ACTUALLY returned. Zero
  // means the period's floor clamped the decrement to nothing — the credit was
  // already back, which is the expected outcome of the double refund this
  // queue structurally permits (no idempotency key; a refund that COMMITS and
  // whose response is lost is re-enqueued).
  //
  // Until 0485 the RPC answered `true` here, so this consumer logged "AI
  // credit refund reconciled" over a job that moved zero credit — the one
  // outcome an operator most needs to see, reported as success.
  describe('a clamped refund (0485: zero credits actually returned)', () => {
    beforeEach(() => {
      mockRefundAICredits.mockResolvedValue({ status: 'clamped' });
      withClaimedJob(job(validPayload));
    });

    it('does NOT log "refund reconciled"', async () => {
      await runAiCreditReconcileJobs({ limit: 5 });

      expect(mockLoggerInfo).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('reconciled'),
      );
    });

    it('completes the job — retrying cannot turn a clamp into a refund', async () => {
      const result = await runAiCreditReconcileJobs({ limit: 5 });

      expect(result.reconciled).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('logs at warn with the ids and emits a distinguishable signal', async () => {
      await runAiCreditReconcileJobs({ limit: 5 });

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, userId: USER_ID, jobId: 'job-1' }),
        expect.stringContaining('ZERO credits'),
      );
      // Its OWN Sentry signal — not the captureException the dead-letter path
      // uses, so a clamp can never be counted as a lost refund or vice versa.
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        expect.stringContaining('clamped to zero'),
        expect.objectContaining({ level: 'warning' }),
      );
      expect(mockCaptureException).not.toHaveBeenCalled();
    });
  });

  // S2 backwards compatibility. Jobs enqueued before 0485 shipped carry no
  // `debitedAt`; they must keep validating and keep running, falling back to
  // the RPC's `now()` — exactly the behaviour they were enqueued under.
  it('accepts a legacy payload with no debitedAt and refunds without one', async () => {
    const { debitedAt: _omitted, ...legacyPayload } = validPayload;
    withClaimedJob(job(legacyPayload));

    const result = await runAiCreditReconcileJobs({ limit: 5 });

    expect(mockRefundAICredits).toHaveBeenCalledWith(
      { orgId: ORG_ID, userId: USER_ID, debitedAt: undefined },
      1,
    );
    expect(result.reconciled).toBe(1);
  });

  it('rejects a malformed debitedAt rather than refunding against the wrong period', async () => {
    withClaimedJob(job({ ...validPayload, debitedAt: 'last tuesday' }));

    const result = await runAiCreditReconcileJobs({ limit: 5 });

    expect(mockRefundAICredits).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('throws when the refund fails again so processNextJob retries then dead-letters', async () => {
    mockRefundAICredits.mockResolvedValue({ status: 'rpc_failed' });
    withClaimedJob(job(validPayload));

    const result = await runAiCreditReconcileJobs({ limit: 5 });

    expect(result.reconciled).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('emits a Sentry event when the job dead-letters — a permanently lost refund is an overcharge', async () => {
    mockRefundAICredits.mockResolvedValue({ status: 'rpc_failed' });
    // Last attempt: processNextJob will mark this `dead`, not `failed`.
    withClaimedJob(job(validPayload, { attempts: 3, max_attempts: 3 }));

    await runAiCreditReconcileJobs({ limit: 5 });

    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('rejects a payload with no org and no user instead of issuing an unattributable credit', async () => {
    withClaimedJob(job({ ...validPayload, orgId: null, userId: null }));

    const result = await runAiCreditReconcileJobs({ limit: 5 });

    expect(mockRefundAICredits).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('rejects a non-positive amount instead of deducting or no-oping silently', async () => {
    withClaimedJob(job({ ...validPayload, amount: 0 }));

    const result = await runAiCreditReconcileJobs({ limit: 5 });

    expect(mockRefundAICredits).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('refuses an implausibly large amount — this job MINTS credits, so it is bounded', async () => {
    withClaimedJob(job({ ...validPayload, amount: 1_000_000 }));

    const result = await runAiCreditReconcileJobs({ limit: 5 });

    expect(mockRefundAICredits).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('stops early when the queue is idle instead of burning the full limit', async () => {
    await runAiCreditReconcileJobs({ limit: 25 });

    expect(mockProcessNextJob).toHaveBeenCalledTimes(1);
  });

  it('never logs the reconciliation payload verbatim (no fingerprint in log values)', async () => {
    mockRefundAICredits.mockResolvedValue({ status: 'rpc_failed' });
    withClaimedJob(job(validPayload));

    await runAiCreditReconcileJobs({ limit: 1 });

    const logged = JSON.stringify(mockLoggerError.mock.calls);
    expect(logged).not.toContain('a'.repeat(64));
  });
});
