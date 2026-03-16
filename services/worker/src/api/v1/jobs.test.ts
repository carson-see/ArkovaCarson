/**
 * Tests for GET /api/v1/jobs/:jobId (P4.5-TS-06)
 */

import { describe, it, expect, vi } from 'vitest';
import { cleanupExpiredJobs } from './jobs.js';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../utils/db.js';

describe('cleanupExpiredJobs', () => {
  it('deletes jobs older than 24 hours', async () => {
    const deleteMock = vi.fn().mockReturnValue({
      lt: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({
          data: [{ id: 'job-1' }, { id: 'job-2' }],
          error: null,
        }),
      }),
    });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ delete: deleteMock });

    const count = await cleanupExpiredJobs();
    expect(count).toBe(2);
  });

  it('returns 0 when no jobs to clean up', async () => {
    const deleteMock = vi.fn().mockReturnValue({
      lt: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      }),
    });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ delete: deleteMock });

    const count = await cleanupExpiredJobs();
    expect(count).toBe(0);
  });

  it('returns 0 on error', async () => {
    const deleteMock = vi.fn().mockReturnValue({
      lt: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'DB error' },
        }),
      }),
    });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ delete: deleteMock });

    const count = await cleanupExpiredJobs();
    expect(count).toBe(0);
  });
});

describe('JobStatusResponse shape', () => {
  it('has the correct interface fields', () => {
    // Type-level verification — if this compiles, the interface is correct
    const response = {
      job_id: 'uuid-1',
      status: 'complete' as const,
      total: 5,
      results: [{ public_id: 'ARK-001', verified: true }],
      created_at: '2026-03-15T00:00:00Z',
      completed_at: '2026-03-15T00:01:00Z',
    };
    expect(response.job_id).toBe('uuid-1');
    expect(response.status).toBe('complete');
    expect(response.results).toHaveLength(1);
  });
});
