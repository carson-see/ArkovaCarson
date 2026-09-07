/**
 * ComputeID AgentPassport revocation webhook — receiver tests.
 *
 * Signing contract (verified live 2026-09-07 against api.aicomputeid.com):
 * `X-ComputeID-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`. No
 * timestamp header, no event id — replay safety comes from the ordering floor
 * on the SIGNED payload timestamp (see integrations/computeid/binding.ts).
 * The golden test replays the real delivery captured that day, content type
 * included.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../../test-utils/chainable-builder.js';

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
const ORG_B = '99999999-9999-4999-8999-999999999999';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_B = '55555555-5555-4555-8555-555555555555';
const PASSPORT = '0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f';
const T0 = '2026-09-07T09:00:00.000Z';
const T1 = '2026-09-07T10:00:00.000Z';
const T2 = '2026-09-07T11:00:00.000Z';
const T3 = '2026-09-07T12:00:00.000Z';
const SENSITIVE = 'SENSITIVE-REASON-XYZ john.doe@example.com';
const LAST_EVENT_AT_COL = 'metadata->computeid->>last_event_at';

const routeTables = (map: Record<string, unknown>) => routeDbTables(dbFromMock, map);

function createApp(withRawParser = true) {
  const app = express();
  if (withRawParser) {
    app.use(
      '/webhooks/computeid',
      express.raw({ type: () => true, limit: '2mb' }),
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
function post(body: string, sig?: string, app = createApp(), contentType = 'application/json') {
  return request(app)
    .post('/webhooks/computeid')
    .set('Content-Type', contentType)
    .set('X-ComputeID-Signature', sig ?? sign(body))
    .send(body);
}
const evt = (event: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ event, passport_id: PASSPORT, reason: SENSITIVE, timestamp: T2, ...over });
const binding = (extra: Record<string, unknown> = {}) => ({
  computeid: { issuer: 'computeid', passport_id: PASSPORT, bound_at: T1, receipt_issued_at: T1, receipt_expires_at: T3, ...extra },
});
const agentRow = (over: Record<string, unknown> = {}) => ({
  id: AGENT_ID, org_id: ORG_ID, name: 'cortex-agent-1', status: 'active', metadata: binding(), ...over,
});
/** Lookup returns the row; every subsequent await (the CAS update) reports one affected row. */
const agentsWithCas = (rows: unknown[], casRows: unknown[] = [{ id: AGENT_ID }]) => builder([{ data: rows }, { data: casRows }]);

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

  it('503 webhook_unconfigured when the secret is missing or is only separators', async () => {
    mockConfig.computeidWebhookSecret = undefined;
    expect((await post(evt('passport.revoked'))).body.error.code).toBe('webhook_unconfigured');
    mockConfig.computeidWebhookSecret = ' , ';
    expect((await post(evt('passport.revoked'))).body.error.code).toBe('webhook_unconfigured');
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

  it('GOLDEN: verifies the real delivery captured from api.aicomputeid.com on 2026-09-07 byte-for-byte, with its content type', async () => {
    const fx = JSON.parse(
      readFileSync(new URL('../../../integrations/computeid/__fixtures__/golden-test-delivery.json', import.meta.url), 'utf8'),
    ) as { secret: string; header_value: string; body: string; content_type: string };
    mockConfig.computeidWebhookSecret = fx.secret;
    const res = await post(fx.body, fx.header_value, createApp(), fx.content_type);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true, event: 'test' });
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(sign(fx.body, fx.secret)).toBe(fx.header_value);
  });

  it('accepts a delivery sent as text/plain (raw parsing is content-type agnostic; HMAC is the authentication)', async () => {
    const body = JSON.stringify({ event: 'test', timestamp: T2 });
    const res = await post(body, sign(body), createApp(), 'text/plain;charset=UTF-8');
    expect(res.status).toBe(200);
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
    expect((await post(body, sign(body))).status).toBe(413);
  });
});

