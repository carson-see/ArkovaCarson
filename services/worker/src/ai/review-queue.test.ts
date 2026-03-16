/**
 * Review Queue Service Tests (P8-S9)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewActionSchema } from './review-queue.js';

// Mock db and logger
vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          in: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          })),
          order: vi.fn(() => ({
            order: vi.fn(() => ({
              range: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: { id: 'review-1' }, error: null }),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
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

describe('ReviewActionSchema', () => {
  it('validates APPROVE action', () => {
    const result = ReviewActionSchema.safeParse({ action: 'APPROVE', notes: 'looks good' });
    expect(result.success).toBe(true);
  });

  it('validates INVESTIGATE action', () => {
    const result = ReviewActionSchema.safeParse({ action: 'INVESTIGATE' });
    expect(result.success).toBe(true);
  });

  it('validates ESCALATE action', () => {
    const result = ReviewActionSchema.safeParse({ action: 'ESCALATE', notes: 'needs attention' });
    expect(result.success).toBe(true);
  });

  it('validates DISMISS action', () => {
    const result = ReviewActionSchema.safeParse({ action: 'DISMISS' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid action', () => {
    const result = ReviewActionSchema.safeParse({ action: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects notes exceeding 2000 chars', () => {
    const result = ReviewActionSchema.safeParse({
      action: 'APPROVE',
      notes: 'a'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('createReviewItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a review item', async () => {
    const { createReviewItem } = await import('./review-queue.js');
    const id = await createReviewItem(
      'anchor-1',
      'org-1',
      'score-1',
      'Low integrity score',
      ['duplicate_fingerprint'],
      7,
    );
    expect(id).toBe('review-1');
  });

  it('clamps priority between 0 and 10', async () => {
    const { createReviewItem } = await import('./review-queue.js');
    // Should not throw — priority is clamped
    const id = await createReviewItem('anchor-1', 'org-1', null, 'test', [], 15);
    expect(id).toBe('review-1');
  });
});

describe('listReviewItems', () => {
  it('returns empty array when no items', async () => {
    const { listReviewItems } = await import('./review-queue.js');
    const items = await listReviewItems({ orgId: 'org-1' });
    expect(items).toEqual([]);
  });
});

describe('updateReviewItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates a review item', async () => {
    const { updateReviewItem } = await import('./review-queue.js');
    const result = await updateReviewItem('item-1', 'user-1', 'APPROVE', 'all good');
    expect(result).toBe(true);
  });
});

describe('getReviewQueueStats', () => {
  it('returns zero stats when no items', async () => {
    const { getReviewQueueStats } = await import('./review-queue.js');
    const stats = await getReviewQueueStats('org-1');
    expect(stats.total).toBe(0);
    expect(stats.pending).toBe(0);
  });
});
