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
const dbRpcMock = vi.fn();
const authorityRpcMock = vi.fn();
const dlqRpcMock = vi.fn();
const logCalls = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const auditMock = vi.fn();
const mockConfig = vi.hoisted(() => ({
  enableComputeidIntegration: true,
  computeidWebhookSecret: 'computeid-fixture-secret-aaaa' as string | undefined,
}));
vi.mock('../../../config.js', () => ({ config: mockConfig }));
vi.mock('../../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: (name: string, ...args: unknown[]) => name === 'record_computeid_passport_revocation' ? authorityRpcMock(name, ...args) : name === 'enqueue_computeid_failure' ? dlqRpcMock(name, ...args) : dbRpcMock(name, ...args) } }));
vi.mock('../../../utils/logger.js', () => ({ logger: logCalls }));
vi.mock('../../../utils/auditEvent.js', () => ({
  recordAuditEvent: (...args: unknown[]) => { auditMock(...args); return Promise.resolve(); },
}));

import { computeidWebhookRouter, computeidWebhookBody } from './computeid.js';
import { computeidGate } from '../../../middleware/computeidGate.js';
import { rateLimiters, setRateLimitStore } from '../../../utils/rateLimit.js';

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

const routeTables = (map: Record<string, unknown>) => routeDbTables(dbFromMock, map);

function createApp(withRawParser = true) {
  const app = express();
  if (withRawParser) {
    app.use(
      '/webhooks/computeid',
      computeidGate,
      rateLimiters.computeidWebhook,
      computeidWebhookBody,
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
const boundAgents = (rows: ReturnType<typeof agentRow>[]) => {
  const b = builder({ data: rows });
  let cursor = '';
  b.select.mockImplementation(() => { cursor = ''; return b; });
  b.gt = vi.fn((_column: string, value: string) => { cursor = value; return b; });
  b.then = (onF, onR) => Promise.resolve({ data: rows.filter((row) => row.id > cursor), error: null }).then(onF, onR);
  return b;
};

beforeEach(() => {
  vi.clearAllMocks();
  dbFromMock.mockReset();
  dbRpcMock.mockReset().mockResolvedValue({ data: true, error: null });
  authorityRpcMock.mockReset().mockResolvedValue({ data: true, error: null });
  dlqRpcMock.mockReset().mockResolvedValue({ data: true, error: null });
  mockConfig.enableComputeidIntegration = true;
  mockConfig.computeidWebhookSecret = TEST_SECRET;
  setRateLimitStore(new Map());
});

describe('POST /webhooks/computeid — gating + signature', () => {
  it('503 vendor_gated when config.enableComputeidIntegration is false (no DB, no signature check)', async () => {
    mockConfig.enableComputeidIntegration = false;
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('vendor_gated');
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(dbRpcMock).not.toHaveBeenCalled();
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
    expect(dbRpcMock).not.toHaveBeenCalled();
  });

  it('GOLDEN: verifies the real delivery captured from api.aicomputeid.com on 2026-09-07 byte-for-byte, with its content type', async () => {
    const fx = JSON.parse(
      readFileSync(new URL('../../../integrations/computeid/__fixtures__/golden-test-delivery.json', import.meta.url), 'utf8'),
    ) as { secret: string; header_value: string; body: string; content_type: string };
    mockConfig.computeidWebhookSecret = fx.secret;
    const res = await post(fx.body, fx.header_value, createApp(), fx.content_type);
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('100');
    expect(res.body).toMatchObject({ ok: true, ignored: true, event: 'test' });
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(dbRpcMock).not.toHaveBeenCalled();
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
    expect(dlqRpcMock).toHaveBeenCalledWith('enqueue_computeid_failure', expect.objectContaining({ p_reason: 'invalid_body:json_parse' }));
  });

  it('200 ignored for unknown / future event types (acked so the sender does not retry)', async () => {
    const res = await post(JSON.stringify({ event: 'passport.renamed', timestamp: T2, passport_id: PASSPORT }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true });
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(dbRpcMock).not.toHaveBeenCalled();
  });

  it('400 when a passport event lacks a UUID passport_id, with a DLQ record naming the shape failure', async () => {
    const dlq = builder({});
    routeTables({ webhook_dlq: dlq });
    const res = await post(JSON.stringify({ event: 'passport.revoked', timestamp: T2 }));
    expect(res.status).toBe(400);
    expect(dlqRpcMock).toHaveBeenCalledWith('enqueue_computeid_failure', expect.objectContaining({ p_reason: expect.stringContaining('shape') }));
  });

  it('tolerates a non-string / oversized reason and an offset-style timestamp — a surprising field never drops a revocation', async () => {
    const agents = boundAgents([agentRow()]);
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
  it('revocation delegates the complete snapshot and agent, key and security audit to one atomic transaction', async () => {
    const row = agentRow();
    const agents = boundAgents([row]);
    routeTables({ agents, webhook_dlq: builder({}) });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: 1, skipped: 0 });
    expect(dbRpcMock).toHaveBeenCalledExactlyOnceWith('apply_computeid_agent_transition', {
      p_org_id: ORG_ID, p_agent_id: AGENT_ID, p_passport_id: PASSPORT,
      p_expected_status: 'active', p_expected_metadata: row.metadata,
      p_update: expect.objectContaining({ status: 'revoked', revoked_at: T2 }),
      p_key_enforcement: 'deactivate', p_event: 'passport.revoked', p_event_at: T2,
    });
    expect(agents.update).not.toHaveBeenCalled();
    expect(dbFromMock).not.toHaveBeenCalledWith('api_keys');
    expect(auditMock).not.toHaveBeenCalled(); // Audit is part of the RPC transaction.
  });

  it('suspension atomically deactivates keys and marks the suspension as provider-owned', async () => {
    routeTables({ agents: boundAgents([agentRow()]), webhook_dlq: builder({}) });
    expect((await post(evt('passport.suspended'))).status).toBe(200);
    expect(dbRpcMock).toHaveBeenCalledWith('apply_computeid_agent_transition', expect.objectContaining({
      p_key_enforcement: 'deactivate',
      p_update: expect.objectContaining({ status: 'suspended', metadata: expect.objectContaining({
        computeid: expect.objectContaining({ suspended_by: 'computeid' }),
      }) }),
    }));
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('provider-owned reinstatement passes the suspended snapshot and key restoration into the same transaction', async () => {
    const row = agentRow({ status: 'suspended', metadata: binding({ suspended_by: 'computeid', last_event: 'passport.suspended', last_event_at: T2 }) });
    routeTables({ agents: boundAgents([row]), webhook_dlq: builder({}) });
    const res = await post(evt('passport.reinstated', { timestamp: T3 }));
    expect(res.body).toMatchObject({ applied: 1 });
    expect(dbRpcMock).toHaveBeenCalledWith('apply_computeid_agent_transition', expect.objectContaining({
      p_expected_status: 'suspended', p_expected_metadata: row.metadata,
      p_update: expect.objectContaining({ status: 'active', suspended_at: null }), p_key_enforcement: 'reactivate',
    }));
    expect(dbFromMock).not.toHaveBeenCalledWith('api_keys');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('org-owned suspension stays suspended: only its event clock advances, with no key restoration', async () => {
    routeTables({ agents: boundAgents([agentRow({ status: 'suspended' })]), webhook_dlq: builder({}) });
    expect((await post(evt('passport.reinstated', { timestamp: T3 }))).body).toMatchObject({ applied: 0, skipped: 1 });
    const args = dbRpcMock.mock.calls[0][1];
    expect(args.p_update).not.toHaveProperty('status');
    expect(args.p_update).toHaveProperty('metadata');
    expect(args.p_key_enforcement).toBe('none');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('revoked stays terminal and atomically reasserts keys off on a later event', async () => {
    routeTables({ agents: boundAgents([agentRow({ status: 'revoked' })]), webhook_dlq: builder({}) });
    expect((await post(evt('passport.reinstated', { timestamp: T3 }))).body).toMatchObject({ applied: 0, skipped: 1 });
    const args = dbRpcMock.mock.calls[0][1];
    expect(args.p_update).not.toHaveProperty('status');
    expect(args.p_key_enforcement).toBe('deactivate');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('exact and older relaxing events do not write, but terminal revocation overrides a newer receipt', async () => {
    const row = agentRow({ status: 'suspended', metadata: binding({ last_event: 'passport.suspended', last_event_at: T2 }) });
    routeTables({ agents: boundAgents([row]), webhook_dlq: builder({}) });
    expect((await post(evt('passport.suspended', { timestamp: T2 }))).body).toMatchObject({ applied: 0, skipped: 1 });
    expect((await post(evt('passport.reinstated', { timestamp: T1 }))).body).toMatchObject({ applied: 0, skipped: 1 });
    expect(dbRpcMock).not.toHaveBeenCalled();
    routeTables({ agents: boundAgents([agentRow()]), webhook_dlq: builder({}) });
    expect((await post(evt('passport.revoked', { timestamp: T0 }))).body).toMatchObject({ applied: 1, skipped: 0 });
    expect(dbRpcMock).toHaveBeenCalledTimes(1);
    expect(dbFromMock).not.toHaveBeenCalledWith('api_keys');
  });

  it('a passport bound in two organizations scopes each transaction to its own organization and agent', async () => {
    routeTables({ agents: boundAgents([agentRow(), agentRow({ id: AGENT_B, org_id: ORG_B })]), webhook_dlq: builder({}) });
    expect((await post(evt('passport.revoked'))).body).toMatchObject({ applied: 2, skipped: 0 });
    expect(dbRpcMock).toHaveBeenNthCalledWith(1, 'apply_computeid_agent_transition', expect.objectContaining({ p_org_id: ORG_ID, p_agent_id: AGENT_ID }));
    expect(dbRpcMock).toHaveBeenNthCalledWith(2, 'apply_computeid_agent_transition', expect.objectContaining({ p_org_id: ORG_B, p_agent_id: AGENT_B }));
  });

  it('an unbound passport is acknowledged and recorded without executing a transition', async () => {
    const dlq = builder({});
    routeTables({ agents: boundAgents([]), webhook_dlq: dlq });
    expect((await post(evt('passport.revoked'))).body).toMatchObject({ orphaned: true });
    expect(dlqRpcMock).toHaveBeenCalledWith('enqueue_computeid_failure', expect.objectContaining({ p_reason: 'unbound_passport', p_external_id: PASSPORT }));
    expect(dbRpcMock).not.toHaveBeenCalled();
  });

  it('a changed locked snapshot requests redelivery without auditing a transition that did not commit', async () => {
    const dlq = builder({});
    routeTables({ agents: boundAgents([agentRow()]), webhook_dlq: dlq });
    dbRpcMock.mockResolvedValue({ data: false, error: null });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict_retry');
    expect(dlqRpcMock).toHaveBeenCalledWith('enqueue_computeid_failure', expect.objectContaining({ p_reason: 'agent_update_conflict:passport.revoked' }));
    expect(auditMock).not.toHaveBeenCalled();
  });

  it.each(['returned error', 'transport exception', 'invalid response'])('fails closed on an atomic transition %s', async (mode) => {
    const agents = boundAgents([agentRow()]);
    const dlq = builder({});
    routeTables({ agents, webhook_dlq: dlq });
    if (mode === 'returned error') dbRpcMock.mockResolvedValue({ data: null, error: { code: 'XX000' } });
    else if (mode === 'transport exception') dbRpcMock.mockRejectedValue(new Error('transport unavailable'));
    else dbRpcMock.mockResolvedValue({ data: null, error: null });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('webhook_processing_failed');
    expect(dlqRpcMock).toHaveBeenCalledWith('enqueue_computeid_failure', expect.objectContaining({ p_reason: 'agent_transition_failed:passport.revoked' }));
    expect(agents.update).not.toHaveBeenCalled();
    expect(dbFromMock).not.toHaveBeenCalledWith('api_keys');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('never passes the provider reason or raw body to the RPC, logs, audit, or DLQ', async () => {
    const dlq = builder({});
    routeTables({ agents: boundAgents([agentRow()]), webhook_dlq: dlq });
    await post(evt('passport.revoked'));
    const serialized = JSON.stringify([dbRpcMock.mock.calls, logCalls.info.mock.calls, logCalls.warn.mock.calls,
      logCalls.error.mock.calls, logCalls.debug.mock.calls, auditMock.mock.calls, dlqRpcMock.mock.calls]);
    expect(serialized).not.toContain('SENSITIVE-REASON');
    expect(serialized).not.toContain('john.doe@example.com');
  });
});

describe('ComputeID partial-write recovery regressions', () => {
  it('retries the whole restoration when its atomic transaction failed; no separate row commit can swallow the retry', async () => {
    const initial = agentRow({ status: 'suspended', metadata: binding({ suspended_by: 'computeid', last_event: 'passport.suspended', last_event_at: T2 }) });
    const agents = boundAgents([initial]);
    routeTables({ agents, webhook_dlq: builder({}) });
    dbRpcMock.mockResolvedValueOnce({ data: null, error: { message: 'temporary key write unavailable' } });
    const body = evt('passport.reinstated', { timestamp: T3 });
    expect((await post(body)).status).toBe(500);
    expect((await post(body)).body).toMatchObject({ applied: 1, skipped: 0 });
    expect(dbRpcMock).toHaveBeenCalledTimes(2);
    expect(dbRpcMock.mock.calls[0]).toEqual(dbRpcMock.mock.calls[1]);
    expect(agents.update).not.toHaveBeenCalled();
    expect(dbFromMock).not.toHaveBeenCalledWith('api_keys');
  });

  it('does not issue a late separate key restore after the atomic snapshot loses to a revocation', async () => {
    const initial = agentRow({ status: 'suspended', metadata: binding({ suspended_by: 'computeid', last_event: 'passport.suspended', last_event_at: T1 }) });
    const revoked = agentRow({ status: 'revoked', metadata: binding({ last_event: 'passport.revoked', last_event_at: T3 }) });
    const agents = builder([{ data: [initial] }, { data: [revoked] }, { data: [] }]);
    agents.gt = vi.fn(() => agents);
    routeTables({ agents, webhook_dlq: builder({}) });
    // A real PostgreSQL concurrency regression separately proves that a revoke
    // winning the row lock makes the older restoration CAS return false.
    dbRpcMock.mockResolvedValueOnce({ data: false, error: null });
    const body = evt('passport.reinstated', { timestamp: T2 });
    expect((await post(body)).status).toBe(409);
    expect((await post(body)).body).toMatchObject({ applied: 0, skipped: 1 });
    expect(dbRpcMock).toHaveBeenCalledTimes(1);
    expect(dbFromMock).not.toHaveBeenCalledWith('api_keys');
    expect(auditMock).not.toHaveBeenCalled();
  });
});


describe('global provider authority and timestamp validation', () => {
  it('records an orphan revocation and preserves enforcement on an identical retry', async () => {
    const agents = boundAgents([]);
    routeTables({ agents, webhook_dlq: builder({ data: null }) });
    expect((await post(evt('passport.revoked'))).body.orphaned).toBe(true);
    expect(authorityRpcMock).toHaveBeenCalledWith('record_computeid_passport_revocation', {
      p_passport_id: PASSPORT, p_event_at: T2,
    });
    routeTables({ agents: boundAgents([agentRow()]), webhook_dlq: builder({ data: null }) });
    expect((await post(evt('passport.revoked'))).body.applied).toBe(1);
    expect(authorityRpcMock).toHaveBeenCalledTimes(2);
    expect(dbRpcMock).toHaveBeenCalledWith('apply_computeid_agent_transition', expect.any(Object));
  });
  it('returns retryable500 if authority persistence fails before looking up agents', async () => {
    authorityRpcMock.mockResolvedValue({ data: null, error: { message: 'database unavailable' } });
    routeTables({ webhook_dlq: builder({ data: null }) });
    expect((await post(evt('passport.revoked'))).status).toBe(500);
    expect(dbRpcMock).not.toHaveBeenCalled();
    expect(dbFromMock).not.toHaveBeenCalledWith('agents');
  });
  it('rejects and dead-letters a signed far-future clock before any authority/agent writes', async () => {
    const dlq = builder({ data: null });
    routeTables({ webhook_dlq: dlq });
    const response = await post(evt('passport.reinstated', { timestamp: '9999-01-01T00:00:00.000Z' }));
    expect(response.status).toBe(400);
    expect(dlqRpcMock).toHaveBeenCalledWith('enqueue_computeid_failure', expect.objectContaining({ p_reason: 'future_event_timestamp' }));
    expect(authorityRpcMock).not.toHaveBeenCalled();
    expect(dbRpcMock).not.toHaveBeenCalled();
  });
  it('normalizes parseable provider time to canonical SQL time before persistence', async () => {
    routeTables({ agents: boundAgents([agentRow({ metadata: binding({ receipt_issued_at: '2025-01-01T00:00:00.000Z' }) })]), webhook_dlq: builder({ data: null }) });
    expect((await post(evt('passport.revoked', { timestamp: '2026' }))).status).toBe(200);
    expect(authorityRpcMock).toHaveBeenCalledWith('record_computeid_passport_revocation', {
      p_passport_id: PASSPORT, p_event_at: '2026-01-01T00:00:00.000Z',
    });
    expect(dbRpcMock).toHaveBeenCalledWith('apply_computeid_agent_transition', expect.objectContaining({
      p_event_at: '2026-01-01T00:00:00.000Z', p_update: expect.objectContaining({ revoked_at: '2026-01-01T00:00:00.000Z' }),
    }));
  });
});


it('rejects suffix paths before raw parsing and gates oversized bodies before parsing while disabled', async () => {
  const huge = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
  const suffix = await request(createApp()).post('/webhooks/computeid/unused').set('Content-Type', 'application/json').send(huge);
  expect(suffix.status).toBe(404);
  expect(suffix.body.error.code).toBe('not_found');
  mockConfig.enableComputeidIntegration = false;
  const disabled = await post(huge);
  expect(disabled.status).toBe(503);
  expect(disabled.body.error.code).toBe('vendor_gated');
  expect(authorityRpcMock).not.toHaveBeenCalled();
});


describe('cross-organization PostgREST pagination', () => {
  function pagedAgents(rows: ReturnType<typeof agentRow>[], failAfter?: string, cap = 1000) {
    const b = builder({});
    let cursor = '';
    let limit = cap;
    b.select.mockImplementation(() => { cursor = ''; limit = cap; return b; });
    b.gt = vi.fn((_column: string, value: string) => { cursor = value; return b; });
    b.limit.mockImplementation((value: number) => { limit = Math.min(value, cap); return b; });
    b.then = (onF, onR) => Promise.resolve(failAfter && cursor >= failAfter
      ? { data: null, error: { code: 'XX000' } }
      : { data: rows.filter((r) => r.id > cursor).slice(0, limit), error: null }).then(onF, onR);
    return b;
  }
  const rows = () => Array.from({ length: 1001 }, (_, i) => agentRow({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    org_id: i % 2 ? ORG_B : ORG_ID,
  }));

  it('revokes every binding beyond the configured 1000-row response cap before acknowledging success', async () => {
    const all = rows();
    const agents = pagedAgents(all);
    routeTables({ agents });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1001);
    expect(new Set(dbRpcMock.mock.calls.map((call) => call[1].p_agent_id)).size).toBe(1001);
    expect(agents.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(agents.limit).toHaveBeenCalledWith(200);
  });

  it('does not acknowledge all agents when a later page fails; an identical retry completes the remaining keys', async () => {
    const all = rows();
    routeTables({ agents: pagedAgents(all, all[199].id) });
    const first = await post(evt('passport.revoked'));
    expect(first.status).toBe(500);
    expect(dbRpcMock).toHaveBeenCalledTimes(200);
    routeTables({ agents: pagedAgents(all) });
    const retry = await post(evt('passport.revoked'));
    expect(retry.status).toBe(200);
    expect(retry.body.applied).toBe(1001);
    expect(authorityRpcMock).toHaveBeenCalledTimes(2);
  });
  it('continues through short hosted pages until an empty page proves exhaustion', async () => {
    const all = rows().slice(0, 23);
    const agents = pagedAgents(all, undefined, 7);
    routeTables({ agents });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(23);
    expect(agents.select).toHaveBeenCalledTimes(5);
    expect(agents.gt).toHaveBeenLastCalledWith('id', all[22].id);
  });

  it('does not skip later bindings when earlier rows disappear between pages', async () => {
    const all = rows();
    routeTables({ agents: pagedAgents(all) });
    let writes = 0;
    dbRpcMock.mockImplementation(async () => {
      if (++writes === 200) all.splice(0, 100);
      return { data: true, error: null };
    });
    const res = await post(evt('passport.revoked'));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1001);
    expect(new Set(dbRpcMock.mock.calls.map((call) => call[1].p_agent_id)).size).toBe(1001);
  });

});
