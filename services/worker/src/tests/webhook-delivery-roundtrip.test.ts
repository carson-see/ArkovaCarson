/**
 * Webhook Delivery Round-Trip Integration Test (SCRUM-1729 / SCRUM-1737).
 *
 * Verifies the full outbound webhook pipeline:
 *   dispatchWebhookEvent → endpoint lookup → schema validation →
 *   HMAC signing → HTTP delivery → idempotency → retry → circuit breaker
 *
 * Tests all three anchor lifecycle events (secured, revoked, expired)
 * plus schema enforcement through the real dispatch logic with mocked
 * DB and HTTP layers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

const {
  mockLogger,
  mockSentry,
  mockDbFrom,
  mockRpc,
  mockFetch,
  endpointsContains,
  deliveryLogSelectSingle,
  deliveryLogInsertSingle,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockSentry = { captureException: vi.fn(), captureMessage: vi.fn() };

  // Endpoint query chain: .select().eq(org_id).eq(is_active).contains(events)
  const endpointsContains = vi.fn();
  const endpointsIsActive = vi.fn(() => ({ contains: endpointsContains }));
  const endpointsEqOrg = vi.fn(() => ({ eq: endpointsIsActive }));
  const endpointsSelect = vi.fn(() => ({ eq: endpointsEqOrg }));

  // Delivery log select chain (idempotency check): .select().eq().single()
  const deliveryLogSelectSingle = vi.fn();
  const deliveryLogSelectEq = vi.fn(() => ({ single: deliveryLogSelectSingle }));
  const deliveryLogSelect = vi.fn(() => ({ eq: deliveryLogSelectEq }));

  // Delivery log insert chain: .insert().select().single()
  const deliveryLogInsertSingle = vi.fn();
  const deliveryLogInsertSelect = vi.fn(() => ({ single: deliveryLogInsertSingle }));
  const deliveryLogInsert = vi.fn(() => ({ select: deliveryLogInsertSelect }));

  // Delivery log update chain: .update().eq()
  const deliveryLogUpdateEq = vi.fn(() => Promise.resolve({ error: null }));
  const deliveryLogUpdate = vi.fn(() => ({ eq: deliveryLogUpdateEq }));

  const mockDbFrom = vi.fn((table: string) => {
    if (table === 'webhook_endpoints') {
      return { select: endpointsSelect };
    }
    if (table === 'webhook_delivery_logs') {
      return {
        select: deliveryLogSelect,
        insert: deliveryLogInsert,
        update: deliveryLogUpdate,
      };
    }
    return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
  });

  const mockRpc = vi.fn();
  const mockFetch = vi.fn();

  return {
    mockLogger,
    mockSentry,
    mockDbFrom,
    mockRpc,
    mockFetch,
    endpointsContains,
    deliveryLogSelectSingle,
    deliveryLogInsertSingle,
  };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/sentry.js', () => ({ Sentry: mockSentry }));
vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom, rpc: mockRpc },
}));

// DNS mock: resolve test hostnames to public IPs so SSRF guard doesn't block.
// The delivery module uses dynamic `await import('node:dns')` — mock both
// 'node:dns' and 'dns' to cover all resolution paths.
const dnsModule = {
  default: {},
  promises: {
    resolve4: vi.fn().mockResolvedValue(['203.0.113.10']),
    resolve6: vi.fn().mockResolvedValue([]),
  },
};
vi.mock('node:dns', () => dnsModule);
vi.mock('dns', () => dnsModule);

vi.stubGlobal('fetch', mockFetch);

// ─── Test Imports ────────────────────────────────────────────────────────────

import {
  dispatchWebhookEvent,
  signPayload,
  isCircuitOpen,
  resetCircuitBreakers,
} from '../webhooks/delivery.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ORG_ID = 'org_test_roundtrip_001';
const TEST_ENDPOINT_ID = 'ep_test_001';
const TEST_ENDPOINT_URL = 'https://203.0.113.50/webhooks/arkova';
const TEST_SECRET = crypto.randomBytes(32).toString('hex');

const MINIMAL_SECURED_PAYLOAD = {
  public_id: 'anc_minimal',
  chain_tx_id: 'abc123',
  chain_block_height: 1,
  status: 'SECURED' as const,
  chain_timestamp: '2026-05-16T00:00:00.000Z',
  secured_at: '2026-05-16T00:00:01.000Z',
  org_public_id: null,
};

function makeEndpoint(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TEST_ENDPOINT_ID,
    url: TEST_ENDPOINT_URL,
    secret_hash: TEST_SECRET,
    events: ['anchor.secured', 'anchor.revoked', 'anchor.expired'],
    is_active: true,
    org_id: TEST_ORG_ID,
    ...overrides,
  };
}

function setupStandardMocks(endpoints: ReturnType<typeof makeEndpoint>[]) {
  // Feature flag enabled
  mockRpc.mockResolvedValue({ data: true, error: null });
  // Endpoints query returns provided endpoints
  endpointsContains.mockResolvedValue({ data: endpoints, error: null });
  // Idempotency: no existing delivery log (first delivery)
  deliveryLogSelectSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
  // Insert delivery log succeeds
  deliveryLogInsertSingle.mockResolvedValue({ data: { id: 'dl_new' }, error: null });
}

function setupSuccessfulDelivery() {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => 'ok',
  });
}

function setupFailedDelivery(status = 500) {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    text: async () => 'Internal Server Error',
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Webhook Delivery Round-Trip (SCRUM-1729)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCircuitBreakers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('anchor.secured event', () => {
    const SECURED_PAYLOAD = {
      public_id: 'anc_abc123',
      chain_tx_id: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
      chain_block_height: 892401,
      status: 'SECURED' as const,
      chain_timestamp: '2026-05-16T10:30:00.000Z',
      secured_at: '2026-05-16T10:31:00.000Z',
      org_public_id: null,
    };

    it('delivers signed anchor.secured payload to subscribed endpoint', async () => {
      setupStandardMocks([makeEndpoint()]);
      setupSuccessfulDelivery();

      await dispatchWebhookEvent(
        TEST_ORG_ID,
        'anchor.secured',
        'evt_sec_001',
        SECURED_PAYLOAD,
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(TEST_ENDPOINT_URL);
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');

      // Verify HMAC signature header present
      const sig = opts.headers['X-Arkova-Signature'];
      expect(sig).toBeDefined();
      expect(sig).toMatch(/^[0-9a-f]{64}$/);

      // Verify payload structure
      const body = JSON.parse(opts.body);
      expect(body.event_type).toBe('anchor.secured');
      expect(body.event_id).toBe('evt_sec_001');
      expect(body.data.public_id).toBe('anc_abc123');
      expect(body.data.chain_tx_id).toBeDefined();
      expect(body.data.status).toBe('SECURED');
      // Banned fields must NOT be present
      expect(body.data.anchor_id).toBeUndefined();
      expect(body.data.fingerprint).toBeUndefined();
      expect(body.data.org_id).toBeUndefined();
      expect(body.data.user_id).toBeUndefined();
    });

    it('rejects payload containing banned anchor_id field', async () => {
      setupStandardMocks([makeEndpoint()]);

      await expect(
        dispatchWebhookEvent(TEST_ORG_ID, 'anchor.secured', 'evt_bad_001', {
          ...SECURED_PAYLOAD,
          anchor_id: 'leaked-internal-uuid',
        }),
      ).rejects.toThrow();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects payload containing banned fingerprint field', async () => {
      setupStandardMocks([makeEndpoint()]);

      await expect(
        dispatchWebhookEvent(TEST_ORG_ID, 'anchor.secured', 'evt_bad_002', {
          ...SECURED_PAYLOAD,
          fingerprint: 'leaked-document-hash',
        }),
      ).rejects.toThrow();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('anchor.revoked event', () => {
    const REVOKED_PAYLOAD = {
      public_id: 'anc_revoked_001',
      chain_tx_id: null,
      chain_block_height: null,
      status: 'REVOKED' as const,
      revoked_at: '2026-05-16T11:00:00.000Z',
      revocation_reason: 'credential_superseded',
      org_public_id: 'org_pub_001',
    };

    it('delivers signed anchor.revoked payload with revocation reason', async () => {
      setupStandardMocks([makeEndpoint({ events: ['anchor.revoked'] })]);
      setupSuccessfulDelivery();

      await dispatchWebhookEvent(
        TEST_ORG_ID,
        'anchor.revoked',
        'evt_rev_001',
        REVOKED_PAYLOAD,
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.event_type).toBe('anchor.revoked');
      expect(body.data.status).toBe('REVOKED');
      expect(body.data.revoked_at).toBe('2026-05-16T11:00:00.000Z');
      expect(body.data.revocation_reason).toBe('credential_superseded');
    });
  });

  describe('anchor.expired event', () => {
    const EXPIRED_PAYLOAD = {
      public_id: 'anc_expired_001',
      chain_tx_id: 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
      chain_block_height: 890000,
      status: 'EXPIRED' as const,
      expires_at: '2026-05-15T00:00:00.000Z',
      expired_at: '2026-05-16T00:01:00.000Z',
      org_public_id: null,
    };

    it('delivers signed anchor.expired payload with both timestamps', async () => {
      setupStandardMocks([makeEndpoint({ events: ['anchor.expired'] })]);
      setupSuccessfulDelivery();

      await dispatchWebhookEvent(
        TEST_ORG_ID,
        'anchor.expired',
        'evt_exp_001',
        EXPIRED_PAYLOAD,
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.event_type).toBe('anchor.expired');
      expect(body.data.status).toBe('EXPIRED');
      expect(body.data.expires_at).toBe('2026-05-15T00:00:00.000Z');
      expect(body.data.expired_at).toBe('2026-05-16T00:01:00.000Z');
      expect(body.data.chain_tx_id).toBeTruthy();
      expect(body.data.chain_block_height).toBeGreaterThan(0);
    });

    it('rejects anchor.expired with null chain_tx_id (on-chain invariant)', async () => {
      setupStandardMocks([makeEndpoint({ events: ['anchor.expired'] })]);

      await expect(
        dispatchWebhookEvent(TEST_ORG_ID, 'anchor.expired', 'evt_exp_bad', {
          ...EXPIRED_PAYLOAD,
          chain_tx_id: null,
        }),
      ).rejects.toThrow();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('feature gate', () => {
    it('does not deliver when ENABLE_OUTBOUND_WEBHOOKS is false', async () => {
      mockRpc.mockResolvedValue({ data: false, error: null });
      endpointsContains.mockResolvedValue({ data: [makeEndpoint()], error: null });
      setupSuccessfulDelivery();

      await dispatchWebhookEvent(
        TEST_ORG_ID, 'anchor.secured', 'evt_gated', MINIMAL_SECURED_PAYLOAD,
      );

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('no subscribed endpoints', () => {
    it('gracefully returns when no endpoints match', async () => {
      mockRpc.mockResolvedValue({ data: true, error: null });
      endpointsContains.mockResolvedValue({ data: [], error: null });

      await dispatchWebhookEvent(
        TEST_ORG_ID, 'anchor.secured', 'evt_no_ep', MINIMAL_SECURED_PAYLOAD,
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: TEST_ORG_ID }),
        expect.stringContaining('No webhook endpoints'),
      );
    });
  });

  describe('HMAC signature verification', () => {
    it('produces verifiable HMAC-SHA256 signature', () => {
      const secret = 'test-secret-key';
      const timestamp = '1716000000';
      const body = '{"event_type":"anchor.secured"}';
      const payload = `${timestamp}.${body}`;

      const sig = signPayload(payload, secret);

      const expected = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');
      expect(sig).toBe(expected);
      expect(sig).toHaveLength(64);
    });

    it('different secrets produce different signatures', () => {
      const payload = '1716000000.{"test":true}';
      const sig1 = signPayload(payload, 'secret-a');
      const sig2 = signPayload(payload, 'secret-b');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('multi-endpoint fan-out', () => {
    it('delivers to all subscribed endpoints for the same event', async () => {
      // Use literal IPs (TEST-NET-3) to bypass DNS resolution entirely —
      // dynamic import('node:dns') mocking is unreliable in ESM.
      const ep1 = makeEndpoint({ id: 'ep_1', url: 'https://203.0.113.1/hook' });
      const ep2 = makeEndpoint({ id: 'ep_2', url: 'https://203.0.113.2/hook' });
      setupStandardMocks([ep1, ep2]);
      setupSuccessfulDelivery();

      await dispatchWebhookEvent(
        TEST_ORG_ID, 'anchor.secured', 'evt_multi', MINIMAL_SECURED_PAYLOAD,
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const urls = mockFetch.mock.calls.map((c: unknown[]) => c[0]);
      expect(urls).toContain('https://203.0.113.1/hook');
      expect(urls).toContain('https://203.0.113.2/hook');
    });
  });

  describe('SSRF protection', () => {
    it('blocks delivery to private IP endpoints', async () => {
      setupStandardMocks([makeEndpoint({ url: 'https://192.168.1.1/hook' })]);
      await dispatchWebhookEvent(
        TEST_ORG_ID, 'anchor.secured', 'evt_ssrf', MINIMAL_SECURED_PAYLOAD,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('blocks delivery to localhost', async () => {
      setupStandardMocks([makeEndpoint({ url: 'https://localhost/hook' })]);
      await dispatchWebhookEvent(
        TEST_ORG_ID, 'anchor.secured', 'evt_localhost', MINIMAL_SECURED_PAYLOAD,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('blocks delivery to cloud metadata endpoint', async () => {
      setupStandardMocks([makeEndpoint({ url: 'https://169.254.169.254/latest/meta-data/' })]);
      await dispatchWebhookEvent(
        TEST_ORG_ID, 'anchor.secured', 'evt_meta', MINIMAL_SECURED_PAYLOAD,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('circuit breaker', () => {
    it('opens circuit after 5 consecutive failures to same endpoint', async () => {
      setupStandardMocks([makeEndpoint()]);
      setupFailedDelivery(500);

      for (let i = 0; i < 5; i++) {
        await dispatchWebhookEvent(
          TEST_ORG_ID, 'anchor.secured', `evt_cb_${i}`, MINIMAL_SECURED_PAYLOAD,
        );
      }

      expect(isCircuitOpen(TEST_ENDPOINT_ID)).toBe(true);
    });
  });
});
