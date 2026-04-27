/**
 * Unit tests for Pipeline Health Monitor (SCALE-4 / SCRUM-548)
 *
 * SCRUM-1259 (R1-5) update: tests now reflect the new shape — a single
 * `.select('updated_at').eq(...).lt(...).is(...).order(...).limit(STUCK_CAP)`
 * call per status that returns `{ data: Array<{updated_at: string}> }` rather
 * than the old `{ count: N }` + separate `.single()` lookup pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockFrom, mockSendEmail, mockLogger, mockConfig } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // Build a chainable mock that resolves to the given { data, error } when
  // awaited at the end of the chain.
  function buildChain(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.lt = vi.fn(() => chain);
    chain.is = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(result));
    return chain;
  }

  const mockFrom = vi.fn(() => buildChain({ data: [], error: null }));

  return {
    mockFrom,
    mockSendEmail: vi.fn().mockResolvedValue({ success: true }),
    mockLogger,
    mockConfig: { frontendUrl: 'http://localhost:5173' },
  };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: mockFrom },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../../email/sender.js', () => ({ sendEmail: mockSendEmail }));
vi.mock('../../config.js', () => ({ config: mockConfig }));

import { checkPipelineHealth } from '../pipeline-health.js';

// Helper to build a chainable mock that returns the given result.
function chain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn(() => c);
  c.lt = vi.fn(() => c);
  c.is = vi.fn(() => c);
  c.not = vi.fn(() => c);
  c.order = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(result));
  return c;
}

describe('checkPipelineHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => chain({ data: [], error: null }));
  });

  it('returns healthy when no stuck anchors', async () => {
    const result = await checkPipelineHealth();

    expect(result.healthy).toBe(true);
    expect(result.totalStuck).toBe(0);
    expect(result.stuckGroups).toHaveLength(0);
    expect(result.alertSent).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('Pipeline health: all clear');
  });

  it('detects stuck anchors and sends alert email', async () => {
    let fromCallCount = 0;
    mockFrom.mockImplementation(() => {
      fromCallCount++;
      // First call (PENDING status) returns 5 stuck rows; the rest return [].
      if (fromCallCount === 1) {
        return chain({
          data: [
            { updated_at: '2026-04-09T10:00:00Z' },
            { updated_at: '2026-04-09T10:01:00Z' },
            { updated_at: '2026-04-09T10:02:00Z' },
            { updated_at: '2026-04-09T10:03:00Z' },
            { updated_at: '2026-04-09T10:04:00Z' },
          ],
          error: null,
        });
      }
      return chain({ data: [], error: null });
    });

    const result = await checkPipelineHealth();

    expect(result.healthy).toBe(false);
    expect(result.totalStuck).toBe(5);
    expect(result.stuckGroups).toHaveLength(1);
    expect(result.stuckGroups[0].count).toBe(5);
    expect(result.stuckGroups[0].oldestUpdatedAt).toBe('2026-04-09T10:00:00Z');
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'carson@arkova.ai',
        emailType: 'notification',
        subject: expect.stringContaining('stuck anchors detected'),
      }),
    );
    expect(result.alertSent).toBe(true);
  });

  it('handles database errors gracefully', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: null, error: { message: 'connection timeout' } }),
    );

    const result = await checkPipelineHealth();

    // Errors are logged + skipped — no stuck groups, healthy=true.
    expect(result.healthy).toBe(true);
    expect(result.totalStuck).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('sets alertSent=false when sendEmail returns success:false', async () => {
    let fromCallCount = 0;
    mockFrom.mockImplementation(() => {
      fromCallCount++;
      if (fromCallCount === 1) {
        return chain({
          data: [
            { updated_at: '2026-04-09T09:00:00Z' },
            { updated_at: '2026-04-09T09:01:00Z' },
            { updated_at: '2026-04-09T09:02:00Z' },
          ],
          error: null,
        });
      }
      return chain({ data: [], error: null });
    });

    mockSendEmail.mockResolvedValueOnce({ success: false, error: 'Resend rate limited' });

    const result = await checkPipelineHealth();

    expect(result.healthy).toBe(false);
    expect(result.alertSent).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Resend rate limited' }),
      'Pipeline health: alert email delivery failed',
    );
  });

  it('handles email send throw gracefully', async () => {
    let fromCallCount = 0;
    mockFrom.mockImplementation(() => {
      fromCallCount++;
      if (fromCallCount === 1) {
        return chain({
          data: [
            { updated_at: '2026-04-09T09:00:00Z' },
            { updated_at: '2026-04-09T09:01:00Z' },
          ],
          error: null,
        });
      }
      return chain({ data: [], error: null });
    });

    mockSendEmail.mockRejectedValueOnce(new Error('Network error'));

    const result = await checkPipelineHealth();

    expect(result.healthy).toBe(false);
    expect(result.alertSent).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Pipeline health: failed to send alert email',
    );
  });
});
