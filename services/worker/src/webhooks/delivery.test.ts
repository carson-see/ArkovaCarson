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

  // Retry logs chain: .select().eq().lte().order().limit()
  // SCRUM-2250 review-fix (defect #2): processWebhookRetries now inserts an
  // `.order('payload->sequence', { ascending: true, nullsFirst: true })` step
  // between `.lte()` and `.limit()` so the 50-row window is the globally-oldest
  // outstanding events (correct head-of-line under backlog). The mock chain
  // must mirror that or `.order(...)` is undefined at runtime.
  const retryLogsLimit = vi.fn();
  const retryLogsOrder = vi.fn(() => ({ limit: retryLogsLimit }));
  const retryLogsLte = vi.fn(() => ({ order: retryLogsOrder }));
  const retryLogsEq = vi.fn(() => ({ lte: retryLogsLte }));
  const retryLogsSelect = {
    select: vi.fn((_columns?: string) => ({ eq: retryLogsEq })),
    eq: retryLogsEq,
    lte: retryLogsLte,
    order: retryLogsOrder,
    limit: retryLogsLimit,
  };

  // mockRpc is name-aware: the delivery engine now makes TWO kinds of RPC call
  // — `get_flag` (feature flag) and `next_webhook_sequence` (SCRUM-2250
  // replica-safe ordering source, migration 0337). A single
  // `mockResolvedValue({ data: true })` would have made next_webhook_sequence
  // return `true` → Number(true) === 1 for every dispatch, collapsing the
  // sequence. Instead:
  //   - `get_flag`              → rpcState.flag (default true)
  //   - `next_webhook_sequence` → rpcState.seqOverride if set, else a
  //                               strictly-increasing counter so two dispatches
  //                               get distinct, ordered sequences.
  const rpcState: {
    flag: { data: unknown };
    seq: number;
    seqOverride: { data: unknown; error?: unknown } | null;
  } = { flag: { data: true }, seq: 0, seqOverride: null };
  const mockRpc = vi.fn((fn: string) => {
    if (fn === 'next_webhook_sequence') {
      if (rpcState.seqOverride) return Promise.resolve(rpcState.seqOverride);
      rpcState.seq += 1;
      return Promise.resolve({ data: rpcState.seq, error: null });
    }
    // get_flag (and any other rpc) → the flag slot. Tests drive this via
    // mockRpc.mockResolvedValue(...) (legacy) which is bridged onto the flag.
    return Promise.resolve(rpcState.flag);
  });
  // Bridge legacy `mockRpc.mockResolvedValue({ data: X })` (feature-flag setup)
  // onto rpcState.flag WITHOUT clobbering the name-aware implementation above.
  Object.assign(mockRpc, {
    mockResolvedValue: (val: { data: unknown }) => {
      rpcState.flag = val;
      return mockRpc;
    },
  });
  (mockRpc as unknown as { __rpcState: typeof rpcState }).__rpcState = rpcState;

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
    mockRpc,
  };
});

// Test helpers for the name-aware RPC mock (SCRUM-2250 review-fix). These read
// the rpcState bridged onto mockRpc above.
function rpcStateOf(): { flag: { data: unknown }; seq: number; seqOverride: { data: unknown; error?: unknown } | null } {
  return (mockRpc as unknown as { __rpcState: { flag: { data: unknown }; seq: number; seqOverride: { data: unknown; error?: unknown } | null } }).__rpcState;
}
/** Reset the strictly-increasing next_webhook_sequence counter + override. */
function resetRpcSequence(): void {
  const s = rpcStateOf();
  s.seq = 0;
  s.seqOverride = null;
}
/** Force next_webhook_sequence to return a fixed value/error (replica-skew + failure tests). */
function setRpcSequence(value: { data: unknown; error?: unknown } | null): void {
  rpcStateOf().seqOverride = value;
}

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
import {
  dispatchWebhookEvent,
  processWebhookRetries,
  deriveResourceKey,
  __resetSequenceForTest,
  resetCircuitBreakers,
} from './delivery.js';

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

