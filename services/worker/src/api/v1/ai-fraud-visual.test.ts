/**
 * Tests for Visual Fraud Detection Endpoint (Phase 5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../ai/visualFraudDetector.js', () => ({
  analyzeDocumentImage: vi.fn(),
}));

import { analyzeDocumentImage } from '../../ai/visualFraudDetector.js';
import { Request, Response } from 'express';
import { aiFraudVisualRouter } from './ai-fraud-visual.js';

function getPostHandler() {
  const layer = (aiFraudVisualRouter as { stack: Array<{ route?: { methods: { post: boolean }; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack
    .find((l) => l.route?.methods?.post);
  return layer?.route?.stack[0].handle;
}

function createMockReqRes(body: Record<string, unknown> = {}) {
  const req = {
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
  imageBase64: 'a'.repeat(200), // min 100 chars
  mimeType: 'image/png',
  credentialType: 'DEGREE',
};

describe('POST /api/v1/ai/fraud/visual', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for missing imageBase64', async () => {
    const handler = getPostHandler()!;
    const { req, res } = createMockReqRes({
      mimeType: 'image/png',
      credentialType: 'DEGREE',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Invalid request' }),
    );
  });

  it('returns 400 for invalid mimeType', async () => {
    const handler = getPostHandler()!;
    const { req, res } = createMockReqRes({
      imageBase64: 'a'.repeat(200),
      mimeType: 'application/pdf',
      credentialType: 'DEGREE',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 for too-short imageBase64', async () => {
    const handler = getPostHandler()!;
    const { req, res } = createMockReqRes({
      imageBase64: 'short',
      mimeType: 'image/png',
      credentialType: 'DEGREE',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 for missing credentialType', async () => {
    const handler = getPostHandler()!;
    const { req, res } = createMockReqRes({
      imageBase64: 'a'.repeat(200),
      mimeType: 'image/png',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns analysis result on success', async () => {
    const mockResult = {
      riskLevel: 'LOW' as const,
      riskScore: 12,
      signals: [
        {
          id: 'font_consistent',
          category: 'font' as const,
          severity: 'info' as const,
          description: 'Consistent font usage throughout',
          confidence: 0.95,
        },
      ],
      summary: 'Document appears authentic with no significant fraud indicators.',
      recommendations: ['No action needed'],
      model: 'gemini-2.5-flash',
      processingTimeMs: 1200,
    };

    vi.mocked(analyzeDocumentImage).mockResolvedValue(mockResult);

    const handler = getPostHandler()!;
    const { req, res } = createMockReqRes(validBody);

    await handler(req, res);

    expect(analyzeDocumentImage).toHaveBeenCalledWith(
      validBody.imageBase64,
      validBody.mimeType,
      validBody.credentialType,
    );
    expect(res.json).toHaveBeenCalledWith({
      riskLevel: 'LOW',
      riskScore: 12,
      signals: mockResult.signals,
      summary: mockResult.summary,
      recommendations: mockResult.recommendations,
      model: 'gemini-2.5-flash',
      processingTimeMs: 1200,
    });
  });

  it('returns 500 when analyzeDocumentImage throws', async () => {
    vi.mocked(analyzeDocumentImage).mockRejectedValue(new Error('Gemini API error'));

    const handler = getPostHandler()!;
    const { req, res } = createMockReqRes(validBody);

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Visual fraud analysis failed',
        message: 'Gemini API error',
      }),
    );
  });

  it('accepts all valid mime types', async () => {
    const mockResult = {
      riskLevel: 'LOW' as const,
      riskScore: 5,
      signals: [],
      summary: 'Clean',
      recommendations: [],
      model: 'gemini-2.5-flash',
      processingTimeMs: 800,
    };
    vi.mocked(analyzeDocumentImage).mockResolvedValue(mockResult);

    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      const handler = getPostHandler()!;
      const { req, res } = createMockReqRes({
        imageBase64: 'a'.repeat(200),
        mimeType: mime,
        credentialType: 'LICENSE',
      });

      await handler(req, res);

      expect(res.json).toHaveBeenCalled();
    }
  });
});
