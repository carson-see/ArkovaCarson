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

vi.mock('../../ai/cost-tracker.js', () => ({
  checkAICredits: vi.fn(),
  deductAICredits: vi.fn(),
  logAIUsageEvent: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../../utils/db.js';
import { createExtractionProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits } from '../../ai/cost-tracker.js';
import { Request, Response } from 'express';
import { aiExtractRouter } from './ai-extract.js';

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

describe('AI Extraction Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    // EFF-1: db.from is called for cache lookup (ai_usage_events) then profiles
    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'ai_usage_events') {
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
      if (table === 'extraction_manifests') {
        return {
          insert: vi.fn().mockReturnValue({
            then: (cb: (v: unknown) => void) => { cb({ error: null }); return { catch: vi.fn() }; },
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { org_id: 'org-456' }, error: null }),
      };
    });

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

  it('returns extracted fields on success', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'ai_usage_events') {
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
      if (table === 'extraction_manifests') {
        return {
          insert: vi.fn().mockReturnValue({
            then: (cb: (v: unknown) => void) => { cb({ error: null }); return { catch: vi.fn() }; },
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { org_id: 'org-456' }, error: null }),
      };
    });

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
        },
        confidence: 0.92,
        provider: 'gemini',
        tokensUsed: 150,
      }),
    });

    (deductAICredits as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await handler!(req, res);
    // Confidence is now calibrated: raw 0.92 maps to 0.92 via calibration knots (1030-entry recalibration)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: expect.objectContaining({
          credentialType: 'DEGREE',
          issuerName: 'University of Michigan',
        }),
        confidence: 0.92,
        provider: 'gemini',
        creditsRemaining: 489, // 490 - 1 credit deducted
      }),
    );
  });

  it('applies confidence calibration to AI model output (AI-EVAL-02)', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'ai_usage_events') {
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
      if (table === 'extraction_manifests') {
        return {
          insert: vi.fn().mockReturnValue({
            then: (cb: (v: unknown) => void) => { cb({ error: null }); return { catch: vi.fn() }; },
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { org_id: 'org-456' }, error: null }),
      };
    });

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

    const responseJson = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Calibrated confidence should differ from raw 0.75
    expect(responseJson.confidence).not.toBe(0.75);
    // Should be calibrated to ~0.83 (piecewise linear interpolation, 1030-entry knots)
    expect(responseJson.confidence).toBeCloseTo(0.83, 2);
  });

  it('returns 503 on circuit breaker open', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'ai_usage_events') {
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
      if (table === 'extraction_manifests') {
        return {
          insert: vi.fn().mockReturnValue({
            then: (cb: (v: unknown) => void) => { cb({ error: null }); return { catch: vi.fn() }; },
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { org_id: 'org-456' }, error: null }),
      };
    });

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
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('returns 500 on unexpected error', async () => {
    const handler = getPostHandler();
    const { req, res } = createMockReqRes(validBody, 'user-123');

    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'ai_usage_events') {
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
      if (table === 'extraction_manifests') {
        return {
          insert: vi.fn().mockReturnValue({
            then: (cb: (v: unknown) => void) => { cb({ error: null }); return { catch: vi.fn() }; },
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { org_id: 'org-456' }, error: null }),
      };
    });

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
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'extraction_failed' }),
    );
  });
});
