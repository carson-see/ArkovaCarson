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
