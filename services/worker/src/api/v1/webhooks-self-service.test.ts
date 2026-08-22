/**
 * Tests for the browser-facing webhook self-service endpoints
 * (WH-02 signed test ping, WH-03 replay) — SCRUM-2397 / SCRUM-2398.
 *
 * These endpoints exist because `services/worker/src/api/v1/webhooks.ts`
 * (`/api/v1/webhooks/test`, `/api/v1/webhooks/deliveries/:id/replay`) is
 * gated by `apiKeyAuth` (accepts ONLY `ak_...` API keys — see
 * `services/worker/src/middleware/apiKeyAuth.ts`), so a logged-in org admin
 * using the dashboard (Supabase session JWT, never an API key) cannot call
 * them. This router mirrors the `/api/v1/keys` and `/api/v1/exports/*`
 * pattern: mounted behind the v1 router's local `requireAuth` (sets
 * `req.authUserId`), then re-derives org + ORG_ADMIN from `profiles` —
 * never trusts org/role from the client. It reuses `signPayload` and
 * `replayDelivery` from `../../webhooks/delivery.js` verbatim; no new
 * signing or replay logic is introduced.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks ───────────────────────────────────────────
vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../webhooks/delivery.js', async () => {
  const actual = await vi.importActual<typeof import('../../webhooks/delivery.js')>(
    '../../webhooks/delivery.js',
  );
  return {
    ...actual,
    isPrivateUrlResolved: vi.fn().mockResolvedValue(false),
    replayDelivery: vi.fn(),
    getDeadLetterEntries: vi.fn(),
    resolveDlqEntry: vi.fn(),
  };
});

import { webhooksSelfServiceRouter } from './webhooks-self-service.js';
import { db } from '../../utils/db.js';
import { poisonAt, isWellFormedUtf16 } from '../../tests/utf16-poison.js';
import {
  isPrivateUrlResolved,
  replayDelivery,
  getDeadLetterEntries,
  resolveDlqEntry,
} from '../../webhooks/delivery.js';

function mockQuery(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve(result);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockImplementation(terminal);
  chain.maybeSingle = vi.fn().mockImplementation(terminal);
  return chain;
}

/** Inert insert chain for tables the test doesn't care about (e.g. the
 * fire-and-forget audit_events insert) so `.insert(...)` never throws on
 * an unstaged `db.from` call. */
function inertInsertChain() {
  return { insert: vi.fn().mockResolvedValue({ error: null }) };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = (req.headers['x-test-user-id'] as string) || undefined;
    req.hmacSecret = 'test-hmac-secret';
    next();
  });
  app.use('/webhooks/self-service', webhooksSelfServiceRouter);
  return app;
}

const PROFILE_ADMIN = { org_id: 'org-1', role: 'ORG_ADMIN' };
const PROFILE_MEMBER = { org_id: 'org-1', role: 'INDIVIDUAL' };

const ENDPOINT_ROW = {
  id: 'ep-1',
  url: 'https://hooks.example.com/in',
  secret_hash: 'wh_secret_abc',
  events: ['anchor.secured'],
  is_active: true,
  org_id: 'org-1',
};

