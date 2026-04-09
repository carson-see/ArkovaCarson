/**
 * Unit tests for Pipeline Health Monitor (SCALE-4 / SCRUM-548)
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

  // Build a chainable mock that supports all Supabase query methods
  function buildChain(overrides: Record<string, unknown> = {}) {
    const chain: Record<string, unknown> = {};
    const defaultReturn = { data: null, count: 0, error: null, ...overrides };
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.lt = vi.fn(() => chain);
    chain.is = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.single = vi.fn(() => Promise.resolve(defaultReturn));
    // Spread default return values so the chain itself resolves
    Object.assign(chain, defaultReturn);
    return chain;
  }

  const mockFrom = vi.fn(() => buildChain());

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

describe('checkPipelineHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns healthy when no stuck anchors', async () => {
    // All status checks return count: 0 (default mock behavior)
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
      const chain: Record<string, unknown> = {};
      // First from() call is the PENDING count check — return 5 stuck
      // Second from() call is the oldest query — return a single result
      // All other calls return 0
      if (fromCallCount === 1) {
        Object.assign(chain, { data: null, count: 5, error: null });
      } else if (fromCallCount === 2) {
        Object.assign(chain, { data: { updated_at: '2026-04-09T10:00:00Z' }, count: 0, error: null });
      } else {
        Object.assign(chain, { data: null, count: 0, error: null });
      }
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.lt = vi.fn(() => chain);
      chain.is = vi.fn(() => chain);
      chain.not = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.single = vi.fn(() => Promise.resolve(chain));
      return chain;
    });

    const result = await checkPipelineHealth();

    expect(result.healthy).toBe(false);
    expect(result.totalStuck).toBeGreaterThan(0);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'carson@arkova.ai',
        emailType: 'notification',
        subject: expect.stringContaining('stuck anchors detected'),
      })
    );
    expect(result.alertSent).toBe(true);
  });

  it('handles database errors gracefully', async () => {
    mockFrom.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, { data: null, count: null, error: { message: 'connection timeout' } });
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.lt = vi.fn(() => chain);
      chain.is = vi.fn(() => chain);
      chain.not = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.single = vi.fn(() => Promise.resolve(chain));
      return chain;
    });

    const result = await checkPipelineHealth();

    // Should still return a result, not throw
    expect(result.healthy).toBe(true); // 0 stuck because errors are skipped
    expect(result.totalStuck).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('handles email send failure gracefully', async () => {
    let fromCallCount = 0;
    mockFrom.mockImplementation(() => {
      fromCallCount++;
      const chain: Record<string, unknown> = {};
      if (fromCallCount === 1) {
        Object.assign(chain, { data: null, count: 3, error: null });
      } else if (fromCallCount === 2) {
        Object.assign(chain, { data: { updated_at: '2026-04-09T09:00:00Z' }, count: 0, error: null });
      } else {
        Object.assign(chain, { data: null, count: 0, error: null });
      }
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.lt = vi.fn(() => chain);
      chain.is = vi.fn(() => chain);
      chain.not = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.single = vi.fn(() => Promise.resolve(chain));
      return chain;
    });

    mockSendEmail.mockRejectedValueOnce(new Error('Resend API down'));

    const result = await checkPipelineHealth();

    expect(result.healthy).toBe(false);
    expect(result.alertSent).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Pipeline health: failed to send alert email'
    );
  });
});
