/**
 * Tests for AI Extraction Endpoint (P8-S4)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../ai/factory.js', () => ({
  createAIProvider: vi.fn(),
  createExtractionProvider: vi.fn(),
}));

vi.mock('../../ai/gemini.js', () => ({
  GeminiProvider: vi.fn(),
}));

vi.mock('../../ai/cost-tracker.js', () => ({
  checkAICredits: vi.fn(),
  deductAICredits: vi.fn(),
  refundAICredits: vi.fn().mockResolvedValue(true),
  ensureAICreditsPeriod: vi.fn().mockResolvedValue(true),
  logAIUsageEvent: vi.fn().mockResolvedValue(undefined),
}));

const captureCreditRpcFailureAlert = vi.hoisted(() => vi.fn());
vi.mock('../../utils/sentry.js', () => ({ captureCreditRpcFailureAlert }));

import { db } from '../../utils/db.js';
import { createExtractionProvider } from '../../ai/factory.js';
import { GeminiProvider } from '../../ai/gemini.js';
import {
  checkAICredits,
  deductAICredits,
  refundAICredits,
  ensureAICreditsPeriod,
} from '../../ai/cost-tracker.js';
import { logger } from '../../utils/logger.js';
import { Request, Response } from 'express';
import {
  AI_EXTRACTION_LATENCY_BUDGET_MS,
  aiExtractRouter,
  inferJurisdiction,
  resolveExtractionLatencyBudgetMs,
} from './ai-extract.js';

function getPostHandler() {
  const layer = (aiExtractRouter as { stack: Array<{ route?: { methods: { post: boolean }; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack
    .find((l) => l.route?.methods?.post);
  return layer?.route?.stack[0].handle;
}

function createMockReqRes(body: Record<string, unknown> = {}, authUserId?: string) {
  const req = {
    authUserId,
    body,
    method: 'POST',
    url: '/',
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

const validBody = {
  strippedText: 'University of Michigan\nBachelor of Science',
  credentialType: 'DEGREE',
  fingerprint: 'a'.repeat(64),
  issuerHint: 'University of Michigan',
};

function mockManifestTable() {
  return {
    insert: vi.fn().mockResolvedValue({ error: null }),
  };
}

function mockUsageEventsTable() {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            not: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
    insert: vi.fn().mockResolvedValue({ error: null }),
  };
}

function mockProfileTable() {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { org_id: 'org-456' }, error: null }),
  };
}

function mockExtractionDatabase(): void {
  (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === 'ai_usage_events') return mockUsageEventsTable();
    if (table === 'extraction_manifests') return mockManifestTable();
    return mockProfileTable();
  });
}

type AIExtractResponse = Record<string, unknown> & {
  confidence?: number;
  provider?: string;
  tags?: unknown;
  subType?: unknown;
  fraudSignals?: unknown;
  confidenceScores?: unknown;
  description?: unknown;
  fields?: Record<string, unknown>;
  degraded?: boolean;
  creditsRemaining?: unknown;
};

describe('AI Extraction Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (GeminiProvider as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generateTags: vi.fn().mockResolvedValue({
        tags: ['credential'],
        documentType: 'degree',
        category: 'education',
      }),
    }));
  });

  it('returns 401 when not authenticated', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody);
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 400 on invalid request body', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes({ strippedText: '' }, 'user-123');
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'validation_error' }),
    );
  });

  it('returns 402 when credits exhausted (RISK-6: synchronous credit check)', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 50,
      usedThisMonth: 50,
      remaining: 0,
      hasCredits: false,
    });

    await handler!(req, res);
    // RISK-6: Synchronous credit check now blocks extraction
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'insufficient_credits',
      }),
    );
  });

  // SCRUM-4939: nothing ever provisioned an `ai_credits` row for a new org,
  // so the fail-closed path below unconditionally 503'd a first-ever
  // extraction. `ensureAICreditsPeriod` must run for the org on every request
  // before the debit, and its own failure must not block the debit attempt.
  describe('SCRUM-4939 — ai_credits auto-provisioning', () => {
    it('provisions the current ai_credits period before deducting, when orgId is present', async () => {
      const handler = getPostHandler();
      const { req, res } = createMockReqRes(validBody, 'user-123');

      mockExtractionDatabase();

      (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
        monthlyAllocation: 100,
        usedThisMonth: 0,
        remaining: 100,
        hasCredits: true,
      });
      (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
        extractMetadata: vi.fn().mockResolvedValue({
          fields: { credentialType: 'DEGREE' },
          confidence: 0.9,
          provider: 'gemini',
          tokensUsed: 100,
        }),
      });

      await handler!(req, res);

      expect(ensureAICreditsPeriod).toHaveBeenCalledWith('org-456');
      // Provisioning must happen before the debit it exists to unblock.
      const ensureOrder = (ensureAICreditsPeriod as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const deductOrder = (deductAICredits as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      expect(ensureOrder).toBeLessThan(deductOrder);
    });

    /**
     * `check_ai_credits` has an operator-precedence bug in its WHERE clause
     * (`A OR B AND C AND D` parses as `A OR (B AND C AND D)`), so with an org
     * id it matches ANY row for that org regardless of period, `LIMIT 1` with
     * no ORDER BY. An org whose only row is an exhausted PRIOR period therefore
     * gets a 402 from this guard and returns before provisioning ever runs —
     * the exact "org is stuck and cannot extract" failure this PR exists to
     * fix. Provisioning must precede the check, not sit between it and the
     * debit (this is also what ai-extract-batch.ts already does).
     */
    it('provisions the period BEFORE the up-front credit check, so a stale exhausted row cannot 402 first', async () => {
      const handler = getPostHandler();
      const { req, res } = createMockReqRes(validBody, 'user-123');

      mockExtractionDatabase();

      // What check_ai_credits returns for an org whose only row is a spent
      // prior period.
      (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
        monthlyAllocation: 100,
        usedThisMonth: 100,
        remaining: 0,
        hasCredits: false,
      });
      (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await handler!(req, res);

      expect(ensureAICreditsPeriod).toHaveBeenCalledWith('org-456');
      const ensureOrder = (ensureAICreditsPeriod as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const checkOrder = (checkAICredits as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      expect(ensureOrder).toBeLessThan(checkOrder);
    });

    it('does not call ensureAICreditsPeriod when orgId is undefined', async () => {
      const handler = getPostHandler();
      const { req, res } = createMockReqRes(validBody, 'user-123');

      // No org on the profile — orgId resolves to undefined.
      (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'ai_usage_events') return mockUsageEventsTable();
        if (table === 'extraction_manifests') return mockManifestTable();
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { org_id: null }, error: null }),
        };
      });

      (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await handler!(req, res);

      expect(ensureAICreditsPeriod).not.toHaveBeenCalled();
    });

    // A genuine deduction failure (insufficient credits / RPC error) must
    // still fail CLOSED with 503, even though the period was successfully
    // provisioned — provisioning only fixes the "no row at all" case, it is
    // not a substitute for the credit check itself.
    it('still returns 503 when deduct_ai_credits genuinely fails after successful provisioning', async () => {
      const handler = getPostHandler();
      const { req, res } = createMockReqRes(validBody, 'user-123');

      mockExtractionDatabase();

      (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
        monthlyAllocation: 100,
        usedThisMonth: 100,
        remaining: 0,
        hasCredits: true, // stale/racy read — the debit itself is what fails
      });
      (ensureAICreditsPeriod as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const extractMetadata = vi.fn();
      (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({ extractMetadata });

      await handler!(req, res);

      expect(extractMetadata).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'credit_system_unavailable' }),
      );
    });
  });

  // ---------------------------------------------------------------------
  // The AI-credit refund regression from 0467.
  //
  // This path debits 1 credit, then refunds it when the provider fails or
  // blows the latency budget. It did that with `deductAICredits(org, user, -1)`
  // — and 0467 added `IF p_amount <= 0 THEN RETURN false` to the RPC, so since
  // 2026-09-19 the refund has returned false and refunded nothing. Every failed
  // extraction stayed charged. Migration 0483 adds a dedicated
  // `refund_ai_credits` RPC; `deduct_ai_credits` deliberately stays closed to
  // negative amounts.
  // ---------------------------------------------------------------------
  describe('refund on extraction failure', () => {
    async function runFailingExtraction() {
      const handler = getPostHandler();
      const { req, res } = createMockReqRes(validBody, 'user-123');
      mockExtractionDatabase();
      (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
        monthlyAllocation: 500,
        usedThisMonth: 10,
        remaining: 490,
        hasCredits: true,
      });
      (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
        name: 'gemini',
        extractMetadata: vi.fn().mockRejectedValue(new Error('provider exploded')),
      });
      await handler!(req, res);
      return res;
    }

    it('refunds via refund_ai_credits with a POSITIVE amount, not a negative debit', async () => {
      await runFailingExtraction();

      expect(refundAICredits).toHaveBeenCalledWith('org-456', 'user-123', 1);
      expect(deductAICredits).not.toHaveBeenCalledWith('org-456', 'user-123', -1);
    });

    it('logs a failed refund at ERROR with the ids and still answers the caller', async () => {
      (refundAICredits as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      const res = await runFailingExtraction();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'org-456', userId: 'user-123' }),
        expect.stringContaining('refund'),
      );
      // A failed refund is an ops problem, not a user-facing failure: the
      // degraded-fallback response is unchanged.
      expect(res.status).not.toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalled();
    });
  });

  it('returns extracted fields on success', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });

    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      extractMetadata: vi.fn().mockResolvedValue({
        fields: {
          credentialType: 'DEGREE',
          issuerName: 'University of Michigan',
          fieldOfStudy: 'Computer Science',
          subType: 'BACHELOR',
          description: 'Bachelor of Science in Computer Science',
          fraudSignals: [{ signal: 'font_mismatch', severity: 'low' }],
        },
        confidence: 0.92,
        provider: 'gemini',
        tokensUsed: 150,
      }),
    });

    (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await handler!(req, res);
    // Confidence is now calibrated: raw 0.92 maps to 0.92 via calibration knots (1030-entry recalibration)
    const responseJson: AIExtractResponse = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(responseJson).toEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          credentialType: 'DEGREE',
          issuerName: 'University of Michigan',
        }),
        confidence: 0.92,
        provider: 'gemini',
        creditsRemaining: 489,
      }),
    );

    // API-RICH-02: rich fields are surfaced top-level for agent consumers.
    expect(responseJson.confidenceScores).toEqual({ overall: 0.92 });
    expect(responseJson.subType).toBe('BACHELOR');
    expect(responseJson.description).toBe('Bachelor of Science in Computer Science');
    expect(responseJson.fraudSignals).toEqual([{ signal: 'font_mismatch', severity: 'low' }]);

    // Happy path (deduction succeeded) — no alert.
    expect(captureCreditRpcFailureAlert).not.toHaveBeenCalled();
  });

  // SCRUM-3502 / DI-576 — deduct_ai_credits failing used to let a FREE AI
  // extraction proceed (fail OPEN) with a Sentry page but no behavior change.
  // The page named it correctly: "a REVENUE LEAK (free AI extraction)". The
  // product decision is now fail CLOSED — `checkAICredits` said this org HAS
  // credits, the debit did not land, so no credit was consumed and the paid
  // work must not be performed. Reversing the RISK-6 fail-OPEN default.
  it('fails CLOSED with 503 and never calls the provider when deduct_ai_credits fails', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });

    const extractMetadata = vi.fn().mockResolvedValue({
      fields: { credentialType: 'DEGREE' },
      confidence: 0.9,
      provider: 'gemini',
      tokensUsed: 100,
    });
    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({ extractMetadata });

    // Deduction fails (DB error), NOT insufficient balance.
    (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await handler!(req, res);

    // The paid work must NOT happen — this is the whole point of fail-closed.
    expect(extractMetadata).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(503);
    const responseJson = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(responseJson).toEqual(
      expect.objectContaining({ error: 'credit_system_unavailable' }),
    );
    // Must not claim the org is out of credits — checkAICredits just said the
    // opposite, and telling them to buy more would be a lie.
    expect(responseJson.error).not.toBe('insufficient_credits');

    expect(captureCreditRpcFailureAlert).toHaveBeenCalledTimes(1);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        rpc: 'deduct_ai_credits',
        operation: 'ai-extract.deductAICredits',
        failMode: 'closed',
        orgId: 'org-456',
        userId: 'user-123',
      }),
    );
  });

  // The other half of the same defect class: NO `ai_credits` row at all.
  // `check_ai_credits` returns zero rows (not an error) for a caller with no
  // row, so `checkAICredits` resolves null; `deduct_ai_credits` sees the same
  // missing row and cleanly returns false. Before this fix the guard required
  // `creditBalance` to be truthy, so `!deducted && creditBalance` was
  // `true && null` — falsy — and execution fell through to a FREE extraction
  // with no credit accounting at all. This is the exact "missing row means no
  // entitlement, not free" bug SCRUM-2538 fixes for check_unified_credits;
  // ai-extract's sibling ai_credits path must fail CLOSED the same way.
  it('fails CLOSED with 503 and never calls the provider when there is no ai_credits row', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    // No ai_credits row for this org/user: check_ai_credits returns zero rows,
    // so checkAICredits resolves null (not an object with hasCredits: false).
    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const extractMetadata = vi.fn().mockResolvedValue({
      fields: { credentialType: 'DEGREE' },
      confidence: 0.9,
      provider: 'gemini',
      tokensUsed: 100,
    });
    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({ extractMetadata });

    // deduct_ai_credits sees the same missing row and cleanly returns false —
    // no RPC error, just a definitive "nothing to debit".
    (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await handler!(req, res);

    // The paid work must NOT happen — this is the whole point of fail-closed.
    expect(extractMetadata).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(503);
    const responseJson = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(responseJson).toEqual(
      expect.objectContaining({ error: 'credit_system_unavailable' }),
    );
    expect(responseJson.error).not.toBe('insufficient_credits');

    expect(captureCreditRpcFailureAlert).toHaveBeenCalledTimes(1);
    expect(captureCreditRpcFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        rpc: 'deduct_ai_credits',
        operation: 'ai-extract.deductAICredits',
        failMode: 'closed',
        orgId: 'org-456',
        userId: 'user-123',
      }),
    );
  });

  // API-RICH-02 (SCRUM-895): description completes the trio (confidenceScores +
  // subType + description) the public AC promises.
  it('surfaces description top-level when extracted (SCRUM-895)', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });

    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      extractMetadata: vi.fn().mockResolvedValue({
        fields: {
          credentialType: 'DEGREE',
          description: 'Bachelor of Science in Computer Engineering',
        },
        confidence: 0.9,
        provider: 'gemini',
        tokensUsed: 120,
      }),
    });

    (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await handler!(req, res);
    const responseJson: AIExtractResponse = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(responseJson.description).toBe('Bachelor of Science in Computer Engineering');
  });

  it('returns null description when not extracted (SCRUM-895)', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });

    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      extractMetadata: vi.fn().mockResolvedValue({
        fields: { credentialType: 'CERTIFICATE' },
        confidence: 0.8,
        provider: 'gemini',
        tokensUsed: 100,
      }),
    });

    (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await handler!(req, res);
    const responseJson: AIExtractResponse = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(responseJson.description).toBeNull();
  });

  it('returns null for optional rich fields when they are not present in extraction (API-RICH-02)', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });

    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      extractMetadata: vi.fn().mockResolvedValue({
        fields: { credentialType: 'CERTIFICATE', issuerName: 'Test Corp' },
        confidence: 0.85,
        provider: 'gemini',
        tokensUsed: 100,
      }),
    });

    (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await handler!(req, res);

    const responseJson: AIExtractResponse = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(responseJson.subType).toBeNull();
    expect(responseJson.description).toBeNull();
    expect(responseJson.fraudSignals).toBeNull();
    expect(responseJson.confidenceScores).toEqual({ overall: responseJson.confidence });
  });

  it('applies confidence calibration to AI model output (AI-EVAL-02)', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });

    // Model reports 0.75 confidence — calibration should map this upward
    // 0.75 is between knots [0.70, 0.80] and [0.76, 0.84]
    // t = (0.75 - 0.70) / (0.76 - 0.70) = 0.833
    // calibrated = 0.80 + 0.833 * (0.84 - 0.80) = 0.833
    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      extractMetadata: vi.fn().mockResolvedValue({
        fields: { credentialType: 'CERTIFICATE', issuerName: 'AWS' },
        confidence: 0.75,
        provider: 'gemini',
        tokensUsed: 100,
      }),
    });

    (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await handler!(req, res);

    const responseJson: AIExtractResponse = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Calibrated confidence should differ from raw 0.75
    expect(responseJson.confidence).not.toBe(0.75);
    // Should be calibrated to ~0.83 (piecewise linear interpolation, 1030-entry knots)
    expect(responseJson.confidence).toBeCloseTo(0.83, 2);
  });

  it('returns degraded fallback metadata on circuit breaker open', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });

    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      extractMetadata: vi.fn().mockRejectedValue(new Error('circuit breaker open')),
    });

    await handler!(req, res);
    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fast-fallback',
        degraded: true,
      }),
    );
  });

  it('returns degraded fallback metadata on unexpected provider error', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });

    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      extractMetadata: vi.fn().mockRejectedValue(new Error('unexpected error')),
    });

    await handler!(req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fast-fallback',
        degraded: true,
      }),
    );
  });

  it('returns a fast fallback when the AI provider exceeds the latency budget', async () => {
    vi.useFakeTimers();
    try {
      const handler = getPostHandler();
      const { req, res } = createMockReqRes(validBody, 'user-123');

      mockExtractionDatabase();

      (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
        monthlyAllocation: 500,
        usedThisMonth: 10,
        remaining: 490,
        hasCredits: true,
      });

      (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
        extractMetadata: vi.fn().mockReturnValue(new Promise(() => {})),
      });

      const pending = handler!(req, res);
      await vi.advanceTimersByTimeAsync(AI_EXTRACTION_LATENCY_BUDGET_MS);
      await pending;

      const responseJson: AIExtractResponse = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(res.status).not.toHaveBeenCalledWith(500);
      expect(responseJson).toEqual(
        expect.objectContaining({
          provider: 'fast-fallback',
          degraded: true,
          creditsRemaining: 490,
        }),
      );
      expect(responseJson.fields).toEqual(
        expect.objectContaining({
          credentialType: 'DEGREE',
          issuerName: 'University of Michigan',
        }),
      );
      // A latency-budget overrun is a failed extraction: the credit comes back
      // through refund_ai_credits, not a negative debit (0467 closed that door
      // and nothing refunded for three weeks as a result).
      expect(refundAICredits).toHaveBeenCalledWith('org-456', 'user-123', 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the production extraction latency budget unless explicitly configured', () => {
    expect(resolveExtractionLatencyBudgetMs({})).toBe(AI_EXTRACTION_LATENCY_BUDGET_MS);
    expect(resolveExtractionLatencyBudgetMs({ AI_EXTRACTION_LATENCY_BUDGET_MS: '9000' })).toBe(9000);
    expect(resolveExtractionLatencyBudgetMs({ AI_EXTRACTION_LATENCY_BUDGET_MS: '0' })).toBe(AI_EXTRACTION_LATENCY_BUDGET_MS);
    expect(resolveExtractionLatencyBudgetMs({ AI_EXTRACTION_LATENCY_BUDGET_MS: 'not-a-number' })).toBe(AI_EXTRACTION_LATENCY_BUDGET_MS);
  });

  describe('inferJurisdiction (bug hunt fix — unanchored \\b substring false-match)', () => {
    it('does NOT match United States on the word CAUSATION (bug: unanchored USA substring)', () => {
      // "CAUSATION" contains "USA" as a raw substring (C-AUSA-TION). The
      // pre-fix regex only anchored \b to the first/last alternative in each
      // |-chain, leaving the middle "USA" alternative with no word-boundary
      // constraint on either side, so it matched inside unrelated words.
      expect(inferJurisdiction('Proximate CAUSATION is required under tort law.')).toBeUndefined();
    });

    it('does NOT match United States on other words containing "usa" as a substring', () => {
      // "causal" contains "usa" (c-AUSA-l); "usable" contains "usa" as a
      // prefix (USA-ble) — both are unrelated words, not the country.
      expect(inferJurisdiction('Causal analysis supports usable evidence.')).toBeUndefined();
    });

    it('still matches a legitimate standalone "USA" mention', () => {
      expect(inferJurisdiction('Licensed to practice in the USA.')).toBe('United States');
    });

    it('still matches "United States", "U.S.A.", and "U.S." as whole-word mentions', () => {
      expect(inferJurisdiction('Issued in the United States of America.')).toBe('United States');
      expect(inferJurisdiction('A citizen of the U.S.A. since birth.')).toBe('United States');
      expect(inferJurisdiction('Practicing law in the U.S. since 2015.')).toBe('United States');
    });

    it('does NOT match Kenya/Australia jurisdictions on substrings of unrelated words', () => {
      // "KDPA" and "OAIC"/"AHPRA"/"TEQSA" were also unanchored middle
      // alternatives — same bug class, different jurisdiction group.
      expect(inferJurisdiction('The team held a JUDPAKDPAX debrief.')).toBeUndefined();
      expect(inferJurisdiction('An XOAICX artifact was misfiled.')).toBeUndefined();
      expect(inferJurisdiction('The AHPRAXIMATE deadline slipped.')).toBeUndefined();
    });

    it('still matches legitimate whole-word Kenya jurisdiction terms', () => {
      expect(inferJurisdiction('Regulated by the ODPC under KDPA.')).toBe('Kenya');
      expect(inferJurisdiction('Issued in Kenya.')).toBe('Kenya');
    });

    it('still matches legitimate whole-word Australia jurisdiction terms', () => {
      expect(inferJurisdiction('Regulated by OAIC under the Privacy Act 1988.')).toBe('Australia');
      expect(inferJurisdiction('AHPRA-registered practitioner in Australia.')).toBe('Australia');
      expect(inferJurisdiction('TEQSA-accredited institution.')).toBe('Australia');
    });

    it('returns undefined when no jurisdiction terms are present', () => {
      expect(inferJurisdiction('Bachelor of Science in Computer Science.')).toBeUndefined();
    });
  });

  it('uses an explicit extraction latency budget before returning fallback metadata', async () => {
    vi.useFakeTimers();
    const originalBudget = process.env.AI_EXTRACTION_LATENCY_BUDGET_MS;
    process.env.AI_EXTRACTION_LATENCY_BUDGET_MS = String(AI_EXTRACTION_LATENCY_BUDGET_MS + 1_000);
    try {
      const handler = getPostHandler();
      const { req, res } = createMockReqRes(validBody, 'user-123');

      mockExtractionDatabase();

      (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
        monthlyAllocation: 500,
        usedThisMonth: 10,
        remaining: 490,
        hasCredits: true,
      });

      (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
        extractMetadata: vi.fn().mockReturnValue(new Promise(() => {})),
      });

      const pending = handler!(req, res);
      await vi.advanceTimersByTimeAsync(AI_EXTRACTION_LATENCY_BUDGET_MS);
      expect(res.json).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      const responseJson: AIExtractResponse = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(responseJson).toEqual(
        expect.objectContaining({
          provider: 'fast-fallback',
          degraded: true,
        }),
      );
    } finally {
      if (originalBudget === undefined) {
        delete process.env.AI_EXTRACTION_LATENCY_BUDGET_MS;
      } else {
        process.env.AI_EXTRACTION_LATENCY_BUDGET_MS = originalBudget;
      }
      vi.useRealTimers();
    }
  });

  it('does not block the extraction response on slow best-effort tagging', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    mockExtractionDatabase();

    (checkAICredits as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    });

    (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (createExtractionProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      extractMetadata: vi.fn().mockResolvedValue({
        fields: { credentialType: 'DEGREE', issuerName: 'University of Michigan' },
        confidence: 0.92,
        provider: 'gemini',
        tokensUsed: 150,
      }),
    });
    (GeminiProvider as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generateTags: vi.fn().mockReturnValue(new Promise(() => {})),
    }));

    const result = await Promise.race([
      Promise.resolve(handler!(req, res)).then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 25)),
    ]);

    expect(result).toBe('resolved');
    const responseJson: AIExtractResponse = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(responseJson.provider).toBe('gemini');
    expect(responseJson.tags).toBeUndefined();
  });
});
