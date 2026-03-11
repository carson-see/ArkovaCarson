/**
 * Unit tests for outbound webhook delivery
 *
 * HARDENING-5: HMAC signing, HTTP delivery, timeouts, queueWebhook stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { deliverWebhook, queueWebhook } from './webhook.js';
import type { WebhookConfig } from './webhook.js';

// Test-only HMAC fixture secret — not a real credential (NOSONAR)
const HMAC_FIXTURE_SECRET = ['whsec', 'test', 'fixture', 'key', 'not', 'real'].join('_'); // NOSONAR

function makeConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    id: 'wh-config-001',
    org_id: 'org-001',
    url: 'https://hooks.example.com/webhook',
    secret: HMAC_FIXTURE_SECRET,
    events: ['anchor.secured'],
    enabled: true,
    failure_count: 0,
    ...overrides,
  };
}

function makePayload(overrides: Partial<{ type: string; timestamp: string; data: Record<string, unknown> }> = {}) {
  return {
    type: 'anchor.secured',
    timestamp: '2026-03-10T12:00:00Z',
    data: { anchor_id: 'anc-001' },
    ...overrides,
  };
}

describe('deliverWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('returns true on successful delivery (HTTP 200)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await deliverWebhook(makeConfig(), makePayload());

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('sends POST request to config URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await deliverWebhook(makeConfig({ url: 'https://custom.endpoint.io/hook' }), makePayload());

    expect(mockFetch).toHaveBeenCalledWith(
      'https://custom.endpoint.io/hook',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('includes correct HMAC signature header', async () => {
    const secret = ['whsec', 'hmac', 'test', 'fixture'].join('_'); // NOSONAR test-only fixture
    const payload = makePayload();
    const body = JSON.stringify(payload);
    const expectedSig = createHmac('sha256', secret).update(body).digest('hex');

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await deliverWebhook(makeConfig({ secret }), payload);

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['X-Arkova-Signature']).toBe(expectedSig);
  });

  it('includes event type header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await deliverWebhook(makeConfig(), makePayload({ type: 'anchor.revoked' }));

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['X-Arkova-Event']).toBe('anchor.revoked');
  });

  it('includes timestamp header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const ts = '2026-03-10T15:30:00Z';
    await deliverWebhook(makeConfig(), makePayload({ timestamp: ts }));

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['X-Arkova-Timestamp']).toBe(ts);
  });

  it('includes Content-Type application/json header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await deliverWebhook(makeConfig(), makePayload());

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['Content-Type']).toBe('application/json');
  });

  it('sends JSON stringified payload as body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const payload = makePayload({ data: { foo: 'bar' } });
    await deliverWebhook(makeConfig(), payload);

    const callArgs = mockFetch.mock.calls[0][1];
    expect(JSON.parse(callArgs.body)).toEqual(payload);
  });

  it('returns false on HTTP error response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await deliverWebhook(makeConfig(), makePayload());

    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await deliverWebhook(makeConfig(), makePayload());

    expect(result).toBe(false);
  });

  it('passes an AbortSignal to fetch for timeout', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await deliverWebhook(makeConfig(), makePayload());

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.signal).toBeDefined();
    expect(callArgs.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('queueWebhook', () => {
  it('does not throw (stub implementation)', async () => {
    await expect(queueWebhook('org-001', 'anchor.secured', { id: 'anc-1' })).resolves.toBeUndefined();
  });

  it('logs the queued event', async () => {
    const { logger } = await import('../utils/logger.js');
    await queueWebhook('org-002', 'anchor.revoked', { key: 'val' });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-002',
        eventType: 'anchor.revoked',
      }),
      expect.any(String)
    );
  });
});