describe('webhooksSelfServiceRouter', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) — clearAllMocks only wipes call
    // history, leaving any queued mockResolvedValueOnce/mockReturnValueOnce
    // from a PRIOR test still pending and shifting the next test's results.
    vi.resetAllMocks();
    // Default fallback for any db.from() call beyond what a test explicitly
    // stages (e.g. the fire-and-forget audit_events insert on replay).
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue(inertInsertChain());
  });

  // =========================================================================
  // POST /:id/test — signed test ping
  // =========================================================================

  describe('POST /:id/test', () => {
    it('rejects unauthenticated requests', async () => {
      const app = createApp();
      const res = await request(app).post('/webhooks/self-service/ep-1/test');
      expect(res.status).toBe(401);
    });

    it('rejects when the caller has no org', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        mockQuery({ data: { org_id: null, role: 'INDIVIDUAL' } }),
      );

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/ep-1/test')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(403);
    });

    it('rejects non-admins', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_MEMBER }));

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/ep-1/test')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(403);
    });

    it('returns 404 when the endpoint does not belong to the caller org', async () => {
      (db.from as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }))
        .mockReturnValueOnce(mockQuery({ data: null }));

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/does-not-exist/test')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(404);
    });

    it('blocks a test ping to a private/internal URL (SSRF)', async () => {
      (db.from as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }))
        .mockReturnValueOnce(mockQuery({ data: ENDPOINT_ROW }));
      (isPrivateUrlResolved as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/ep-1/test')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_url');
    });

    it('sends a signed ping and reports success on 2xx', async () => {
      (db.from as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }))
        .mockReturnValueOnce(mockQuery({ data: ENDPOINT_ROW }));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue('ok'),
        }),
      );

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/ep-1/test')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status_code).toBe(200);

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const [calledUrl, init] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe(ENDPOINT_ROW.url);
      expect(init.headers['X-Arkova-Signature']).toMatch(/^[0-9a-f]{64}$/);
      expect(init.headers['X-Arkova-Event']).toBe('test.ping');

      vi.unstubAllGlobals();
    });

    // 2026-08-17 poison-record class: the endpoint controls the response body;
    // a bare `.slice(0, 500)` cutting inside a surrogate pair leaves a lone
    // high surrogate in `response_body`. Serialization escapes it rather than
    // throwing, but the string is no longer valid Unicode — it corrupts on any
    // UTF-8 hop and would poison `webhook_delivery_logs` if ever persisted.
    it('returns a well-formed response_body when the endpoint replies with poison at the 500-unit cap', async () => {
      (db.from as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }))
        .mockReturnValueOnce(mockQuery({ data: ENDPOINT_ROW }));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue(poisonAt(500)),
        }),
      );

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/ep-1/test')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(typeof res.body.response_body).toBe('string');
      expect(res.body.response_body.length).toBeLessThanOrEqual(500);
      expect(isWellFormedUtf16(res.body.response_body)).toBe(true);

      vi.unstubAllGlobals();
    });

    // WH-02 AC: the test ping must land in the delivery log like any other
    // delivery (status / response code / timestamp visible in the UI).
    it('records a webhook_delivery_logs row with success status on 2xx', async () => {
      const insertMock = vi.fn().mockResolvedValue({ error: null });
      (db.from as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }))
        .mockReturnValueOnce(mockQuery({ data: ENDPOINT_ROW }))
        .mockImplementation((table: string) =>
          table === 'webhook_delivery_logs' ? { insert: insertMock } : inertInsertChain(),
        );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue('ok'),
        }),
      );

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/ep-1/test')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(insertMock).toHaveBeenCalledTimes(1);
      const row = insertMock.mock.calls[0][0];
      expect(row.endpoint_id).toBe('ep-1');
      expect(row.event_type).toBe('test.ping');
      expect(row.status).toBe('success');
      expect(row.response_status).toBe(200);
      expect(row.attempt_number).toBe(1);
      // event_id column is uuid (SCRUM-1800) — must be a real UUID.
      expect(row.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(row.delivered_at).toBeTruthy();

      vi.unstubAllGlobals();
    });

    it('records a webhook_delivery_logs row with failed status on non-2xx', async () => {
      const insertMock = vi.fn().mockResolvedValue({ error: null });
      (db.from as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }))
        .mockReturnValueOnce(mockQuery({ data: ENDPOINT_ROW }))
        .mockImplementation((table: string) =>
          table === 'webhook_delivery_logs' ? { insert: insertMock } : inertInsertChain(),
        );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: vi.fn().mockResolvedValue('down'),
        }),
      );

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/ep-1/test')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(insertMock).toHaveBeenCalledTimes(1);
      const row = insertMock.mock.calls[0][0];
      expect(row.status).toBe('failed');
      expect(row.response_status).toBe(503);
      expect(row.delivered_at).toBeNull();

      vi.unstubAllGlobals();
    });

    it('reports failure without throwing when the endpoint returns a non-2xx', async () => {
      (db.from as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }))
        .mockReturnValueOnce(mockQuery({ data: ENDPOINT_ROW }));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: vi.fn().mockResolvedValue('down'),
        }),
      );

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/ep-1/test')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.status_code).toBe(503);

      vi.unstubAllGlobals();
    });
  });

  // =========================================================================
  // POST /deliveries/:id/replay
  // =========================================================================

  describe('POST /deliveries/:id/replay', () => {
    it('rejects unauthenticated requests', async () => {
      const app = createApp();
      const res = await request(app).post('/webhooks/self-service/deliveries/log-1/replay');
      expect(res.status).toBe(401);
    });

    it('rejects non-admins', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_MEMBER }));

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/deliveries/log-1/replay')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(403);
    });

    it('delegates to replayDelivery scoped to the caller org and returns its result', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }));
      (replayDelivery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status_code: 200,
        new_delivery_id: 'log-2',
      });

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/deliveries/log-1/replay')
        .set('x-test-user-id', 'user-1');

      expect(replayDelivery).toHaveBeenCalledWith('log-1', 'org-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        replayed: true,
        ok: true,
        delivery_id: 'log-2',
        status_code: 200,
      });
    });

    // WH-03: replaying the SAME failed delivery twice must not corrupt state —
    // each call is its own independent, safe attempt (a new delivery_logs row),
    // never a duplicate of, or a mutation on, the original row. Two calls in a
    // row therefore each succeed on their own terms and are individually
    // observable, rather than the second call erroring out or being silently
    // dropped as a "duplicate."
    it('is safe to call twice in a row — each replay is independently recorded, not a duplicate', async () => {
      // Each replay call does TWO db.from() calls: the profile/org-admin
      // lookup, then the fire-and-forget audit_events insert. Stage the
      // profile lookup for both calls; the audit insert falls through to
      // the default inertInsertChain() set in beforeEach.
      (db.from as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN })) // replay #1: profile lookup
        .mockReturnValueOnce(inertInsertChain()) // replay #1: audit insert
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN })) // replay #2: profile lookup
        .mockReturnValueOnce(inertInsertChain()); // replay #2: audit insert
      (replayDelivery as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, status_code: 200, new_delivery_id: 'log-2' })
        .mockResolvedValueOnce({ ok: true, status_code: 200, new_delivery_id: 'log-3' });

      const app = createApp();
      const first = await request(app)
        .post('/webhooks/self-service/deliveries/log-1/replay')
        .set('x-test-user-id', 'user-1');
      const second = await request(app)
        .post('/webhooks/self-service/deliveries/log-1/replay')
        .set('x-test-user-id', 'user-1');

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      // Distinct delivery-log rows — the original (log-1) is never mutated
      // or double-counted; each replay attempt is its own audit trail entry.
      expect(first.body.delivery_id).toBe('log-2');
      expect(second.body.delivery_id).toBe('log-3');
      expect(replayDelivery).toHaveBeenCalledTimes(2);
    });

    // WH-03 AC: every replay action must leave an audit trail.
    it('emits a WEBHOOK_DELIVERY_REPLAYED audit event on replay', async () => {
      const auditInsertMock = vi.fn().mockResolvedValue({ error: null });
      (db.from as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }))
        .mockImplementation((table: string) =>
          table === 'audit_events' ? { insert: auditInsertMock } : inertInsertChain(),
        );
      (replayDelivery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status_code: 200,
        new_delivery_id: 'log-2',
      });

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/deliveries/log-1/replay')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(auditInsertMock).toHaveBeenCalledTimes(1);
      const audit = auditInsertMock.mock.calls[0][0];
      expect(audit.event_type).toBe('WEBHOOK_DELIVERY_REPLAYED');
      expect(audit.event_category).toBe('ADMIN');
      expect(audit.actor_id).toBe('user-1');
      expect(audit.org_id).toBe('org-1');
      expect(audit.target_id).toBe('log-2');
      expect(JSON.parse(audit.details)).toMatchObject({ replayed_from: 'log-1', ok: true });
    });

    it('maps not_found/cross_org to 404 without leaking which one', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }));
      (replayDelivery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: 'cross_org',
      });

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/deliveries/log-1/replay')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(404);
    });

    it('maps ssrf_blocked to 403', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }));
      (replayDelivery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: 'ssrf_blocked',
      });

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/deliveries/log-1/replay')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(403);
    });

    it('maps endpoint_inactive to 409', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }));
      (replayDelivery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: 'endpoint_inactive',
      });

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/deliveries/log-1/replay')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(409);
    });
  });

  // =========================================================================
  // GET /dlq — dead-letter queue listing (metadata only, no payload)
  // =========================================================================

  describe('GET /dlq', () => {
    const DLQ_ROW = {
      id: 'dlq-1',
      endpoint_id: 'ep-1',
      endpoint_url: 'https://hooks.example.com/in',
      org_id: 'org-1',
      event_type: 'anchor.secured',
      event_id: 'evt-1',
      payload: { data: { public_id: 'ARK-1' }, secret_stuff: 'never-render-me' },
      error_message: 'HTTP 503',
      last_attempt: 5,
      failed_at: '2026-07-01T00:00:00Z',
      resolved: false,
      resolved_at: null,
      created_at: '2026-07-01T00:00:00Z',
      failure_kind: 'delivery',
    };

    it('rejects unauthenticated requests', async () => {
      const app = createApp();
      const res = await request(app).get('/webhooks/self-service/dlq');
      expect(res.status).toBe(401);
    });

    it('rejects non-admins', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_MEMBER }));

      const app = createApp();
      const res = await request(app)
        .get('/webhooks/self-service/dlq')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(403);
    });

    it('returns org-scoped DLQ entries as METADATA ONLY — payload is never included', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }));
      (getDeadLetterEntries as ReturnType<typeof vi.fn>).mockResolvedValueOnce([DLQ_ROW]);

      const app = createApp();
      const res = await request(app)
        .get('/webhooks/self-service/dlq')
        .set('x-test-user-id', 'user-1');

      expect(getDeadLetterEntries).toHaveBeenCalledWith('org-1');
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);

      const entry = res.body.entries[0];
      expect(entry).toEqual({
        id: 'dlq-1',
        endpoint_url: 'https://hooks.example.com/in',
        event_type: 'anchor.secured',
        event_id: 'evt-1',
        error_message: 'HTTP 503',
        last_attempt: 5,
        failed_at: '2026-07-01T00:00:00Z',
      });
      // The jsonb payload (may carry document metadata) must NEVER reach the
      // browser through this surface.
      expect(JSON.stringify(res.body)).not.toContain('never-render-me');
      expect(JSON.stringify(res.body)).not.toContain('payload');
      // org_id / endpoint_id internal UUIDs are also excluded (§6).
      expect(entry.org_id).toBeUndefined();
      expect(entry.endpoint_id).toBeUndefined();
    });

    it('returns an empty list when the org has no failed entries', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }));
      (getDeadLetterEntries as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const app = createApp();
      const res = await request(app)
        .get('/webhooks/self-service/dlq')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([]);
    });
  });

  // =========================================================================
  // POST /dlq/:id/resolve
  // =========================================================================

  describe('POST /dlq/:id/resolve', () => {
    it('rejects non-admins', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_MEMBER }));

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/dlq/dlq-1/resolve')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(403);
    });

    it('resolves an owned entry via resolveDlqEntry scoped to the caller org', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }));
      (resolveDlqEntry as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/dlq/dlq-1/resolve')
        .set('x-test-user-id', 'user-1');

      expect(resolveDlqEntry).toHaveBeenCalledWith('dlq-1', 'org-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ resolved: true });
    });

    it('returns 404 when the entry is cross-org or missing (resolveDlqEntry false)', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockQuery({ data: PROFILE_ADMIN }));
      (resolveDlqEntry as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      const app = createApp();
      const res = await request(app)
        .post('/webhooks/self-service/dlq/dlq-1/resolve')
        .set('x-test-user-id', 'user-1');

      expect(res.status).toBe(404);
    });
  });
});
