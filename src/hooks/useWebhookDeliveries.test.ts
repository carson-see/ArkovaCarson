/**
 * useWebhookDeliveries / useWebhookDlq hook tests (WH-03 / SCRUM-2398).
 *
 * Delivery history reads webhook_delivery_logs DIRECTLY via the Supabase
 * client — RLS policy `webhook_delivery_logs_read_org` scopes rows to the
 * caller's org endpoints AND requires is_org_admin(), so tenant isolation is
 * enforced server-side. The DLQ (webhook_dead_letter_queue) has
 * service_role-only RLS, so its listing goes through the worker
 * self-service endpoint instead. Replay + dismiss are worker calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockFrom = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

const mockWorkerFetch = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => mockWorkerFetch(...args),
}));

import { useWebhookDeliveries, useWebhookDlq, sendWebhookTestPing } from './useWebhookDeliveries';

const DELIVERY_ROW = {
  id: 'log-1',
  event_type: 'anchor.secured',
  status: 'failed',
  response_status: 503,
  attempt_number: 5,
  created_at: '2026-07-01T00:00:00Z',
  delivered_at: null,
  webhook_endpoints: { url: 'https://hooks.example.com/in' },
};

function wireSelect(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockResolvedValue(result);
  mockFrom.mockReturnValue(chain);
  return chain;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

describe('useWebhookDeliveries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches delivery logs from webhook_delivery_logs with the endpoint URL join', async () => {
    const chain = wireSelect({ data: [DELIVERY_ROW], error: null });

    const { result } = renderHook(() => useWebhookDeliveries({ enabled: true }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFrom).toHaveBeenCalledWith('webhook_delivery_logs');
    // The select must NOT pull payload / response_body — delivery metadata only.
    const selectArg = (chain.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(selectArg).not.toContain('payload');
    expect(selectArg).not.toContain('response_body');
    expect(result.current.deliveries).toHaveLength(1);
    expect(result.current.deliveries[0].endpoint_url).toBe('https://hooks.example.com/in');
    expect(result.current.deliveries[0].status).toBe('failed');
  });

  it('does not fetch when disabled', async () => {
    renderHook(() => useWebhookDeliveries({ enabled: false }));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('surfaces a load error without leaking DB internals', async () => {
    wireSelect({ data: null, error: { message: 'permission denied for table webhook_delivery_logs' } });

    const { result } = renderHook(() => useWebhookDeliveries({ enabled: true }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.error).not.toContain('permission denied');
    expect(result.current.deliveries).toEqual([]);
  });

  it('replays a delivery via the worker self-service endpoint', async () => {
    wireSelect({ data: [DELIVERY_ROW], error: null });
    mockWorkerFetch.mockResolvedValueOnce(
      jsonResponse(200, { replayed: true, ok: true, delivery_id: 'log-2', status_code: 200 }),
    );

    const { result } = renderHook(() => useWebhookDeliveries({ enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let replayResult: unknown;
    await act(async () => {
      replayResult = await result.current.replay('log-1');
    });

    expect(mockWorkerFetch).toHaveBeenCalledWith(
      '/api/v1/webhooks/self-service/deliveries/log-1/replay',
      { method: 'POST' },
    );
    expect(replayResult).toMatchObject({ ok: true, status_code: 200 });
  });

  it('replay throws a friendly error when the endpoint is disabled (409)', async () => {
    wireSelect({ data: [], error: null });
    mockWorkerFetch.mockResolvedValueOnce(
      jsonResponse(409, { error: 'endpoint_inactive' }),
    );

    const { result } = renderHook(() => useWebhookDeliveries({ enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => {
        await result.current.replay('log-1');
      }),
    ).rejects.toThrow(/disabled/i);
  });
});

describe('useWebhookDlq', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches DLQ entries from the worker self-service endpoint', async () => {
    mockWorkerFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        entries: [
          {
            id: 'dlq-1',
            endpoint_url: 'https://hooks.example.com/in',
            event_type: 'anchor.secured',
            event_id: 'evt-1',
            error_message: 'HTTP 503',
            last_attempt: 5,
            failed_at: '2026-07-01T00:00:00Z',
          },
        ],
      }),
    );

    const { result } = renderHook(() => useWebhookDlq({ enabled: true }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockWorkerFetch).toHaveBeenCalledWith('/api/v1/webhooks/self-service/dlq');
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].error_message).toBe('HTTP 503');
  });

  it('does not fetch when disabled', async () => {
    renderHook(() => useWebhookDlq({ enabled: false }));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockWorkerFetch).not.toHaveBeenCalled();
  });

  it('dismisses an entry via the resolve endpoint and refetches', async () => {
    mockWorkerFetch
      .mockResolvedValueOnce(jsonResponse(200, { entries: [{ id: 'dlq-1' }] })) // initial
      .mockResolvedValueOnce(jsonResponse(200, { resolved: true })) // resolve
      .mockResolvedValueOnce(jsonResponse(200, { entries: [] })); // refetch

    const { result } = renderHook(() => useWebhookDlq({ enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.dismiss('dlq-1');
    });

    expect(mockWorkerFetch).toHaveBeenCalledWith(
      '/api/v1/webhooks/self-service/dlq/dlq-1/resolve',
      { method: 'POST' },
    );
    await waitFor(() => expect(result.current.entries).toEqual([]));
  });
});

describe('sendWebhookTestPing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('POSTs to the self-service test endpoint and returns the result', async () => {
    mockWorkerFetch.mockResolvedValueOnce(
      jsonResponse(200, { success: true, status_code: 200, event_id: 'evt-1' }),
    );

    const result = await sendWebhookTestPing('ep-1');

    expect(mockWorkerFetch).toHaveBeenCalledWith(
      '/api/v1/webhooks/self-service/ep-1/test',
      { method: 'POST' },
    );
    expect(result).toMatchObject({ success: true, status_code: 200 });
  });

  it('throws a friendly error on a non-2xx envelope', async () => {
    mockWorkerFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'endpoint_inactive' }));

    await expect(sendWebhookTestPing('ep-1')).rejects.toThrow();
  });
});
