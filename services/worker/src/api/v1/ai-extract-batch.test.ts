/**
 * BETA-06: Batch AI Extraction Endpoint Tests
 *
 * POST /api/v1/ai/extract-batch
 * Accepts array of row data, returns array of extraction results.
 *
 * BUG-2026-06-24-013 (credit-ledger integrity): the batch path now debits and
 * refunds PER ITEM inside parallelMap (parity with the single path), so
 * batch-level double-accounting is structurally impossible:
 *   - a failed up-front debit can no longer grant a free batch,
 *   - only successful rows are charged (no blanket refund of an absent debit),
 *   - a refund failure after a successful debit is NOT swallowed — it enqueues
 *     a reconciliation job.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock dependencies
const mockExtractionProvider = {
  extractMetadata: vi.fn().mockResolvedValue({
    fields: { credentialType: 'DEGREE', issuerName: 'MIT' },
    confidence: 0.85,
    provider: 'mock',
    tokensUsed: 100,
  }),
};
vi.mock('../../ai/factory.js', () => ({
  createAIProvider: vi.fn(() => mockExtractionProvider),
  createExtractionProvider: vi.fn(() => mockExtractionProvider),
}));

vi.mock('../../ai/cost-tracker.js', () => ({
  checkAICredits: vi.fn().mockResolvedValue({
    monthlyAllocation: 500,
    usedThisMonth: 10,
    remaining: 490,
    hasCredits: true,
  }),
  deductAICredits: vi.fn().mockResolvedValue(true),
  logAIUsageEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/jobQueue.js', () => ({
  submitJob: vi.fn().mockResolvedValue('job-1'),
}));

// Default DB mock: profile lookup returns an org, fingerprint cache lookup
// returns no rows (cache miss → provider is called).
function makeUsageEventsCacheQuery(rows: unknown[] = []) {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            not: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
              })),
            })),
          })),
        })),
      })),
    })),
  };
}

function makeProfileQuery(orgId: string | null = 'org-1') {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({ data: { org_id: orgId }, error: null }),
      })),
    })),
  };
}

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      if (table === 'ai_usage_events') return makeUsageEventsCacheQuery([]);
      return makeProfileQuery('org-1');
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../ai/eval/calibration.js', () => ({
  // Router used by production code — test offset lives here.
  calibrateConfidenceByProvider: vi.fn((_provider: string, raw: number) => raw + 0.05),
  // Preserved in case other tests still import the direct helpers.
  calibrateConfidence: vi.fn((raw: number) => raw + 0.05),
  calibrateNessieConfidence: vi.fn((raw: number) => raw - 0.4),
}));

import { aiBatchExtractRouter, BATCH_ROW_LATENCY_BUDGET_MS } from './ai-extract-batch.js';
import { db } from '../../utils/db.js';
import { checkAICredits, deductAICredits } from '../../ai/cost-tracker.js';
import { calibrateConfidenceByProvider } from '../../ai/eval/calibration.js';
import { submitJob } from '../../utils/jobQueue.js';

function createApp() {
  const app = express();
  app.use(express.json());
  // Simulate authenticated user
  app.use((req, _res, next) => {
    req.authUserId = 'user-1';
    next();
  });
  app.use('/', aiBatchExtractRouter);
  return app;
}

// Direct handler access — used for fake-timer tests, which cannot drive a real
// supertest socket (mirrors the single-path test's getPostHandler()).
function getPostHandler() {
  const layer = (aiBatchExtractRouter as { stack: Array<{ route?: { methods: { post: boolean }; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack
    .find((l) => l.route?.methods?.post);
  return layer?.route?.stack[0].handle;
}

function createMockReqRes(body: Record<string, unknown>, authUserId?: string) {
  const req = { authUserId, body, method: 'POST', url: '/' } as unknown as import('express').Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as import('express').Response;
  return { req, res };
}

describe('POST /api/v1/ai/extract-batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish default provider + db behavior after clearAllMocks.
    mockExtractionProvider.extractMetadata.mockResolvedValue({
      fields: { credentialType: 'DEGREE', issuerName: 'MIT' },
      confidence: 0.85,
      provider: 'mock',
      tokensUsed: 100,
    });
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'ai_usage_events') return makeUsageEventsCacheQuery([]) as never;
      return makeProfileQuery('org-1') as never;
    });
    vi.mocked(checkAICredits).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });
    vi.mocked(deductAICredits).mockResolvedValue(true);
    vi.mocked(submitJob).mockResolvedValue('job-1');
  });

  it('returns 401 if no auth', async () => {
    const app = express();
    app.use(express.json());
    app.use('/', aiBatchExtractRouter);

    const res = await request(app)
      .post('/')
      .send({ rows: [{ text: 'test', credentialType: 'DEGREE' }] });

    expect(res.status).toBe(401);
  });

  it('returns 400 for empty rows array', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({ rows: [] });

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing rows field', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({ data: 'invalid' });

    expect(res.status).toBe(400);
  });

  it('returns 400 if rows exceed max batch size (50)', async () => {
    const app = createApp();
    const rows = Array.from({ length: 51 }, (_, i) => ({
      text: `row ${i}`,
      credentialType: 'DEGREE',
    }));

    const res = await request(app)
      .post('/')
      .send({ rows });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('returns 402 up-front when the org has no credits (no free batch)', async () => {
    vi.mocked(checkAICredits).mockResolvedValue({
      monthlyAllocation: 50,
      usedThisMonth: 50,
      remaining: 0,
      hasCredits: false,
    });

    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'row 1', credentialType: 'DEGREE' },
          { text: 'row 2', credentialType: 'LICENSE' },
        ],
      });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('insufficient_credits');
    // No extraction work should have happened.
    expect(mockExtractionProvider.extractMetadata).not.toHaveBeenCalled();
  });

  it('allows batch extraction even with low (but non-zero) credits', async () => {
    vi.mocked(checkAICredits).mockResolvedValueOnce({
      monthlyAllocation: 500,
      usedThisMonth: 499,
      remaining: 1,
      hasCredits: true,
    });

    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'row 1', credentialType: 'DEGREE' },
          { text: 'row 2', credentialType: 'LICENSE' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it('successfully extracts batch of rows', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'Bachelor of Science from MIT, 2024', credentialType: 'DEGREE' },
          { text: 'Medical License #12345', credentialType: 'LICENSE' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].fields).toBeDefined();
    expect(res.body.results[0].confidence).toBeDefined();
    expect(res.body.creditsRemaining).toBeDefined();
  });

  it('applies confidence calibration to batch results (AI-EVAL-02)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'Bachelor of Science from MIT, 2024', credentialType: 'DEGREE' },
        ],
      });

    expect(res.status).toBe(200);
    // Mock provider returns confidence 0.85, calibration mock adds 0.05 → 0.90
    expect(res.body.results[0].confidence).toBe(0.9);
    expect(calibrateConfidenceByProvider).toHaveBeenCalledWith('mock', 0.85);
  });

  it('handles partial failures gracefully', async () => {
    let callCount = 0;
    mockExtractionProvider.extractMetadata.mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error('AI provider timeout');
      return Promise.resolve({
        fields: { credentialType: 'DEGREE' },
        confidence: 0.9,
        provider: 'mock',
        tokensUsed: 50,
      });
    });

    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'row 1', credentialType: 'DEGREE' },
          { text: 'row 2', credentialType: 'LICENSE' },
          { text: 'row 3', credentialType: 'CERTIFICATE' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results.filter((r: { success: boolean }) => r.success)).toHaveLength(2);
    expect(res.body.results.filter((r: { success: boolean }) => !r.success)).toHaveLength(1);
    const failed = res.body.results.find((r: { success: boolean }) => !r.success);
    expect(failed.error).toBeDefined();
  });

  // ─── BUG-2026-06-24-013: credit-ledger integrity ──────────────────────────

  it('debits per item (one debit per row), not a single up-front batch debit', async () => {
    const app = createApp();
    await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'row 1', credentialType: 'DEGREE' },
          { text: 'row 2', credentialType: 'LICENSE' },
        ],
      });

    // Two rows → two single-credit debits, never one batch debit of 2.
    const debitCalls = vi
      .mocked(deductAICredits)
      .mock.calls.filter(([, , amount]) => amount === 1);
    expect(debitCalls).toHaveLength(2);
    // The buggy up-front batch debit must be gone.
    expect(deductAICredits).not.toHaveBeenCalledWith('org-1', 'user-1', 2);
  });

  it('does NOT grant free extraction when a per-item debit fails (no free batch)', async () => {
    // First row debit succeeds, second row debit fails (transient DB error).
    let debitInvocation = 0;
    vi.mocked(deductAICredits).mockImplementation((_org, _user, amount) => {
      if (amount === 1) {
        debitInvocation += 1;
        // First debit ok, subsequent debit fails.
        return Promise.resolve(debitInvocation <= 1);
      }
      return Promise.resolve(true);
    });

    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'row 1', credentialType: 'DEGREE' },
          { text: 'row 2', credentialType: 'LICENSE' },
        ],
      });

    expect(res.status).toBe(200);
    // The row whose debit failed must NOT have been extracted for free.
    const failed = res.body.results.filter((r: { success: boolean }) => !r.success);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/credit|payment/i);
    // Provider only called for the paid row.
    expect(mockExtractionProvider.extractMetadata).toHaveBeenCalledTimes(1);
  });

  it('refunds only the rows that actually failed extraction (no blanket refund)', async () => {
    let callCount = 0;
    mockExtractionProvider.extractMetadata.mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error('AI provider timeout');
      return Promise.resolve({
        fields: { credentialType: 'DEGREE' },
        confidence: 0.9,
        provider: 'mock',
        tokensUsed: 50,
      });
    });

    const app = createApp();
    await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'row 1', credentialType: 'DEGREE' },
          { text: 'row 2', credentialType: 'LICENSE' },
          { text: 'row 3', credentialType: 'CERTIFICATE' },
        ],
      });

    // Exactly ONE refund of a single credit (only the failed row).
    const refundCalls = vi
      .mocked(deductAICredits)
      .mock.calls.filter(([, , amount]) => amount === -1);
    expect(refundCalls).toHaveLength(1);
    // Never a batch-level negative refund.
    expect(deductAICredits).not.toHaveBeenCalledWith('org-1', 'user-1', -2);
  });

  it('does NOT silently swallow a refund failure — it enqueues a reconciliation job', async () => {
    // Row 1 succeeds; row 2 extraction fails, and its refund ALSO fails.
    let extractCall = 0;
    mockExtractionProvider.extractMetadata.mockImplementation(() => {
      extractCall++;
      if (extractCall === 2) throw new Error('AI provider timeout');
      return Promise.resolve({
        fields: { credentialType: 'DEGREE' },
        confidence: 0.9,
        provider: 'mock',
        tokensUsed: 50,
      });
    });
    vi.mocked(deductAICredits).mockImplementation((_org, _user, amount) => {
      if (amount === -1) return Promise.resolve(false); // refund fails
      return Promise.resolve(true); // debits succeed
    });

    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'row 1', credentialType: 'DEGREE' },
          { text: 'row 2', credentialType: 'LICENSE' },
        ],
      });

    expect(res.status).toBe(200);
    // A reconciliation job must be enqueued for the un-refunded debit.
    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(submitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai_credits.reconcile_refund',
        payload: expect.objectContaining({
          orgId: 'org-1',
          userId: 'user-1',
          amount: 1,
        }),
      }),
    );
  });

  it('serves a fingerprint cache hit without debiting or calling the provider (EFF-1 parity)', async () => {
    // ai_usage_events returns a cached extraction for the row fingerprint.
    const fp = 'a'.repeat(64);
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'ai_usage_events') {
        return makeUsageEventsCacheQuery([
          { result_json: { credentialType: 'DEGREE', issuerName: 'Cached U' }, confidence: 0.77 },
        ]) as never;
      }
      return makeProfileQuery('org-1') as never;
    });

    const app = createApp();
    const res = await request(app)
      .post('/')
      .send({
        rows: [{ text: 'cached row', credentialType: 'DEGREE', fingerprint: fp }],
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[0].provider).toBe('cache');
    // Cache hit → no provider call, no debit.
    expect(mockExtractionProvider.extractMetadata).not.toHaveBeenCalled();
    expect(deductAICredits).not.toHaveBeenCalledWith('org-1', 'user-1', 1);
  });

  it('treats a per-item latency-budget overrun as a failed (refunded) row, not a charge', async () => {
    vi.useFakeTimers();
    try {
      // Provider never resolves → latency budget fires. Invoke the handler
      // directly (not via supertest) so fake timers fully control the clock.
      mockExtractionProvider.extractMetadata.mockReturnValue(new Promise(() => {}));

      const handler = getPostHandler();
      const { req, res } = createMockReqRes(
        { rows: [{ text: 'slow row', credentialType: 'DEGREE' }] },
        'user-1',
      );

      const pending = handler!(req, res) as Promise<void>;
      // Advance past the per-item budget.
      await vi.advanceTimersByTimeAsync(BATCH_ROW_LATENCY_BUDGET_MS + 1);
      await pending;

      const responseJson = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        results: Array<{ success: boolean }>;
      };
      expect(responseJson.results[0].success).toBe(false);
      // Debited once, refunded once → net zero for the timed-out row.
      const debits = vi.mocked(deductAICredits).mock.calls.filter(([, , a]) => a === 1);
      const refunds = vi.mocked(deductAICredits).mock.calls.filter(([, , a]) => a === -1);
      expect(debits).toHaveLength(1);
      expect(refunds).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
