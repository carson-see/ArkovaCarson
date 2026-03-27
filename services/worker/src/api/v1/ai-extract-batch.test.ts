/**
 * BETA-06: Batch AI Extraction Endpoint Tests
 *
 * POST /api/v1/ai/extract-batch
 * Accepts array of row data, returns array of extraction results.
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

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: { org_id: 'org-1' }, error: null }),
        })),
      })),
    })),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../ai/eval/calibration.js', () => ({
  calibrateConfidence: vi.fn((raw: number) => raw + 0.05), // simple offset for testing
}));

import { aiBatchExtractRouter } from './ai-extract-batch.js';
import { checkAICredits, deductAICredits } from '../../ai/cost-tracker.js';
import { calibrateConfidence } from '../../ai/eval/calibration.js';

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

describe('POST /api/v1/ai/extract-batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('allows batch extraction even with low credits (beta: unlimited)', async () => {
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

    // Beta: credit checks disabled — extraction proceeds regardless
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
    expect(calibrateConfidence).toHaveBeenCalledWith(0.85);
  });

  it('handles partial failures gracefully', async () => {
    const { createExtractionProvider } = await import('../../ai/factory.js');
    let callCount = 0;
    vi.mocked(createExtractionProvider).mockReturnValue({
      extractMetadata: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error('AI provider timeout');
        return Promise.resolve({
          fields: { credentialType: 'DEGREE' },
          confidence: 0.9,
          provider: 'mock',
          tokensUsed: 50,
        });
      }),
    } as any);

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
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error).toBeDefined();
    expect(res.body.results[2].success).toBe(true);
  });

  it('deducts correct number of credits for successful extractions', async () => {
    const app = createApp();
    await request(app)
      .post('/')
      .send({
        rows: [
          { text: 'row 1', credentialType: 'DEGREE' },
          { text: 'row 2', credentialType: 'LICENSE' },
        ],
      });

    // Should deduct credits for the full batch upfront
    expect(deductAICredits).toHaveBeenCalledWith('org-1', 'user-1', 2);
  });
});
