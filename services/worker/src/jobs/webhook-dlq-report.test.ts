/**
 * Unit tests for the webhook_dlq report job (SCRUM-4514).
 *
 * This job never mutates the table — it only counts and logs. Coverage:
 * counts-by-provider + oldest age math, warn-vs-info log level by whether
 * the queue is empty, and that no log call carries reason/payload_hash/
 * external_id/webhook_id (PII/§1.6A boundary — the report job selects only
 * `provider, created_at`, so this is also a selected-columns check).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockLogger } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => ({ db: { from: mockFrom } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

import { runWebhookDlqReport } from './webhook-dlq-report.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SCRUM-4514: runWebhookDlqReport', () => {
  it('selects only provider + created_at — never reason/payload_hash/external_id/webhook_id', async () => {
    mockFrom.mockImplementation((table: string) => {
      expect(table).toBe('webhook_dlq');
      return {
        select: (cols: string) => {
          expect(cols).toBe('provider, created_at');
          return { is: () => ({ data: [], error: null }) };
        },
      };
    });
    await runWebhookDlqReport();
  });

  it('counts by provider and computes oldest_age_seconds per provider', async () => {
    const oldTs = new Date(Date.now() - 7200_000).toISOString(); // 2h old
    const newTs = new Date(Date.now() - 30_000).toISOString(); // 30s old
    mockFrom.mockReturnValue({
      select: () => ({
        is: () => ({
          data: [
            { provider: 'docusign', created_at: oldTs },
            { provider: 'docusign', created_at: newTs },
            { provider: 'adobe_sign', created_at: newTs },
          ],
          error: null,
        }),
      }),
    });

    const result = await runWebhookDlqReport();
    expect(result.total_unresolved).toBe(3);
    expect(result.by_provider.docusign.count).toBe(2);
    expect(result.by_provider.docusign.oldest_age_seconds).toBeGreaterThanOrEqual(7199);
    expect(result.by_provider.adobe_sign.count).toBe(1);
    expect(result.by_provider.adobe_sign.oldest_age_seconds).toBeLessThan(60);
  });

  it('logs at warn when the queue has unresolved rows, and the payload is bounded/PII-free', async () => {
    mockFrom.mockReturnValue({
      select: () => ({ is: () => ({ data: [{ provider: 'checkr', created_at: new Date().toISOString() }], error: null }) }),
    });
    await runWebhookDlqReport();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
    const [loggedPayload] = mockLogger.warn.mock.calls[0];
    const serialized = JSON.stringify(loggedPayload);
    expect(serialized).not.toMatch(/reason|payload_hash|external_id|webhook_id/);
  });

  it('logs at info when the queue is empty', async () => {
    mockFrom.mockReturnValue({ select: () => ({ is: () => ({ data: [], error: null }) }) });
    await runWebhookDlqReport();
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('throws (so withCronMonitoring/the route mark it a failure) on a query error, and logs it', async () => {
    mockFrom.mockReturnValue({ select: () => ({ is: () => ({ data: null, error: { message: 'db down' } }) }) });
    await expect(runWebhookDlqReport()).rejects.toThrow();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});