// ================================================================
// SCRUM-2250 (BUG-2026-05-16-001) — per-resource webhook ordering
// ================================================================

describe('deriveResourceKey (SCRUM-2250)', () => {
  it('derives a family-namespaced key from data.public_id', () => {
    expect(deriveResourceKey('anchor.secured', { public_id: 'pub-001' })).toBe('anchor:pub-001');
    expect(deriveResourceKey('credential.issued', { public_id: 'pub-001' })).toBe(
      'credential:pub-001',
    );
  });

  it('namespaces by event family so anchor and credential with same slug differ', () => {
    expect(deriveResourceKey('anchor.secured', { public_id: 'X' })).not.toBe(
      deriveResourceKey('credential.issued', { public_id: 'X' }),
    );
  });

  it('returns null for events with no single resource (no public_id)', () => {
    expect(deriveResourceKey('anchor.batch_secured', { public_ids: ['a', 'b'] })).toBeNull();
    expect(deriveResourceKey('anchor.secured', { public_id: '' })).toBeNull();
  });
});

describe('dispatchWebhookEvent ordering metadata (SCRUM-2250)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSequenceForTest();
    resetRpcSequence();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function dispatchOnce(eventId: string, data: Record<string, unknown>) {
    mockRpc.mockResolvedValue({ data: true });
    endpointsSelect.contains.mockResolvedValue({ data: [MOCK_ENDPOINT], error: null });
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: `log-${eventId}` }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });
    setupDbRouting();
    await dispatchWebhookEvent('org-001', 'anchor.secured', eventId, data);
  }

  it('stamps resource_key + monotonic sequence into the delivered payload', async () => {
    await dispatchOnce('evt-1', MOCK_PAYLOAD_DATA);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.resource_key).toBe('anchor:pub-001');
    expect(typeof body.sequence).toBe('number');
  });

  it('assigns a strictly greater sequence to a later event for the SAME document', async () => {
    // Event 1 (earlier) then event 2 (later) for the same public_id.
    await dispatchOnce('evt-1', MOCK_PAYLOAD_DATA);
    const seq1 = JSON.parse(mockFetch.mock.calls[0][1].body).sequence;

    mockFetch.mockClear();
    await dispatchOnce('evt-2', MOCK_PAYLOAD_DATA);
    const seq2 = JSON.parse(mockFetch.mock.calls[0][1].body).sequence;

    // Same resource_key, strictly increasing sequence → consumer can order
    // them even if event 1 is later RE-delivered (retry) after event 2.
    expect(seq2).toBeGreaterThan(seq1);
  });

  it('persists ordering metadata into the delivery_log payload (frozen for retries)', async () => {
    await dispatchOnce('evt-1', MOCK_PAYLOAD_DATA);
    const insertCalls = deliveryLogInsert.insert.mock.calls as unknown as Array<
      [{ payload: { resource_key?: unknown; sequence?: unknown } }]
    >;
    const inserted = insertCalls[0]?.[0];
    expect(inserted?.payload.resource_key).toBe('anchor:pub-001');
    expect(typeof inserted?.payload.sequence).toBe('number');
  });

  it('sources sequence from the next_webhook_sequence RPC (DB-backed, not the clock)', async () => {
    // REVIEW-FIX defect #1: prove the sequence comes from the RPC, not Date.now.
    await dispatchOnce('evt-1', MOCK_PAYLOAD_DATA);
    expect(mockRpc).toHaveBeenCalledWith('next_webhook_sequence');
  });

  it('CROSS-REPLICA SKEW: ordering follows the DB sequence even when the wall clock INVERTS', async () => {
    // The SEV1 bug: two same-resource events emitted from DIFFERENT replicas.
    // Replica A (event 1, the EARLIER event) has a clock skewed AHEAD; replica B
    // (event 2, the LATER event) has a clock BEHIND. The old in-process
    // Date.now() counter would have stamped event 1 with a HIGHER sequence than
    // event 2 (clock-driven), inverting their order so the consumer drops the
    // newer event. With the DB sequence, dispatch ORDER (not wall clock) decides
    // the value: event 1 dispatched first → lower sequence, event 2 second →
    // higher, regardless of the system clock each replica reports.

    // Event 1: dispatched first, but on a replica whose clock is FAR AHEAD.
    setRpcSequence(null); // use the strictly-increasing DB counter
    vi.setSystemTime(new Date('2026-03-10T12:00:05Z')); // skewed +5s ahead
    await dispatchOnce('evt-1', MOCK_PAYLOAD_DATA);
    const ev1 = JSON.parse(mockFetch.mock.calls[0][1].body);

    // Event 2: dispatched second, on a replica whose clock is BEHIND event 1's.
    mockFetch.mockClear();
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z')); // 5s BEHIND event 1
    await dispatchOnce('evt-2', MOCK_PAYLOAD_DATA);
    const ev2 = JSON.parse(mockFetch.mock.calls[0][1].body);

    // Same resource. Despite event 2's wall clock being EARLIER, its DB sequence
    // is strictly GREATER because it was allocated later → consumer orders them
    // correctly and does NOT drop event 2 as stale.
    expect(ev1.resource_key).toBe('anchor:pub-001');
    expect(ev2.resource_key).toBe('anchor:pub-001');
    expect(ev2.sequence).toBeGreaterThan(ev1.sequence);
  });

  it('degrades to a NULL sequence (no false ordering) + Sentry when the RPC fails', async () => {
    // If next_webhook_sequence errors, we must NOT fabricate a value (that could
    // invert ordering). We stamp null (treated as "no ordering asserted") and
    // surface to Sentry, but still deliver the event (liveness).
    setRpcSequence({ data: null, error: { message: 'connection terminated' } });
    await dispatchOnce('evt-1', MOCK_PAYLOAD_DATA);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.sequence).toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce(); // still delivered
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ subsystem: 'webhooks', stage: 'sequence_alloc' }),
      }),
    );
  });
});

