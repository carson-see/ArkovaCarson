/**
 * ComputeID AgentPassport revocation webhook — receiver tests.
 *
 * Signing contract (verified live 2026-09-07 against api.aicomputeid.com):
 * `X-ComputeID-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`. No
 * timestamp header, no event id — replay safety comes from the ordering guard
 * on the SIGNED payload timestamp (see integrations/computeid/binding.ts).
 * The golden test below replays the real delivery captured that day.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbFromMock = vi.fn();
const logCalls = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const auditMock = vi.fn();
const mockConfig = vi.hoisted(() => ({
  enableComputeidIntegration: true,
  computeidWebhookSecret: 'computeid-fixture-secret-aaaa' as string | undefined,
}));
vi.mock('../../../config.js', () => ({ config: mockConfig }));

vi.mock('../../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args) } }));
vi.mock('../../../utils/logger.js', () => ({ logger: logCalls }));
vi.mock('../../../utils/auditEvent.js', () => ({
  recordAuditEvent: (...args: unknown[]) => { auditMock(...args); return Promise.resolve(); },
}));

import { computeidWebhookRouter } from './computeid.js';

const TEST_SECRET = 'computeid-fixture-secret-aaaa';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const PASSPORT = '0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f';
const T1 = '2026-09-07T10:00:00.000Z';
const T2 = '2026-09-07T11:00:00.000Z';
const T3 = '2026-09-07T12:00:00.000Z';
const SENSITIVE = 'SENSITIVE-REASON-XYZ john.doe@example.com';

type Result = { data?: unknown; error?: unknown };
/** Thenable query-builder stub: every builder method returns the builder; `await` yields the next queued result. */
function builder(results: Result | Result[], opts: { updateResult?: Result; deleteResult?: Result } = {}) {
  const queue = Array.isArray(results) ? [...results] : [results];
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['select', 'eq', 'neq', 'is', 'contains', 'insert', 'in', 'limit', 'order', 'maybeSingle', 'single']) {
    b[m] = vi.fn(self);
  }
  b.update = vi.fn(() => (opts.updateResult ? builder(opts.updateResult) : b));
  b.delete = vi.fn(() => (opts.deleteResult ? builder(opts.deleteResult) : b));
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
    const r = queue.length > 1 ? (queue.shift() as Result) : queue[0];
    return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null }).then(onF, onR);
  };
  return b as Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
}
function routeTables(map: Record<string, unknown>) {
  dbFromMock.mockImplementation((table: string) => {
    const t = map[table];
    if (!t) throw new Error(`unexpected table: ${table}`);
    return t;
  });
}

function createApp(withRawParser = true) {
  const app = express();
  if (withRawParser) {
    app.use(
      '/webhooks/computeid',
      express.raw({ type: 'application/json', limit: '2mb' }),
      (req, _res, next) => {
        (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
        next();
      },
      computeidWebhookRouter,
    );
  } else {
    app.use('/webhooks/computeid', express.json(), computeidWebhookRouter);
  }
  return app;
}
function sign(body: string | Buffer, secret = TEST_SECRET): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}
function post(body: string, sig?: string, app = createApp()) {
  return request(app)
    .post('/webhooks/computeid')
    .set('Content-Type', 'application/json')
    .set('X-ComputeID-Signature', sig ?? sign(body))
    .send(body);
}
const evt = (event: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ event, passport_id: PASSPORT, reason: SENSITIVE, timestamp: T2, ...over });
const agentRow = (over: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  org_id: ORG_ID,
  name: 'cortex-agent-1',
  status: 'active',
  metadata: { computeid: { issuer: 'computeid', passport_id: PASSPORT, bound_at: T1, receipt_expires_at: T3 } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbFromMock.mockReset();
  mockConfig.enableComputeidIntegration = true;
  mockConfig.computeidWebhookSecret = TEST_SECRET;
});

