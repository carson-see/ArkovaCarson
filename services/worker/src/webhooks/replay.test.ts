/**
 * Tests for replayDelivery (SCRUM-1172 / HAKI-REQ-03 AC3).
 *
 * Pure unit tests on the orchestration logic — db.from + global fetch are
 * mocked so the test stays hermetic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockDbFrom, mockLogger } = vi.hoisted(() => ({
  mockDbFrom: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

import { replayDelivery } from './delivery.js';

const ORG = 'org-a';
const DELIVERY_ID = 'log-1';
const ENDPOINT_ID = 'ep-1';
const PUBLIC_URL = 'https://hooks.example.com/in';
const SECRET = 'wh_secret_test_only';

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  event_id: string;
  payload: { event_type: string; event_id: string; timestamp: string; data: Record<string, unknown> };
  webhook_endpoints: {
    id: string;
    url: string;
    secret_hash: string;
    is_active: boolean;
    org_id: string;
  } | null;
}

function defaultRow(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: DELIVERY_ID,
    endpoint_id: ENDPOINT_ID,
    event_type: 'anchor.secured',
    event_id: 'anchor-pub-id-1',
    payload: {
      event_type: 'anchor.secured',
      event_id: 'anchor-pub-id-1',
      timestamp: '2026-04-01T00:00:00Z',
      data: { public_id: 'ARK-2026-A1' },
    },
    webhook_endpoints: {
      id: ENDPOINT_ID,
      url: PUBLIC_URL,
      secret_hash: SECRET,
      is_active: true,
      org_id: ORG,
    },
    ...overrides,
  };
}

/**
 * Builds the staged db.from mock chain replayDelivery walks through.
 *  1. select-by-delivery-id → returns `selectRow` (or null)
 *  2. insert(...).select().single() → returns `insertRow` (or null/error)
 *  3. update(...).eq() → resolved (we don't assert on it)
 */
function stageDb(opts: {
  selectRow: DeliveryRow | null;
  insertRow?: { id: string } | null;
  insertError?: { message: string } | null;
}) {
  const selectChain = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: opts.selectRow, error: null }),
      }),
    }),
  };
  const insertChain = {
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: opts.insertRow ?? (opts.insertError ? null : { id: 'log-2' }),
          error: opts.insertError ?? null,
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  };

  let firstSelectDone = false;
  mockDbFrom.mockImplementation((table: string) => {
    if (table !== 'webhook_delivery_logs') {
      return { select: vi.fn(), insert: vi.fn(), update: vi.fn(), eq: vi.fn() };
    }
    if (!firstSelectDone) {
      firstSelectDone = true;
      return selectChain;
    }
    return insertChain;
  });

  return { selectChain, insertChain };
}

describe('replayDelivery (SCRUM-1172 AC3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('OK'),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns not_found when the delivery row does not exist', async () => {
    stageDb({ selectRow: null });
    const result = await replayDelivery(DELIVERY_ID, ORG, { urlGuard: async () => false });
    expect(result).toEqual({ ok: false, error: 'not_found' });
  });

  it('returns cross_org when the endpoint belongs to a different org', async () => {
    stageDb({
      selectRow: defaultRow({
        webhook_endpoints: {
          id: ENDPOINT_ID,
          url: PUBLIC_URL,
          secret_hash: SECRET,
          is_active: true,
          org_id: 'org-b-foreign',
        },
      }),
    });
    const result = await replayDelivery(DELIVERY_ID, ORG, { urlGuard: async () => false });
    expect(result).toEqual({ ok: false, error: 'cross_org' });
  });

  it('returns endpoint_inactive when the endpoint is_active=false', async () => {
    stageDb({
      selectRow: defaultRow({
        webhook_endpoints: {
          id: ENDPOINT_ID,
          url: PUBLIC_URL,
          secret_hash: SECRET,
          is_active: false,
          org_id: ORG,
        },
      }),
    });
    const result = await replayDelivery(DELIVERY_ID, ORG, { urlGuard: async () => false });
    expect(result).toEqual({ ok: false, error: 'endpoint_inactive' });
  });

  it('blocks replay to a private/internal URL (SSRF protection)', async () => {
    stageDb({
      selectRow: defaultRow({
        webhook_endpoints: {
          id: ENDPOINT_ID,
          url: 'http://169.254.169.254/latest/meta-data/',
          secret_hash: SECRET,
          is_active: true,
          org_id: ORG,
        },
      }),
    });
    // Pin urlGuard to "private" so the test asserts the deny path even when
    // run on a network where the metadata IP isn't reachable.
    const result = await replayDelivery(DELIVERY_ID, ORG, { urlGuard: async () => true });
    expect(result.error).toBe('ssrf_blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('POSTs payload + signature to endpoint and records success on 2xx', async () => {
    stageDb({ selectRow: defaultRow(), insertRow: { id: 'log-2' } });
    const result = await replayDelivery(DELIVERY_ID, ORG, { urlGuard: async () => false });
    expect(result.ok).toBe(true);
    expect(result.status_code).toBe(200);
    expect(result.new_delivery_id).toBe('log-2');

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(PUBLIC_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Arkova-Replay-Of']).toBe(DELIVERY_ID);
    expect(init.headers['X-Arkova-Event']).toBe('anchor.secured');
    expect(init.headers['X-Arkova-Signature']).toMatch(/^[0-9a-f]{64}$/);
    // Replay must NOT include the original timestamp — the new HMAC is bound
    // to the current `X-Arkova-Timestamp`, otherwise receivers' replay-protection
    // window would reject it.
    const sentTs = Number(init.headers['X-Arkova-Timestamp']);
    expect(sentTs).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
  });

  it('records failure when the endpoint returns 5xx', async () => {
    stageDb({ selectRow: defaultRow(), insertRow: { id: 'log-2' } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue('Service Unavailable'),
      }),
    );
    const result = await replayDelivery(DELIVERY_ID, ORG, { urlGuard: async () => false });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(503);
    expect(result.new_delivery_id).toBe('log-2');
  });

  it('returns delivery_failed when fetch throws (network error)', async () => {
    stageDb({ selectRow: defaultRow(), insertRow: { id: 'log-2' } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')));
    const result = await replayDelivery(DELIVERY_ID, ORG, { urlGuard: async () => false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('delivery_failed');
    expect(result.new_delivery_id).toBe('log-2');
  });

  it('returns delivery_failed when the new delivery_log insert fails', async () => {
    stageDb({
      selectRow: defaultRow(),
      insertRow: null,
      insertError: { message: 'unique violation' },
    });
    const result = await replayDelivery(DELIVERY_ID, ORG, { urlGuard: async () => false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('delivery_failed');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