describe('POST /webhooks/computeid — body validation', () => {
  it('400 invalid_body for non-JSON, with a DLQ record that never echoes body bytes', async () => {
    const dlq = builder({});
    routeTables({ webhook_dlq: dlq });
    const res = await post('not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
    expect(dlq.insert).toHaveBeenCalledWith(expect.objectContaining({ provider: 'computeid', reason: 'invalid_body:json_parse' }));
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

  it('tolerates a non-string / oversized reason and an offset-style timestamp — a surprising field never drops a revocation', async () => {
    const agents = agentsWithCas([agentRow()]);
    routeTables({ agents, api_keys: builder({}), webhook_dlq: builder({}) });
    const body = JSON.stringify({
      event: 'passport.revoked', passport_id: PASSPORT.toUpperCase(),
      reason: { code: 'fraud', note: 'x'.repeat(5000) }, timestamp: '2026-09-07T11:00:00+0000',
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: 1 });
    expect(agents.contains).toHaveBeenCalledWith('metadata', { computeid: { passport_id: PASSPORT } });
  });
});

describe('POST /webhooks/computeid — passport events', () => {
  it('passport.revoked: deactivates keys FIRST, then compare-and-sets the agent row to revoked, audits SECURITY', async () => {
    const agents = agentsWithCas([agentRow()]);
    const keys = builder({});
    const dlq = builder({});
    routeTables({ agents, api_keys: keys, webhook_dlq: dlq });

    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, event: 'passport.revoked', applied: 1, skipped: 0 });

    // keys before the row flip
    expect(keys.update.mock.invocationCallOrder[0]).toBeLessThan(agents.update.mock.invocationCallOrder[0]);
    expect(keys.update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false, revocation_reason: 'computeid:passport.revoked' }));
    expect(keys.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(keys.eq).toHaveBeenCalledWith('agent_id', AGENT_ID);
    expect(keys.eq).toHaveBeenCalledWith('is_active', true);

    // compare-and-set on the snapshot we decided from
    expect(agents.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked', revoked_at: T2 }));
    expect(agents.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(agents.eq).toHaveBeenCalledWith('id', AGENT_ID);
    expect(agents.eq).toHaveBeenCalledWith('status', 'active');
    expect(agents.is).toHaveBeenCalledWith(LAST_EVENT_AT_COL, null);
    expect(agents.select).toHaveBeenCalledWith('id');

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'AGENT_PASSPORT_REVOKED', event_category: 'SECURITY', target_type: 'agent', target_id: AGENT_ID, org_id: ORG_ID,
    }));
    expect(dlq.insert).not.toHaveBeenCalled();
  });

  it('passport.suspended deactivates keys (the auth path checks only api_keys.is_active) and marks the suspension as ours', async () => {
    const agents = agentsWithCas([agentRow()]);
    const keys = builder({});
    routeTables({ agents, api_keys: keys, webhook_dlq: builder({}) });
    const res = await post(evt('passport.suspended'));
    expect(res.status).toBe(200);
    expect(keys.update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false, revocation_reason: 'computeid:passport.suspended' }));
    const patch = agents.update.mock.calls[0][0] as { status: string; metadata: { computeid: { suspended_by?: string } } };
    expect(patch.status).toBe('suspended');
    expect(patch.metadata.computeid.suspended_by).toBe('computeid');
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'AGENT_PASSPORT_SUSPENDED' }));
  });

  it('passport.reinstated on a suspension WE applied re-activates the row and restores exactly the keys we deactivated', async () => {
    const agents = agentsWithCas([agentRow({ status: 'suspended', metadata: binding({ suspended_by: 'computeid', last_event: 'passport.suspended', last_event_at: T2 }) })]);
    const keys = builder({});
    routeTables({ agents, api_keys: keys, webhook_dlq: builder({}) });
    const res = await post(evt('passport.reinstated', { timestamp: T3 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: 1 });
    expect(agents.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', suspended_at: null }));
    expect(agents.eq).toHaveBeenCalledWith('status', 'suspended');
    expect(agents.eq).toHaveBeenCalledWith(LAST_EVENT_AT_COL, T2);
    // reactivation after the row is active; only OUR suspension's keys
    expect(agents.update.mock.invocationCallOrder[0]).toBeLessThan(keys.update.mock.invocationCallOrder[0]);
    expect(keys.update).toHaveBeenCalledWith(expect.objectContaining({ is_active: true, revoked_at: null, revocation_reason: null }));
    expect(keys.eq).toHaveBeenCalledWith('revocation_reason', 'computeid:passport.suspended');
    expect(keys.eq).toHaveBeenCalledWith('is_active', false);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'AGENT_PASSPORT_REINSTATED' }));
  });

  it('passport.reinstated never lifts a suspension the ORG applied (no ownership marker): clock advances, no status change, keys untouched', async () => {
    const agents = agentsWithCas([agentRow({ status: 'suspended' })]);
    const keys = builder({});
    routeTables({ agents, api_keys: keys, webhook_dlq: builder({}) });
    const res = await post(evt('passport.reinstated', { timestamp: T3 }));
    expect(res.body).toMatchObject({ applied: 0, skipped: 1 });
    const patch = agents.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('status');
    expect(patch).toHaveProperty('metadata');
    expect(keys.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('revoked is terminal: a later event advances the clock, re-asserts keys OFF (self-heal), changes no status, audits nothing', async () => {
    const agents = agentsWithCas([agentRow({ status: 'revoked' })]);
    const keys = builder({});
    routeTables({ agents, api_keys: keys, webhook_dlq: builder({}) });
    const res = await post(evt('passport.reinstated', { timestamp: T3 }));
    expect(res.body).toMatchObject({ applied: 0, skipped: 1 });
    expect((agents.update.mock.calls[0][0] as Record<string, unknown>)).not.toHaveProperty('status');
    expect(keys.update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('ordering floor: an exact replay or an older event is a no-op with NO writes; a pre-admission revocation cannot revoke a fresh agent', async () => {
    const replayed = agentsWithCas([agentRow({ status: 'suspended', metadata: binding({ last_event: 'passport.suspended', last_event_at: T2 }) })]);
    const keys = builder({});
    routeTables({ agents: replayed, api_keys: keys, webhook_dlq: builder({}) });
    expect((await post(evt('passport.suspended', { timestamp: T2 }))).body).toMatchObject({ applied: 0, skipped: 1 });
    expect((await post(evt('passport.reinstated', { timestamp: T1 }))).body).toMatchObject({ applied: 0, skipped: 1 });
    expect(replayed.update).not.toHaveBeenCalled();
    expect(keys.update).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const fresh = agentsWithCas([agentRow()]); // receipt_issued_at = T1
    routeTables({ agents: fresh, api_keys: keys, webhook_dlq: builder({}) });
    expect((await post(evt('passport.revoked', { timestamp: T0 }))).body).toMatchObject({ applied: 0, skipped: 1 });
    expect(fresh.update).not.toHaveBeenCalled();
    expect(keys.update).not.toHaveBeenCalled();
  });

  it('a passport bound in two orgs: each row is updated under its OWN org_id', async () => {
    const rowB = agentRow({ id: AGENT_B, org_id: ORG_B });
    const agents = builder([{ data: [agentRow(), rowB] }, { data: [{ id: AGENT_ID }] }, { data: [{ id: AGENT_B }] }]);
    const keys = builder({});
    routeTables({ agents, api_keys: keys, webhook_dlq: builder({}) });
    const res = await post(evt('passport.revoked'));
    expect(res.body).toMatchObject({ applied: 2, skipped: 0 });
    expect(agents.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(agents.eq).toHaveBeenCalledWith('org_id', ORG_B);
    expect(keys.eq).toHaveBeenCalledWith('org_id', ORG_B);
    expect(keys.eq).toHaveBeenCalledWith('agent_id', AGENT_B);
  });

  it('unbound passport: 200 orphaned:true and a DLQ record so the miss is visible', async () => {
    const dlq = builder({});
    routeTables({ agents: builder({ data: [] }), webhook_dlq: dlq });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orphaned: true });
    expect(dlq.insert).toHaveBeenCalledWith(expect.objectContaining({ provider: 'computeid', reason: 'unbound_passport', external_id: PASSPORT }));
  });

  it('lost CAS race (zero rows updated): 409 conflict_retry + DLQ so the sender redelivers against fresh state', async () => {
    const agents = agentsWithCas([agentRow()], []);
    const dlq = builder({});
    routeTables({ agents, api_keys: builder({}), webhook_dlq: dlq });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict_retry');
    expect(dlq.insert).toHaveBeenCalledWith(expect.objectContaining({ reason: 'agent_update_conflict:passport.revoked' }));
  });

  it('key deactivation failure: 500 + DLQ, and the agent row is NOT flipped (keys-first ordering)', async () => {
    const agents = agentsWithCas([agentRow()]);
    const keys = builder({}, { updateResult: { error: { code: 'XX000', message: 'boom' } } });
    const dlq = builder({});
    routeTables({ agents, api_keys: keys, webhook_dlq: dlq });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(500);
    expect(agents.update).not.toHaveBeenCalled();
    expect(dlq.insert).toHaveBeenCalledWith(expect.objectContaining({ reason: 'agent_keys_deactivate_failed:passport.revoked' }));
  });

  it('agent update failure: 500 + DLQ so the sender can retry', async () => {
    const agents = builder([{ data: [agentRow()] }, { error: { code: 'XX000', message: 'boom' } }]);
    const dlq = builder({});
    routeTables({ agents, api_keys: builder({}), webhook_dlq: dlq });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('webhook_processing_failed');
    expect(dlq.insert).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('agent_update_failed') }));
  });

  it('never leaks the partner-supplied free-text reason or the raw body into logs, audit details, or the DLQ', async () => {
    const agents = agentsWithCas([agentRow()]);
    const dlq = builder({});
    routeTables({ agents, api_keys: builder({}), webhook_dlq: dlq });
    await post(evt('passport.revoked'));
    const serializedLogs = JSON.stringify([logCalls.info.mock.calls, logCalls.warn.mock.calls, logCalls.error.mock.calls, logCalls.debug.mock.calls]);
    expect(serializedLogs).not.toContain('SENSITIVE-REASON');
    expect(serializedLogs).not.toContain('john.doe@example.com');
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain('SENSITIVE-REASON');
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain('john.doe@example.com');
    expect(JSON.stringify(dlq.insert.mock.calls)).not.toContain('SENSITIVE-REASON');
  });
});
