import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.hoisted(() => vi.fn());
const updates = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const updateErrors = vi.hoisted(() => [] as Array<unknown>);

vi.mock('./db.js', () => ({
  db: {
    rpc: mockRpc,
    from: vi.fn(() => ({
      update: vi.fn((patch: Record<string, unknown>) => {
        updates.push(patch);
        return {
          eq: vi.fn().mockResolvedValue({ data: null, error: updateErrors.shift() ?? null }),
        };
      }),
    })),
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { processNextJob, type Job } from './jobQueue.js';

function job(overrides: Partial<Job<{ envelope_id: string }>> = {}): Job<{ envelope_id: string }> {
  return {
    id: 'job-1',
    type: 'docusign.envelope_completed',
    payload: { envelope_id: 'env-1' },
    status: 'processing',
    priority: 10,
    attempts: 1,
    max_attempts: 5,
    last_error: null,
    created_at: '2026-04-24T12:00:00.000Z',
    updated_at: '2026-04-24T12:00:00.000Z',
    scheduled_for: null,
    ...overrides,
  };
}

describe('processNextJob', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    updates.length = 0;
    updateErrors.length = 0;
    vi.useRealTimers();
  });

  it('claims and completes a queued job when the handler resolves', async () => {
    mockRpc.mockResolvedValue({ data: [job()], error: null });
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await processNextJob('docusign.envelope_completed', handler);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      id: 'job-1',
      payload: { envelope_id: 'env-1' },
    }));
    expect(result).toMatchObject({ claimed: true, jobId: 'job-1', status: 'completed' });
    expect(updates[0]).toMatchObject({ status: 'completed' });
  });

  it('uses the generic queue retry/backoff path when a handler fails below max attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'));
    mockRpc.mockResolvedValue({ data: [job({ attempts: 2, max_attempts: 5 })], error: null });

    const result = await processNextJob('docusign.envelope_completed', async () => {
      throw new Error('DocuSign temporarily unavailable');
    });

    expect(result).toMatchObject({
      claimed: true,
      jobId: 'job-1',
      status: 'failed',
      attempts: 2,
    });
    expect(updates[0]).toMatchObject({
      status: 'failed',
      last_error: 'DocuSign temporarily unavailable',
      scheduled_for: '2026-04-24T12:02:00.000Z',
    });
  });

  it('uses the generic queue dead-letter path when a handler fails at max attempts', async () => {
    mockRpc.mockResolvedValue({ data: [job({ attempts: 5, max_attempts: 5 })], error: null });

    const result = await processNextJob('docusign.envelope_completed', async () => {
      throw new Error('permanent after retries');
    });

    expect(result).toMatchObject({
      claimed: true,
      jobId: 'job-1',
      status: 'dead',
      attempts: 5,
    });
    expect(updates[0]).toMatchObject({
      status: 'dead',
      last_error: 'permanent after retries',
    });
    expect(updates[0]).not.toHaveProperty('scheduled_for');
  });

  it('returns update_failed when marking a successful job completed fails', async () => {
    mockRpc.mockResolvedValue({ data: [job()], error: null });
    updateErrors.push({ message: 'database unavailable' });

    const result = await processNextJob('docusign.envelope_completed', vi.fn().mockResolvedValue(undefined));

    expect(result).toMatchObject({
      claimed: true,
      jobId: 'job-1',
      status: 'update_failed',
      attempts: 1,
      error: 'job_complete_update_failed:job-1',
    });
    expect(updates[0]).toMatchObject({ status: 'completed' });
  });

  it('returns update_failed when persisting a failed job status fails', async () => {
    mockRpc.mockResolvedValue({ data: [job({ attempts: 2, max_attempts: 5 })], error: null });
    updateErrors.push({ message: 'database unavailable' });

    const result = await processNextJob('docusign.envelope_completed', async () => {
      throw new Error('DocuSign temporarily unavailable');
    });

    expect(result).toMatchObject({
      claimed: true,
      jobId: 'job-1',
      status: 'update_failed',
      attempts: 2,
      error: 'job_fail_update_failed:job-1',
    });
    expect(updates[0]).toMatchObject({ status: 'failed' });
  });
});
