/**
 * Unit tests for webhook delivery engine
 *
 * HARDENING-3: signPayload, getRetryDelay, deliverToEndpoint,
 * dispatchWebhookEvent, processWebhookRetries.
 * ARK-SEC-002: isPrivateUrlResolved fail-closed semantics.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signPayload } from './delivery.js';

// ---- Hoisted mocks ----

const {
  mockLogger,
  mockDbFrom,
  mockFetch,
  mockSentry,
  // Delivery log query chains
  deliveryLogSelect,
  deliveryLogInsert,
  deliveryLogUpdate,
  // Webhook endpoints query chain
  endpointsSelect,
  // Retry logs query chain
  retryLogsSelect,
  // SCRUM-2244: dead-letter-queue upsert chain
  dlqUpsert,
  // RPC mock
  mockRpc,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // SCRUM-1805: dispatcher captures delivery_log insert failures to Sentry.
  const mockSentry = {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
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

  // PR #753 audit fix A1: the retry path uses .update().eq().select().single()
  // (PostgREST's UPDATE...RETURNING). The original existing-row .update().eq()
  // chain (no .select()) is still used elsewhere. Mock .eq() to return a real
  // Promise (so `await .eq(...)` works via inherited Promise.prototype.then)
  // with a `.select()` method attached (so `await .eq(...).select().single()`
  // works too). SonarCloud S7739 forbids hand-rolling a `then` property on a
  // plain object; using a real Promise sidesteps that — the `then` comes from
  // Promise.prototype, not from a property added to the object.
  const deliveryLogUpdateSingle = vi.fn();
  const deliveryLogUpdateEqResult: { resolved: unknown } = { resolved: { error: null } };
  type EqChain = Promise<unknown> & { select: () => { single: typeof deliveryLogUpdateSingle } };
  const deliveryLogUpdateEq = vi.fn(() => {
    const promise = Promise.resolve(deliveryLogUpdateEqResult.resolved) as EqChain;
    promise.select = () => ({ single: deliveryLogUpdateSingle });
    return promise;
  });
  // Bridge legacy tests' deliveryLogUpdate.eq.mockResolvedValue(...) onto the
  // new chain's resolved-value slot. Use Object.assign to override the
  // vitest-supplied mockResolvedValue without colliding on its strict
  // intersection-typed signature (which expects a MockInstance return).
  Object.assign(deliveryLogUpdateEq, {
    mockResolvedValue: (val: unknown) => {
      deliveryLogUpdateEqResult.resolved = val;
    },
  });
  const deliveryLogUpdate = {
    update: vi.fn(() => ({ eq: deliveryLogUpdateEq })),
    eq: deliveryLogUpdateEq,
    single: deliveryLogUpdateSingle,
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

  // SCRUM-2244: dead-letter-queue upsert chain — .from(...).upsert(row, opts)
  // returns a resolved promise so `await (db as any).from(...).upsert(...)`
  // works. The upsert (was a plain insert) dedupes on the partial unique index
  // (endpoint_id, event_type, event_id, failure_kind) with ignoreDuplicates so
  // re-DLQ of the same event (retry/re-emit during a DB outage) is a no-op and
  // does NOT create a duplicate audit row. dlqUpsert lets tests assert both the
  // durable-preservation contract and the onConflict/ignoreDuplicates options.
  const dlqUpsert = vi.fn(
    (_row?: unknown, _opts?: unknown): Promise<{ data: unknown; error: unknown }> =>
      Promise.resolve({ data: null, error: null }),
  );

  const mockRpc = vi.fn();

  const mockFetch = vi.fn();

  // Build a from() router
  const mockDbFrom = vi.fn();

  return {
    mockLogger,
    mockDbFrom,
    mockFetch,
    mockSentry,
    deliveryLogSelect,
    deliveryLogInsert,
    deliveryLogUpdate,
    endpointsSelect,
    retryLogsSelect,
    dlqUpsert,
    mockRpc,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/sentry.js', () => ({ Sentry: mockSentry }));

vi.mock('../utils/db.js', () => ({
  db: {
    from: mockDbFrom,
    rpc: mockRpc,
  },
}));

// ARK-SEC-002: isPrivateUrlResolved now fails closed when DNS resolves to
// nothing. Tests use fake public hostnames (e.g., "hooks.example.com") that
// cannot be resolved in the test sandbox, so without mocking node:dns they
// would all be blocked as "unresolvable → unsafe". Mock a benign public IP
// so the SSRF guard sees every test URL as public and lets delivery proceed.
vi.mock('node:dns', async () => {
  const actual = await vi.importActual<typeof import('node:dns')>('node:dns');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      resolve4: vi.fn(async () => ['203.0.113.10']), // TEST-NET-3, documentation block
      resolve6: vi.fn(async () => []),
    },
  };
});

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
  public_id: 'pub-001',
  status: 'SECURED' as const,
  chain_tx_id: 'tx-001',
  chain_block_height: 800000,
  chain_timestamp: '2026-04-26T12:00:00.000Z',
  secured_at: '2026-04-26T12:00:00.000Z',
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
                // Distinguish between idempotency check (select('id...')) and retry query (select('*, ...'))
                // PR #753 audit fix A1+A2: idempotency check now selects
                // 'id, status, attempt_number' so it can short-circuit on
                // 'success' but UPDATE in place on 'retrying'/'pending'.
                if (selectArg === 'id' || selectArg === 'id, status, attempt_number') {
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
      case 'webhook_dead_letter_queue':
        return {
          upsert: dlqUpsert,
        };
      default:
        return {};
    }
  });
}

// ================================================================
// signPayload — direct pure-function tests (now exported for reuse)
// ================================================================

describe('signPayload (exported HMAC helper)', () => {
  it('produces a 64-char hex digest', () => {
    const sig = signPayload('1700000000.{"event":"test"}', 'secret');
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for identical input', () => {
    expect(signPayload('x', 's')).toBe(signPayload('x', 's'));
  });

  it('changes when payload changes', () => {
    expect(signPayload('a', 's')).not.toBe(signPayload('b', 's'));
  });

  it('changes when secret changes', () => {
    expect(signPayload('x', 'a')).not.toBe(signPayload('x', 'b'));
  });
});

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

    // Use literal public IPs so the SSRF DNS resolution path is skipped
    // (delivery.ts short-circuits on literal IPs via the `[\d.]+` regex).
    // Both 198.51.100.x (TEST-NET-2) IPs are routable test documentation.
    const endpoint1 = { ...MOCK_ENDPOINT, url: 'https://198.51.100.1/cb' };
    const endpoint2 = { ...MOCK_ENDPOINT, id: 'ep-002', url: 'https://198.51.100.2/cb' };
    endpointsSelect.contains.mockResolvedValue({
      data: [endpoint1, endpoint2],
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

  it('skips delivery when idempotency check finds existing SUCCESS record', async () => {
    // PR #753 audit fix A1: only short-circuit when the prior delivery
    // succeeded. 'retrying'/'pending'/'failed' rows must re-fire so
    // processWebhookRetries actually retries (was previously a no-op).
    deliveryLogSelect.single.mockResolvedValue({
      data: { id: 'existing-log', status: 'success', attempt_number: 1 },
      error: null,
    });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: 'ep-001', eventId: 'evt-001' }),
      'Webhook already delivered',
    );
  });

  it('PR #753 audit A1: re-fires HTTP when existing row is in retrying status (retry path)', async () => {
    // Pre-fix: idempotency check returned true for ANY existing row, so
    // processWebhookRetries was a silent no-op for every retry. Post-fix:
    // existing row with status='retrying' should UPDATE in place + proceed
    // to fire fetch.
    deliveryLogSelect.single.mockResolvedValue({
      data: { id: 'existing-log', status: 'retrying', attempt_number: 1 },
      error: null,
    });
    // The retry path's .update().eq().select().single() chain — configure the
    // single() return.
    deliveryLogUpdate.single.mockResolvedValue({ data: { id: 'existing-log' }, error: null });
    // Subsequent status-update calls (from fetch result) use .update().eq()
    // directly — leave that on the legacy-style resolution.
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(deliveryLogUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('PR #753 audit A2: surfaces idempotency lookup error to Sentry instead of swallowing', async () => {
    deliveryLogSelect.single.mockResolvedValue({
      data: null,
      // Not PGRST116 (no-row) — a transient DB / RLS error
      error: { code: '08006', message: 'connection terminated' },
    });

    // dispatchWebhookEvent returns Promise<void>; the `return false` from
    // A2's audit fix lives inside deliverToEndpoint and is not surfaced to
    // callers. Observable A2 contract: no HTTP fan-out + Sentry breadcrumb.
    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'idempotency_lookup' }),
      }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: '08006' }) }),
      'Idempotency lookup failed',
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
    // SCRUM-1805: delivery_log insert failure must surface to Sentry. The
    // pre-PR-#753 22P02 UUID-coercion bug ran undetected because nobody was
    // watching for this `logger.error`. Sentry capture lets a SCRUM-1805
    // alert rule trip on the first occurrence.
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          subsystem: 'webhooks',
          stage: 'delivery_log_insert',
          event_type: 'anchor.secured',
        }),
      }),
    );
  });

  it('SCRUM-2244: preserves the event in the dead-letter queue when the delivery_log write fails persistently (audit-integrity)', async () => {
    vi.useRealTimers();

    // Idempotency lookup: no existing row (first attempt, insert path).
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    // Both the first insert AND the single transient retry fail with the same
    // persistent transient error. Pre-fix: Sentry capture + return false, and
    // the audit row is silently dropped (no durable record of the event).
    deliveryLogInsert.single
      .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: fetch failed' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: fetch failed' } });

    mockRpc.mockResolvedValue({ data: true });
    endpointsSelect.contains.mockResolvedValue({ data: [MOCK_ENDPOINT], error: null });
    dlqUpsert.mockClear();
    dlqUpsert.mockReturnValue(Promise.resolve({ data: { id: 'dlq-1' }, error: null }));
    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-audit-001', MOCK_PAYLOAD_DATA);

    // No HTTP delivery attempted — the log row never committed.
    expect(mockFetch).not.toHaveBeenCalled();

    // AUDIT-INTEGRITY CONTRACT: the event is NOT silently dropped. It is
    // durably preserved in the dead-letter queue, keyed by the same
    // idempotency_key the delivery-log row would have used, so it can be
    // reconciled/replayed later.
    expect(dlqUpsert).toHaveBeenCalledTimes(1);
    const dlqRow = dlqUpsert.mock.calls[0][0] as unknown as {
      endpoint_id: string;
      org_id: string;
      event_type: string;
      event_id: string;
      failure_kind: string;
      payload: { event_id: string; data: Record<string, unknown> };
      error_message: string;
    };
    expect(dlqRow.endpoint_id).toBe('ep-001');
    expect(dlqRow.org_id).toBe('org-001');
    expect(dlqRow.event_type).toBe('anchor.secured');
    expect(dlqRow.event_id).toBe('evt-audit-001');
    // SCRUM-2244: this path is the log-write failure, distinct from HTTP failure.
    expect(dlqRow.failure_kind).toBe('log_write');
    // The full webhook payload is preserved so the event can be replayed.
    expect(dlqRow.payload.event_id).toBe('evt-audit-001');
    // The error_message records WHY it landed in the DLQ (log-write failure,
    // not HTTP-delivery failure) and carries the idempotency key for dedupe.
    expect(dlqRow.error_message).toMatch(/delivery_log/i);
    expect(dlqRow.error_message).toContain('ep-001-anchor.secured-evt-audit-001');

    // SCRUM-2244 dedup: the write is an UPSERT with ignoreDuplicates so a
    // re-DLQ of the same event during a DB outage is a no-op (no duplicate row).
    const dlqOpts = dlqUpsert.mock.calls[0][1] as unknown as {
      onConflict?: string;
      ignoreDuplicates?: boolean;
    };
    expect(dlqOpts.onConflict).toBe('endpoint_id,event_type,event_id,failure_kind');
    expect(dlqOpts.ignoreDuplicates).toBe(true);

    // Still surfaced to Sentry for alerting (existing SCRUM-1805 behaviour).
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'delivery_log_insert' }),
      }),
    );

    vi.useFakeTimers();
  }, 10_000);

  it('SCRUM-2244: both the log-write AND the DLQ write fail (full DB outage) → event is dropped, Sentry fired (residual risk, no throw)', async () => {
    // RESIDUAL-RISK CONTRACT (honest behavior): under a full-DB outage the
    // delivery_log write fails AND the dead-letter-queue write fails too. There
    // is no durable store left to preserve the event, so it is dropped. The
    // honest, asserted behavior is: (1) no crash/throw escapes the dispatcher,
    // (2) the loss is surfaced to Sentry for alerting, (3) no HTTP delivery.
    vi.useRealTimers();

    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single
      .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: fetch failed' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: fetch failed' } });

    // The DLQ write ALSO fails (same outage). moveToDeadLetterQueue catches and
    // logs; the event is now genuinely lost — assert we don't pretend otherwise.
    dlqUpsert.mockClear();
    dlqUpsert.mockRejectedValue(new Error('DLQ unreachable: connection refused'));

    mockRpc.mockResolvedValue({ data: true });
    endpointsSelect.contains.mockResolvedValue({ data: [MOCK_ENDPOINT], error: null });
    setupDbRouting();

    // Must not throw — dispatch fans out best-effort.
    await expect(
      dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-outage-001', MOCK_PAYLOAD_DATA),
    ).resolves.toBeUndefined();

    // No HTTP delivery (log row never committed).
    expect(mockFetch).not.toHaveBeenCalled();
    // The DLQ write was attempted (and failed).
    expect(dlqUpsert).toHaveBeenCalledTimes(1);
    // The original log-write failure was surfaced to Sentry (SCRUM-1805).
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'delivery_log_insert' }),
      }),
    );
    // The DLQ-write failure (the actual data loss) is logged so an alert can
    // trip — this is the honest residual-risk signal, not a silent drop.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: 'ep-001', eventId: 'evt-outage-001' }),
      'Failed to write to dead letter queue',
    );

    vi.useFakeTimers();
  }, 10_000);

  it('SCRUM-2244: HTTP-delivery permanent failure DLQs via upsert with http_delivery discriminator + dedup options', async () => {
    // The OTHER DLQ path (permanent HTTP failure on the final attempt) must
    // also be an idempotent upsert so a re-emit/retry does not duplicate the
    // audit row. It uses failure_kind='http_delivery' so it is a distinct row
    // from any log_write failure of the same event.
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    // Final attempt (MAX_RETRIES = 5) so shouldRetry is false → permanent fail.
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('err') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });
    dlqUpsert.mockClear();
    dlqUpsert.mockReturnValue(Promise.resolve({ data: { id: 'dlq-http' }, error: null }));

    // Drive deliverToEndpoint at the terminal attempt via processWebhookRetries.
    retryLogsSelect.limit.mockResolvedValue({
      data: [
        {
          id: 'log-001',
          attempt_number: 5, // +1 → 5 = MAX_RETRIES, shouldRetry false
          payload: {
            event_type: 'anchor.secured',
            event_id: 'evt-http-001',
            timestamp: '2026-03-10T11:55:00Z',
            data: MOCK_PAYLOAD_DATA,
          },
          webhook_endpoints: MOCK_ENDPOINT,
        },
      ],
      error: null,
    });

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_delivery_logs') {
        return {
          select: (...args: string[]) => {
            if (args[0]?.includes('webhook_endpoints')) {
              return { eq: retryLogsSelect.eq };
            }
            return { eq: vi.fn(() => ({ single: deliveryLogSelect.single })) };
          },
          insert: deliveryLogInsert.insert,
          update: deliveryLogUpdate.update,
        };
      }
      if (table === 'webhook_dead_letter_queue') {
        return { upsert: dlqUpsert };
      }
      return {};
    });

    await processWebhookRetries();

    expect(dlqUpsert).toHaveBeenCalledTimes(1);
    const dlqRow = dlqUpsert.mock.calls[0][0] as unknown as { failure_kind: string; event_id: string };
    expect(dlqRow.failure_kind).toBe('http_delivery');
    expect(dlqRow.event_id).toBe('evt-http-001');
    const dlqOpts = dlqUpsert.mock.calls[0][1] as unknown as { onConflict?: string; ignoreDuplicates?: boolean };
    expect(dlqOpts.onConflict).toBe('endpoint_id,event_type,event_id,failure_kind');
    expect(dlqOpts.ignoreDuplicates).toBe(true);
  });

  it('retries delivery_log insert once on transient fetch failure', async () => {
    vi.useRealTimers();

    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single
      .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: fetch failed' } })
      .mockResolvedValueOnce({ data: { id: 'log-retry-ok' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    mockRpc.mockResolvedValue({ data: true });
    endpointsSelect.contains.mockResolvedValue({ data: [MOCK_ENDPOINT], error: null });
    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    expect(deliveryLogInsert.insert).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
  }, 10_000);

  it('recovers from duplicate-key on delivery_log insert by fetching the committed row', async () => {
    vi.useRealTimers();

    // First idempotency lookup returns no row (PGRST116)
    deliveryLogSelect.single.mockResolvedValueOnce({ data: null, error: null });
    // Insert hits unique constraint (original insert committed but response lost)
    deliveryLogInsert.single
      .mockResolvedValueOnce({ data: null, error: { message: 'duplicate key value violates unique constraint "webhook_delivery_logs_idempotency_key_key"', code: '23505' } });
    // Recovery lookup fetches the committed row
    deliveryLogSelect.single.mockResolvedValueOnce({ data: { id: 'log-dup-recovered', status: 'pending', attempt_number: 1 }, error: null });
    // Fetch succeeds
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    mockRpc.mockResolvedValue({ data: true });
    endpointsSelect.contains.mockResolvedValue({ data: [MOCK_ENDPOINT], error: null });
    setupDbRouting();

    await dispatchWebhookEvent('org-001', 'anchor.secured', 'evt-001', MOCK_PAYLOAD_DATA);

    // Insert was called once (failed with duplicate key)
    expect(deliveryLogInsert.insert).toHaveBeenCalledTimes(1);
    // Recovery lookup fetched the existing row, delivery proceeded
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
  }, 10_000);

  it('coerces non-UUID event_id to a UUID for the webhook_delivery_logs.event_id column', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    await dispatchWebhookEvent(
      'org-001',
      'anchor.secured',
      'ARK-2026-NOT-A-UUID',
      MOCK_PAYLOAD_DATA,
    );

    const insertCall = deliveryLogInsert.insert.mock.calls.at(-1) as unknown[] | undefined;
    expect(insertCall).toBeDefined();
    const insertedRow = (insertCall as unknown[])[0] as { event_id: string; payload: { event_id: string }; idempotency_key: string };
    // event_id (column) is a UUID
    expect(insertedRow.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(insertedRow.event_id).not.toBe('ARK-2026-NOT-A-UUID');
    // Payload still carries the semantically meaningful string event_id for the customer
    expect(insertedRow.payload.event_id).toBe('ARK-2026-NOT-A-UUID');
    // Idempotency key uses the supplied string so retries dedupe deterministically
    // Idempotency key now includes event_type to avoid cross-event-type
    // collisions (CodeRabbit PR #753).
    expect(insertedRow.idempotency_key).toBe('ep-001-anchor.secured-ARK-2026-NOT-A-UUID');
  });

  it('preserves UUID event_id when caller supplies one', async () => {
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-001' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

    const realUuid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
    await dispatchWebhookEvent('org-001', 'anchor.secured', realUuid, MOCK_PAYLOAD_DATA);

    const insertCall = deliveryLogInsert.insert.mock.calls.at(-1) as unknown[] | undefined;
    expect(insertCall).toBeDefined();
    const insertedRow = (insertCall as unknown[])[0] as { event_id: string };
    expect(insertedRow.event_id).toBe(realUuid);
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
        // SCRUM-1800: 'evt-001' is not a UUID, so the dispatcher mints a fresh
        // UUID for the column. The original string still appears in the JSONB
        // payload's event_id field (see UUID-coercion test above).
        event_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
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

    const insertCall = (deliveryLogInsert.insert.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>;
    const key = insertCall.idempotency_key as string;

    // Key should be endpoint_id-event_type-event_id (no attempt suffix).
    // Old format was "ep-001-evt-001-1" (with attempt). RACE-6 dropped the
    // attempt number; CodeRabbit PR #753 added event_type to avoid
    // cross-event-type idempotency collisions.
    expect(key).toBe('ep-001-anchor.secured-evt-001');
    // Confirm there is no embedded attempt number suffix
    expect(key).not.toMatch(/-1$/);
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