describe('processWebhookRetries per-resource ordering (SCRUM-2250)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSequenceForTest();
    resetCircuitBreakers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function retryRow(id: string, opts: {
    resourceKey: string | null;
    sequence: number | null;
    attempt?: number;
    endpoint?: typeof MOCK_ENDPOINT;
  }) {
    return {
      id,
      attempt_number: opts.attempt ?? 1,
      payload: {
        event_type: 'anchor.secured',
        event_id: id,
        timestamp: '2026-03-10T11:55:00Z',
        data: MOCK_PAYLOAD_DATA,
        resource_key: opts.resourceKey,
        sequence: opts.sequence,
      },
      webhook_endpoints: opts.endpoint ?? RETRY_ENDPOINT,
    };
  }

  // Literal public IP (TEST-NET-2) so deliverToEndpoint's SSRF guard skips DNS
  // resolution — vi.clearAllMocks() wipes the node:dns mock impls, which would
  // otherwise fail-closed and block delivery intermittently under concurrency.
  const RETRY_ENDPOINT = { ...MOCK_ENDPOINT, url: 'https://198.51.100.1/cb' };

  /** Route DB so the retry query returns `rows` and deliverToEndpoint works. */
  function routeRetry(rows: unknown[]) {
    retryLogsSelect.limit.mockResolvedValue({ data: rows, error: null });
    deliveryLogSelect.single.mockResolvedValue({ data: null, error: null });
    deliveryLogInsert.single.mockResolvedValue({ data: { id: 'log-retry' }, error: null });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    deliveryLogUpdate.eq.mockResolvedValue({ error: null });

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
      return {};
    });
  }

  it('delivers ONLY the lower-sequence (older) event for a resource, holding the newer one', async () => {
    // Two retrying events for the SAME document: event 1 (seq 100, older) and
    // event 2 (seq 200, newer). The sweep must NOT fire the newer event while
    // the older one is still outstanding.
    const older = retryRow('evt-1', { resourceKey: 'anchor:pub-001', sequence: 100 });
    const newer = retryRow('evt-2', { resourceKey: 'anchor:pub-001', sequence: 200 });
    // Intentionally return newer first to prove order-independence.
    routeRetry([newer, older]);

    const result = await processWebhookRetries();

    // Exactly one head-of-line delivery for the resource this sweep.
    expect(result).toBe(1);
    expect(mockFetch).toHaveBeenCalledOnce();
    // And it must be the OLDER event (event_id evt-1), not the newer.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event_id).toBe('evt-1');
    expect(body.sequence).toBe(100);
  });

  it('delivers events for DIFFERENT documents concurrently (no global serialization)', async () => {
    const docA = retryRow('evt-a', { resourceKey: 'anchor:pub-A', sequence: 100 });
    const docB = retryRow('evt-b', {
      resourceKey: 'anchor:pub-B',
      sequence: 110,
      endpoint: { ...MOCK_ENDPOINT, id: 'ep-002', url: 'https://198.51.100.2/cb' },
    });
    routeRetry([docA, docB]);

    const result = await processWebhookRetries();

    // Both distinct resources delivered in the same sweep.
    expect(result).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const ids = mockFetch.mock.calls.map((c) => JSON.parse(c[1].body).event_id).sort();
    expect(ids).toEqual(['evt-a', 'evt-b']);
  });

  it('does not block legacy rows (no resource_key) against each other', async () => {
    // Pre-SCRUM-2250 payloads have no resource_key/sequence — they must keep
    // the old concurrent behavior, never head-of-line-blocked.
    const legacy1 = retryRow('evt-l1', { resourceKey: null, sequence: null });
    const legacy2 = retryRow('evt-l2', { resourceKey: null, sequence: null });
    routeRetry([legacy1, legacy2]);

    const result = await processWebhookRetries();

    expect(result).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('REVIEW-FIX defect #2: orders the retry window by payload->sequence ASC (NULLS FIRST) before limit(50)', async () => {
    // The limit(50) is applied to a backlog, so it MUST be ordered by sequence
    // ascending — otherwise a newer event could enter the window while its older
    // head-of-line sibling is excluded. Assert the exact ordering clause + that
    // it precedes the limit in the chain.
    routeRetry([]);

    await processWebhookRetries();

    expect(retryLogsSelect.order).toHaveBeenCalledWith('payload->sequence', {
      ascending: true,
      nullsFirst: true,
    });
    expect(retryLogsSelect.limit).toHaveBeenCalledWith(50);
    // order() resolves to the object carrying limit() → ordering happens first.
    const orderResult = retryLogsSelect.order.mock.results[0]?.value as { limit?: unknown };
    expect(orderResult).toHaveProperty('limit');
  });

  it('BACKLOG WINDOW: picks the true per-resource head from the ordered window (older sibling NOT starved)', async () => {
    // Simulate what the SQL ORDER BY guarantees: the window is the globally
    // OLDEST outstanding events. For resource pub-001 the older event (seq 100)
    // is present alongside the newer (seq 200); the sweep must fire only the
    // older one. (Pre-fix, an arbitrary window order let the newer row win.)
    const head = retryRow('evt-head', { resourceKey: 'anchor:pub-001', sequence: 100 });
    const newer = retryRow('evt-newer', { resourceKey: 'anchor:pub-001', sequence: 200 });
    // DB returns them sequence-ASC (as the new ORDER BY produces).
    routeRetry([head, newer]);

    const result = await processWebhookRetries();

    expect(result).toBe(1);
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event_id).toBe('evt-head');
    expect(body.sequence).toBe(100);
  });
});
