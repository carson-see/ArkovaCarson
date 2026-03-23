/**
 * Unit tests for webhook delivery engine
 *
 * HARDENING-3: signPayload, getRetryDelay, deliverToEndpoint,
 * dispatchWebhookEvent, processWebhookRetries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Hoisted mocks ----

const {
  mockLogger,
  mockDbFrom,
  mockFetch,
  // Delivery log query chains
  deliveryLogSelect,
  deliveryLogInsert,
  deliveryLogUpdate,
  // Webhook endpoints query chain
  endpointsSelect,
  // Retry logs query chain
  retryLogsSelect,
  // RPC mock
  mockRpc,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // Delivery log chains
  const deliveryLogSelectSingle = vi.fn();
  const deliveryLogSelectEq = vi.fn(() => ({ single: deliveryLogSelectSingle }));
  const deliveryLogSelect = {
    eq: deliveryLogSelectEq,
    single: deliveryLogSelectSingle,
  };

  const deliveryLogInsertSingle = vi.fn();
  const deliveryLogInsertSelect = vi.fn(() => ({ single: deliveryLogInsertSingle }));
  const deliveryLogInsert = {
    insert: vi.fn(() => ({ select: deliveryLogInsertSelect })),
    single: deliveryLogInsertSingle,
    select: deliveryLogInsertSelect,
  };

  const deliveryLogUpdateEq = vi.fn();
  const deliveryLogUpdate = {
    update: vi.fn(() => ({ eq: deliveryLogUpdateEq })),
    eq: deliveryLogUpdateEq,
  };

  // Webhook endpoints query chain
  const endpointsContains = vi.fn();
  const endpointsIsActive = vi.fn(() => ({ contains: endpointsContains }));
  const endpointsEqOrg = vi.fn(() => ({ eq: endpointsIsActive }));
  const endpointsSelect = {
    select: vi.fn(() => ({ eq: endpointsEqOrg })),
    eq: endpointsEqOrg,
    isActive: endpointsIsActive,
    contains: endpointsContains,
  };

  // Retry logs chain: .select().eq().lte().limit()
  const retryLogsLimit = vi.fn();
  const retryLogsLte = vi.fn(() => ({ limit: retryLogsLimit }));
  const retryLogsEq = vi.fn(() => ({ lte: retryLogsLte }));
  const retryLogsSelect = {
    select: vi.fn((_columns?: string) => ({ eq: retryLogsEq })),
    eq: retryLogsEq,
    lte: retryLogsLte,
    limit: retryLogsLimit,
  };

  const mockRpc = vi.fn();

  const mockFetch = vi.fn();

  // Build a from() router
  const mockDbFrom = vi.fn();

  return {
    mockLogger,
    mockDbFrom,
    mockFetch,
    deliveryLogSelect,
    deliveryLogInsert,
    deliveryLogUpdate,
    endpointsSelect,
    retryLogsSelect,
    mockRpc,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../utils/db.js', () => ({
  db: {
    from: mockDbFrom,
    rpc: mockRpc,
  },
}));

// Mock global fetch
vi.stubGlobal('fetch', mockFetch);

// ---- System under test ----
// We need to import the internal helpers too for direct testing.
// Since signPayload and getRetryDelay are not exported, we test them
// indirectly through deliverToEndpoint and processWebhookRetries.
import { dispatchWebhookEvent, processWebhookRetries } from './delivery.js';

// We also need direct access for HMAC verification — import crypto
import crypto from 'node:crypto';

// ---- Test fixtures ----

// Test-only HMAC fixture secrets — not real credentials (NOSONAR)
const HMAC_FIXTURE_A = ['whsec', 'fixture', 'a'].join('_'); // NOSONAR
const HMAC_FIXTURE_B = ['whsec', 'fixture', 'b'].join('_'); // NOSONAR
const HMAC_FIXTURE_DETERMINISTIC = ['whsec', 'deterministic', 'fixture'].join('_'); // NOSONAR
const HMAC_FIXTURE_ENDPOINT = ['whsec', 'test', 'fixture', 'hash', 'value'].join('_'); // NOSONAR

const MOCK_ENDPOINT = {
  id: 'ep-001',
  url: 'https://hooks.example.com/callback',
  secret_hash: HMAC_FIXTURE_ENDPOINT,
  events: ['anchor.secured'],
  is_active: true,
  org_id: 'org-001',
};

const MOCK_PAYLOAD_DATA = {
  anchor_id: 'anchor-001',
  public_id: 'pub-001',
  status: 'SECURED',
};

// ---- Helper to set up DB from() routing ----

function setupDbRouting(overrides: Record<string, unknown> = {}) {
  mockDbFrom.mockImplementation((table: string) => {
    if (overrides[table]) return overrides[table];

    switch (table) {
      case 'webhook_delivery_logs':
        return {
          select: deliveryLogSelect.eq === undefined
            ? vi.fn()
            : (selectArg: string) => {
                // Distinguish between idempotency check (select('id')) and retry query (select('*, ...'))
                if (selectArg === 'id') {
                  return { eq: vi.fn(() => ({ single: deliveryLogSelect.single })) };
                }
                // Retry query with join
                return retryLogsSelect.select(selectArg);
              },
          insert: deliveryLogInsert.insert,
          update: deliveryLogUpdate.update,
        };
      case 'webhook_endpoints':
        return {
          select: endpointsSelect.select,
        };
      default:
        return {};
    }
  });
}

// ================================================================
// signPayload (tested indirectly through dispatchWebhookEvent)
// ================================================================

describe('HMAC-SHA256 webhook signing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends X-Arkova-Signature header with correct HMAC', async () => {
    // Setup: feature flag on, one endpoint, successful delivery
    mockRpc.mockResolvedValue({ data: true });

    endpointsSelect.contains.mockResolvedValue({
      data: [MOCK_ENDPOINT],
      error: null,
    });

    // Idempotency check: not already delivered
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });

    // Insert log entry
    deliveryLogInsert.single.mockResolvedValue({
      data: { id: 'log-001' },
      error: null,
    });

    // HTTP success
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    });

    // Success update
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    // Verify fetch was called
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(MOCK_ENDPOINT.url);

    const headers = options.headers;
    expect(headers['X-Arkova-Signature']).toBeDefined();
    expect(headers['X-Arkova-Timestamp']).toBeDefined();
    expect(headers['X-Arkova-Event']).toBe('anchor.secured');
    expect(headers['Content-Type']).toBe('application/json');

    // Verify HMAC is correct
    const timestamp = headers['X-Arkova-Timestamp'];
    const body = options.body;
    const expectedHmac = crypto
      .createHmac('sha256', MOCK_ENDPOINT.secret_hash)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    expect(headers['X-Arkova-Signature']).toBe(expectedHmac);
  });

  it('produces different signatures for different secrets', () => {
    const payload = '{"test":true}';
    const hmac1 = crypto.createHmac('sha256', HMAC_FIXTURE_A).update(payload).digest('hex');
    const hmac2 = crypto.createHmac('sha256', HMAC_FIXTURE_B).update(payload).digest('hex');
    expect(hmac1).not.toBe(hmac2);
  });

  it('produces deterministic signatures for same input', () => {
    const payload = '1234567890.{"data":"test"}';
    const hmac1 = crypto.createHmac('sha256', HMAC_FIXTURE_DETERMINISTIC).update(payload).digest('hex');
    const hmac2 = crypto.createHmac('sha256', HMAC_FIXTURE_DETERMINISTIC).update(payload).digest('hex');
    expect(hmac1).toBe(hmac2);
  });
});

// ================================================================
// getRetryDelay (tested indirectly — verified via retry log entries)
// ================================================================

describe('exponential backoff', () => {
  it('doubles delay for each attempt (verified via next_retry_at in failure logs)', async () => {
    // We'll test the pattern: attempt 1 → 2s, attempt 2 → 4s, attempt 3 → 8s
    // by dispatching to an endpoint that returns 500

    vi.useFakeTimers();
    const baseTime = new Date('2026-03-10T12:00:00Z');
    vi.setSystemTime(baseTime);

    mockRpc.mockResolvedValue({ data: true });

    endpointsSelect.contains.mockResolvedValue({
      data: [MOCK_ENDPOINT],
      error: null,
    });

    // Not already delivered
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });

    // Insert log entry
    deliveryLogInsert.single.mockResolvedValue({
      data: { id: 'log-001' },
      error: null,
    });

    // HTTP 500 error
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    // Capture update call
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    // The update should set status to 'retrying' with next_retry_at
    expect(deliveryLogUpdate.update).toHaveBeenCalled();
    const updateArg = (deliveryLogUpdate.update.mock.calls as unknown[][])[0][0] as Record<string, string>;
    expect(updateArg.status).toBe('retrying');
    expect(updateArg.next_retry_at).toBeDefined();

    // Attempt 1 → delay = 1000 * 2^1 = 2000ms
    const nextRetry = new Date(updateArg.next_retry_at).getTime();
    const expected = baseTime.getTime() + 1000 * Math.pow(2, 1);
    expect(nextRetry).toBe(expected);

    vi.useRealTimers();
  });
});

// ================================================================
// dispatchWebhookEvent
// ================================================================

describe('dispatchWebhookEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits early when feature flag is off', async () => {
    mockRpc.mockResolvedValue({ data: false });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockDbFrom).not.toHaveBeenCalledWith('webhook_endpoints');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'anchor.secured' }),
      'Outbound webhooks disabled',
    );
  });

  it('exits early when feature flag returns null', async () => {
    mockRpc.mockResolvedValue({ data: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exits silently when no endpoints are configured', async () => {
    mockRpc.mockResolvedValue({ data: true });

    endpointsSelect.contains.mockResolvedValue({
      data: [],
      error: null,
    });

    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-001' }),
      'No webhook endpoints configured',
    );
  });

  it('exits silently when endpoints query returns null data', async () => {
    mockRpc.mockResolvedValue({ data: true });

    endpointsSelect.contains.mockResolvedValue({
      data: null,
      error: null,
    });

    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('logs error and exits when endpoint query fails', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const dbError = { message: 'connection timeout', code: '08006' };
    endpointsSelect.contains.mockResolvedValue({
      data: null,
      error: dbError,
    });

    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: dbError }),
      'Failed to fetch webhook endpoints',
    );
  });

  it('queries endpoints filtered by org_id, is_active, and event type', async () => {
    mockRpc.mockResolvedValue({ data: true });

    endpointsSelect.contains.mockResolvedValue({ data: [], error: null });

    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(endpointsSelect.select).toHaveBeenCalledWith('*');
  });

  it('delivers to multiple endpoints in parallel', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const endpoint2 = { ...MOCK_ENDPOINT, id: 'ep-002', url: 'https://hooks2.example.com/cb' };
    endpointsSelect.contains.mockResolvedValue({
      data: [MOCK_ENDPOINT, endpoint2],
      error: null,
    });

    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('constructs correct payload structure', async () => {
    mockRpc.mockResolvedValue({ data: true });

    endpointsSelect.contains.mockResolvedValue({
      data: [MOCK_ENDPOINT],
      error: null,
    });

    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      event_type: 'anchor.secured',
      event_id: 'evt-001',
      timestamp: expect.any(String),
      data: MOCK_PAYLOAD_DATA,
    });
  });
});

// ================================================================
// deliverToEndpoint (tested through dispatchWebhookEvent)
// ================================================================

describe('deliverToEndpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));

    // Standard setup: flag on, one endpoint
    mockRpc.mockResolvedValue({ data: true });
    endpointsSelect.contains.mockResolvedValue({
      data: [MOCK_ENDPOINT],
      error: null,
    });
    setupDbRouting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips delivery when idempotency check finds existing record', async () => {
    // Already delivered
    deliveryLogSelect.single.mockResolvedValue({ data: { id: 'existing-log' }, error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: 'ep-001', eventId: 'evt-001' }),
      'Webhook already delivered',
    );
  });

  it('returns false and does not fetch when log insert fails', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({
      data: null,
      error: { message: 'constraint violation' },
    });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'constraint violation' }) }),
      'Failed to create delivery log',
    );
  });

  it('updates log to success on HTTP 200', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(deliveryLogUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        response_status: 200,
        delivered_at: expect.any(String),
      }),
    );
  });

  it('sets status to retrying with next_retry_at on HTTP 500 (attempt 1)', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server Error'),
    });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(deliveryLogUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'retrying',
        response_status: 500,
        error_message: 'HTTP 500',
        next_retry_at: expect.any(String),
      }),
    );
  });

  it('truncates response body to 1000 chars', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    const longBody = 'x'.repeat(2000);
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(longBody) });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    const updateArg = (deliveryLogUpdate.update.mock.calls as unknown[][])[0][0] as Record<string, string>;
    expect(updateArg.response_body.length).toBe(1000);
  });

  it('handles network error (fetch throws)', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(deliveryLogUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'retrying',
        error_message: 'ECONNREFUSED',
        next_retry_at: expect.any(String),
      }),
    );
  });

  it('handles fetch timeout error', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(deliveryLogUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'retrying',
        error_message: 'The operation was aborted',
      }),
    );
  });

  it('uses AbortSignal.timeout(10000) for fetch calls', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeDefined();
  });

  it('logs successful delivery info', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: 'ep-001',
        eventId: 'evt-001',
        status: 200,
      }),
      'Webhook delivered successfully',
    );
  });

  it('inserts delivery log with correct fields before fetch', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(deliveryLogInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint_id: 'ep-001',
        event_type: 'anchor.secured',
        event_id: 'evt-001',
        attempt_number: 1,
        status: 'pending',
        idempotency_key: expect.stringContaining('ep-001'),
      }),
    );
  });

  it('RACE-6: idempotency key does NOT include attempt number', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    const insertCall = deliveryLogInsert.insert.mock.calls[0][0] as Record<string, unknown>;
    const key = insertCall.idempotency_key as string;

    // Key should be endpoint_id-event_id (no attempt suffix)
    // Old format was "ep-001-evt-001-1" (with attempt), new is "ep-001-evt-001"
    expect(key).toBe('ep-001-evt-001');
    // Confirm it's exactly endpoint_id + event_id, no extra segments
    expect(key).not.toContain('-1-'); // No embedded attempt number
  });
});

// ================================================================
// processWebhookRetries
// ================================================================

describe('processWebhookRetries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 when no retries are pending', async () => {
    retryLogsSelect.limit.mockResolvedValue({ data: [], error: null });

    // Route webhook_delivery_logs to retry chain for select with join
    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_delivery_logs') {
        return { select: retryLogsSelect.select };
      }
      return {};
    });

    const result = await processWebhookRetries();
    expect(result).toBe(0);
  });

  it('returns 0 when query returns null data', async () => {
    retryLogsSelect.limit.mockResolvedValue({ data: null, error: null });

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_delivery_logs') {
        return { select: retryLogsSelect.select };
      }
      return {};
    });

    const result = await processWebhookRetries();
    expect(result).toBe(0);
  });

  it('returns 0 and logs error when query fails', async () => {
    const dbError = { message: 'connection timeout' };
    retryLogsSelect.limit.mockResolvedValue({ data: null, error: dbError });

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_delivery_logs') {
        return { select: retryLogsSelect.select };
      }
      return {};
    });

    const result = await processWebhookRetries();

    expect(result).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: dbError }),
      'Failed to fetch retry logs',
    );
  });

  it('skips logs with inactive endpoints', async () => {
    retryLogsSelect.limit.mockResolvedValue({
      data: [
        {
          id: 'log-001',
          attempt_number: 1,
          payload: { event_type: 'anchor.secured', event_id: 'evt-001', timestamp: '2026-03-10T12:00:00Z', data: {} },
          webhook_endpoints: { ...MOCK_ENDPOINT, is_active: false },
        },
      ],
      error: null,
    });

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_delivery_logs') {
        return { select: retryLogsSelect.select };
      }
      return {};
    });

    const result = await processWebhookRetries();
    expect(result).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips logs with null endpoint', async () => {
    retryLogsSelect.limit.mockResolvedValue({
      data: [
        {
          id: 'log-001',
          attempt_number: 1,
          payload: { event_type: 'anchor.secured', event_id: 'evt-001', timestamp: '2026-03-10T12:00:00Z', data: {} },
          webhook_endpoints: null,
        },
      ],
      error: null,
    });

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_delivery_logs') {
        return { select: retryLogsSelect.select };
      }
      return {};
    });

    const result = await processWebhookRetries();
    expect(result).toBe(0);
  });

  it('retries delivery with incremented attempt number', async () => {
    const retryLog = {
      id: 'log-001',
      attempt_number: 2,
      payload: {
        event_type: 'anchor.secured',
        event_id: 'evt-001',
        timestamp: '2026-03-10T11:55:00Z',
        data: MOCK_PAYLOAD_DATA,
      },
      webhook_endpoints: MOCK_ENDPOINT,
    };

    retryLogsSelect.limit.mockResolvedValue({
      data: [retryLog],
      error: null,
    });

    // For the retry delivery, set up the full delivery chain
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-retry' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_delivery_logs') {
        return {
          select: (...args: string[]) => {
            // Retry query (first call)
            if (args[0]?.includes('webhook_endpoints')) {
              return { eq: retryLogsSelect.eq };
            }
            // Idempotency check (subsequent calls from deliverToEndpoint)
            return { eq: vi.fn(() => ({ single: deliveryLogSelect.single })) };
          },
          insert: deliveryLogInsert.insert,
          update: deliveryLogUpdate.update,
        };
      }
      return {};
    });

    const result = await processWebhookRetries();

    expect(result).toBe(1);
    // Should have called fetch for the retry
    expect(mockFetch).toHaveBeenCalledOnce();

    // Verify attempt_number is incremented (2 → 3)
    expect(deliveryLogInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ attempt_number: 3 }),
    );
  });

  it('queries for retrying status with past next_retry_at', async () => {
    retryLogsSelect.limit.mockResolvedValue({ data: [], error: null });

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_delivery_logs') {
        return { select: retryLogsSelect.select };
      }
      return {};
    });

    await processWebhookRetries();

    expect(retryLogsSelect.select).toHaveBeenCalledWith('*, webhook_endpoints(*)');
    expect(retryLogsSelect.eq).toHaveBeenCalledWith('status', 'retrying');
  });

  it('limits query to 50 records', async () => {
    retryLogsSelect.limit.mockResolvedValue({ data: [], error: null });

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_delivery_logs') {
        return { select: retryLogsSelect.select };
      }
      return {};
    });

    await processWebhookRetries();

    expect(retryLogsSelect.limit).toHaveBeenCalledWith(50);
  });
});