describe('POST /webhooks/computeid — gating + signature', () => {
  it('503 vendor_gated when config.enableComputeidIntegration is false (no DB, no signature check)', async () => {
    mockConfig.enableComputeidIntegration = false;
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('vendor_gated');
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('503 webhook_unconfigured when the secret is missing', async () => {
    mockConfig.computeidWebhookSecret = undefined;
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('webhook_unconfigured');
  });

  it('401 on missing header, wrong secret, tampered body, or missing sha256= prefix — before any DB call', async () => {
    const body = evt('passport.revoked');
    const noHeader = await request(createApp()).post('/webhooks/computeid').set('Content-Type', 'application/json').send(body);
    expect(noHeader.status).toBe(401);
    expect((await post(body, sign(body, 'wrong'))).status).toBe(401);
    expect((await post(body + ' ', sign(body))).status).toBe(401);
    expect((await post(body, sign(body).slice('sha256='.length))).status).toBe(401);
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('GOLDEN: verifies the real delivery captured from api.aicomputeid.com on 2026-09-07 byte-for-byte', async () => {
    const fx = JSON.parse(
      readFileSync(new URL('../../../integrations/computeid/__fixtures__/golden-test-delivery.json', import.meta.url), 'utf8'),
    ) as { secret: string; header_value: string; body: string };
    mockConfig.computeidWebhookSecret = fx.secret;
    const res = await post(fx.body, fx.header_value);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true, event: 'test' });
    expect(dbFromMock).not.toHaveBeenCalled();
    // Sanity: our own signer reproduces ComputeID's header exactly.
    expect(sign(fx.body, fx.secret)).toBe(fx.header_value);
  });

  it('supports secret rotation: a comma-separated list accepts any listed secret, rejects others', async () => {
    mockConfig.computeidWebhookSecret = 'old-secret, new-secret';
    const body = JSON.stringify({ event: 'test', timestamp: T2 });
    expect((await post(body, sign(body, 'old-secret'))).status).toBe(200);
    expect((await post(body, sign(body, 'new-secret'))).status).toBe(200);
    expect((await post(body, sign(body, 'other'))).status).toBe(401);
  });

  it('500 misconfigured_raw_body when mounted without the raw parser', async () => {
    const body = evt('passport.revoked');
    const res = await post(body, sign(body), createApp(false));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('misconfigured_raw_body');
  });

  it('413 for bodies over the 64 KiB cap, before signature verification', async () => {
    const body = JSON.stringify({ event: 'test', timestamp: T2, pad: 'x'.repeat(70 * 1024) });
    const res = await post(body, sign(body));
    expect(res.status).toBe(413);
  });
});

describe('POST /webhooks/computeid — body validation', () => {
  it('400 invalid_body for non-JSON, with a DLQ record', async () => {
    const dlq = builder({});
    routeTables({ webhook_dlq: dlq });
    const res = await post('not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
    expect(dlq.insert).toHaveBeenCalledWith(expect.objectContaining({ provider: 'computeid', reason: expect.stringContaining('invalid_body') }));
  });

  it('200 ignored for unknown / future event types (acked so the sender does not retry)', async () => {
    const res = await post(JSON.stringify({ event: 'passport.renamed', timestamp: T2, passport_id: PASSPORT }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true });
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('400 when a passport event lacks a UUID passport_id, with a DLQ record naming the shape failure', async () => {
    const dlq = builder({});
    routeTables({ webhook_dlq: dlq });
    const res = await post(JSON.stringify({ event: 'passport.revoked', timestamp: T2 }));
    expect(res.status).toBe(400);
    expect(dlq.insert).toHaveBeenCalledWith(expect.objectContaining({ provider: 'computeid', reason: expect.stringContaining('shape') }));
  });
});

describe('POST /webhooks/computeid — passport events', () => {
  it('passport.revoked: revokes every bound agent, deactivates its keys, records a SECURITY audit event', async () => {
    const agents = builder({ data: [agentRow()] });
    const keys = builder({});
    const dlq = builder({});
    routeTables({ agents, api_keys: keys, webhook_dlq: dlq });

    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, event: 'passport.revoked', applied: 1, skipped: 0 });

    expect(agents.contains).toHaveBeenCalledWith('metadata', { computeid: { passport_id: PASSPORT } });
    expect(agents.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked', revoked_at: T2 }));
    expect(agents.eq).toHaveBeenCalledWith('id', AGENT_ID);
    expect(keys.update).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: false, revocation_reason: 'computeid:passport.revoked' }),
    );
    expect(keys.eq).toHaveBeenCalledWith('agent_id', AGENT_ID);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'AGENT_PASSPORT_REVOKED',
        event_category: 'SECURITY',
        target_type: 'agent',
        target_id: AGENT_ID,
        org_id: ORG_ID,
      }),
    );
    expect(dlq.insert).not.toHaveBeenCalled();
  });

  it('passport.suspended: suspends without touching keys; passport.reinstated on a suspended agent re-activates', async () => {
    const agents = builder({ data: [agentRow()] });
    const keys = builder({});
    routeTables({ agents, api_keys: keys, webhook_dlq: builder({}) });
    const s = await post(evt('passport.suspended'));
    expect(s.status).toBe(200);
    expect(agents.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'suspended', suspended_at: T2 }));
    expect(keys.update).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'AGENT_PASSPORT_SUSPENDED' }));

    vi.clearAllMocks();
    const agents2 = builder({ data: [agentRow({ status: 'suspended' })] });
    routeTables({ agents: agents2, api_keys: keys, webhook_dlq: builder({}) });
    const r = await post(evt('passport.reinstated', { timestamp: T3 }));
    expect(r.status).toBe(200);
    expect(agents2.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', suspended_at: null }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'AGENT_PASSPORT_REINSTATED' }));
  });

  it('revoked is terminal: passport.reinstated on a revoked agent is skipped with no write', async () => {
    const agents = builder({ data: [agentRow({ status: 'revoked' })] });
    routeTables({ agents, api_keys: builder({}), webhook_dlq: builder({}) });
    const res = await post(evt('passport.reinstated', { timestamp: T3 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: 0, skipped: 1 });
    expect(agents.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('ordering guard: an event at or before the last applied timestamp is a no-op (replay-safe)', async () => {
    const row = agentRow({ status: 'suspended' });
    (row.metadata as { computeid: Record<string, unknown> }).computeid.last_event_at = T2;
    const agents = builder({ data: [row] });
    routeTables({ agents, api_keys: builder({}), webhook_dlq: builder({}) });
    const res = await post(evt('passport.reinstated', { timestamp: T2 }));
    expect(res.body).toMatchObject({ applied: 0, skipped: 1 });
    expect(agents.update).not.toHaveBeenCalled();
  });

  it('unbound passport: 200 orphaned:true and a DLQ record so the miss is visible', async () => {
    const dlq = builder({});
    routeTables({ agents: builder({ data: [] }), webhook_dlq: dlq });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orphaned: true });
    expect(dlq.insert).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'computeid', reason: 'unbound_passport', external_id: PASSPORT }),
    );
  });

  it('agent update failure: 500 + DLQ so the sender can retry', async () => {
    const agents = builder({ data: [agentRow()] }, { updateResult: { error: { code: 'XX000', message: 'boom' } } });
    const dlq = builder({});
    routeTables({ agents, api_keys: builder({}), webhook_dlq: dlq });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('webhook_processing_failed');
    expect(dlq.insert).toHaveBeenCalledWith(expect.objectContaining({ provider: 'computeid', reason: expect.stringContaining('agent_update_failed') }));
  });

  it('never leaks the partner-supplied free-text reason or the raw body into logs, audit details, or the DLQ', async () => {
    const agents = builder({ data: [agentRow()] });
    const dlq = builder({});
    routeTables({ agents, api_keys: builder({}), webhook_dlq: dlq });
    await post(evt('passport.revoked'));
    const serializedLogs = JSON.stringify([logCalls.info.mock.calls, logCalls.warn.mock.calls, logCalls.error.mock.calls, logCalls.debug.mock.calls]);
    expect(serializedLogs).not.toContain('SENSITIVE-REASON');
    expect(serializedLogs).not.toContain('john.doe@example.com');
    const auditDetails = JSON.stringify(auditMock.mock.calls);
    expect(auditDetails).not.toContain('SENSITIVE-REASON');
    expect(auditDetails).not.toContain('john.doe@example.com');
    expect(JSON.stringify(dlq.insert.mock.calls)).not.toContain('SENSITIVE-REASON');
  });
});
