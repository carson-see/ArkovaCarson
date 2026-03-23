/**
 * Extraction Feedback Service Tests (P8-S6)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedbackItemSchema, FeedbackBatchSchema } from './feedback.js';

// Mock db and logger
vi.mock('../utils/db.js', () => ({
  db: {
    rpc: vi.fn(),
    from: vi.fn(() => ({
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('FeedbackItemSchema', () => {
  it('validates a valid feedback item', () => {
    const result = FeedbackItemSchema.safeParse({
      anchorId: '00000000-0000-0000-0000-000000000001',
      fingerprint: 'a'.repeat(64),
      credentialType: 'DEGREE',
      fieldKey: 'issuerName',
      originalValue: 'MIT',
      correctedValue: 'MIT',
      action: 'accepted',
      originalConfidence: 0.95,
      provider: 'gemini',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid action', () => {
    const result = FeedbackItemSchema.safeParse({
      anchorId: '00000000-0000-0000-0000-000000000001',
      fingerprint: 'a'.repeat(64),
      credentialType: 'DEGREE',
      fieldKey: 'issuerName',
      action: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID', () => {
    const result = FeedbackItemSchema.safeParse({
      anchorId: 'not-a-uuid',
      fingerprint: 'a'.repeat(64),
      credentialType: 'DEGREE',
      fieldKey: 'issuerName',
      action: 'accepted',
    });
    expect(result.success).toBe(false);
  });

  it('rejects wrong fingerprint length', () => {
    const result = FeedbackItemSchema.safeParse({
      anchorId: '00000000-0000-0000-0000-000000000001',
      fingerprint: 'short',
      credentialType: 'DEGREE',
      fieldKey: 'issuerName',
      action: 'accepted',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all three actions', () => {
    for (const action of ['accepted', 'rejected', 'edited'] as const) {
      const result = FeedbackItemSchema.safeParse({
        anchorId: '00000000-0000-0000-0000-000000000001',
        fingerprint: 'a'.repeat(64),
        credentialType: 'DEGREE',
        fieldKey: 'issuerName',
        action,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts optional fields as undefined', () => {
    const result = FeedbackItemSchema.safeParse({
      anchorId: '00000000-0000-0000-0000-000000000001',
      fingerprint: 'a'.repeat(64),
      credentialType: 'DEGREE',
      fieldKey: 'issuerName',
      action: 'rejected',
    });
    expect(result.success).toBe(true);
  });
});

describe('FeedbackBatchSchema', () => {
  it('validates a batch with items', () => {
    const result = FeedbackBatchSchema.safeParse({
      items: [
        {
          anchorId: '00000000-0000-0000-0000-000000000001',
          fingerprint: 'a'.repeat(64),
          credentialType: 'DEGREE',
          fieldKey: 'issuerName',
          action: 'accepted',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty batch', () => {
    const result = FeedbackBatchSchema.safeParse({ items: [] });
    expect(result.success).toBe(false);
  });

  it('rejects batch exceeding 50 items', () => {
    const items = Array.from({ length: 51 }, () => ({
      anchorId: '00000000-0000-0000-0000-000000000001',
      fingerprint: 'a'.repeat(64),
      credentialType: 'DEGREE',
      fieldKey: 'issuerName',
      action: 'accepted',
    }));
    const result = FeedbackBatchSchema.safeParse({ items });
    expect(result.success).toBe(false);
  });
});

describe('storeExtractionFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores feedback items and returns counts', async () => {
    const { storeExtractionFeedback } = await import('./feedback.js');
    const result = await storeExtractionFeedback('org-1', 'user-1', [
      {
        anchorId: '00000000-0000-0000-0000-000000000001',
        fingerprint: 'a'.repeat(64),
        credentialType: 'DEGREE',
        fieldKey: 'issuerName',
        action: 'accepted',
      },
    ]);

    expect(result).toEqual({ stored: 1, errors: 0 });
  });
});

describe('getExtractionAccuracy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array on RPC error', async () => {
    const { db } = await import('../utils/db.js');
    vi.mocked(db.rpc).mockResolvedValueOnce({ data: null, error: { message: 'fail' } } as never);

    const { getExtractionAccuracy } = await import('./feedback.js');
    const result = await getExtractionAccuracy();
    expect(result).toEqual([]);
  });

  it('returns mapped accuracy stats', async () => {
    const { db } = await import('../utils/db.js');
    vi.mocked(db.rpc).mockResolvedValueOnce({
      data: [
        {
          credential_type: 'DEGREE',
          field_key: 'issuerName',
          total_suggestions: '10',
          accepted_count: '8',
          rejected_count: '1',
          edited_count: '1',
          acceptance_rate: '80.00',
          avg_confidence: '0.850',
        },
      ],
      error: null,
    } as never);

    const { getExtractionAccuracy } = await import('./feedback.js');
    const result = await getExtractionAccuracy('DEGREE', 'org-1', 30);
    expect(result).toHaveLength(1);
    expect(result[0].credentialType).toBe('DEGREE');
    expect(result[0].acceptedCount).toBe(8);
    expect(result[0].acceptanceRate).toBe(80);
  });
});

describe('analyzeFeedbackForPromptImprovement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty report when no feedback exists', async () => {
    const { db } = await import('../utils/db.js');
    vi.mocked(db.rpc).mockResolvedValueOnce({ data: [], error: null } as never);

    const { analyzeFeedbackForPromptImprovement } = await import('./feedback.js');
    const report = await analyzeFeedbackForPromptImprovement(30);

    expect(report.totalFeedbackItems).toBe(0);
    expect(report.weakFields).toEqual([]);
    expect(report.overallAcceptanceRate).toBe(1);
    expect(report.analyzedAt).toBeTruthy();
  });

  it('identifies weak fields with high rejection rate', async () => {
    const { db } = await import('../utils/db.js');
    vi.mocked(db.rpc).mockResolvedValueOnce({
      data: [
        {
          credential_type: 'LICENSE',
          field_key: 'licenseNumber',
          total_suggestions: '20',
          accepted_count: '5',
          rejected_count: '12',
          edited_count: '3',
          acceptance_rate: '25.00',
          avg_confidence: '0.800',
        },
        {
          credential_type: 'DEGREE',
          field_key: 'issuerName',
          total_suggestions: '50',
          accepted_count: '48',
          rejected_count: '1',
          edited_count: '1',
          acceptance_rate: '96.00',
          avg_confidence: '0.920',
        },
      ],
      error: null,
    } as never);

    const { analyzeFeedbackForPromptImprovement } = await import('./feedback.js');
    const report = await analyzeFeedbackForPromptImprovement(30);

    expect(report.totalFeedbackItems).toBe(70);
    expect(report.weakFields).toHaveLength(1);
    expect(report.weakFields[0].credentialType).toBe('LICENSE');
    expect(report.weakFields[0].fieldKey).toBe('licenseNumber');
    expect(report.weakFields[0].rejectionRate).toBeCloseTo(0.60);
    expect(report.weakFields[0].suggestion).toContain('CRITICAL');
  });

  it('flags low overall acceptance rate', async () => {
    const { db } = await import('../utils/db.js');
    vi.mocked(db.rpc).mockResolvedValueOnce({
      data: [
        {
          credential_type: 'LICENSE',
          field_key: 'issuerName',
          total_suggestions: '10',
          accepted_count: '3',
          rejected_count: '5',
          edited_count: '2',
          acceptance_rate: '30.00',
          avg_confidence: '0.700',
        },
      ],
      error: null,
    } as never);

    const { analyzeFeedbackForPromptImprovement } = await import('./feedback.js');
    const report = await analyzeFeedbackForPromptImprovement(30);

    expect(report.overallAcceptanceRate).toBeCloseTo(0.30);
    expect(report.promptImprovementSuggestions.length).toBeGreaterThan(0);
    expect(report.promptImprovementSuggestions[0]).toContain('below 70%');
  });
});
