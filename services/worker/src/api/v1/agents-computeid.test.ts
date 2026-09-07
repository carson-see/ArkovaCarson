/**
 * ComputeID AgentPassport admission — `POST /api/v1/agents/computeid/admit`.
 *
 * Machine-to-machine: the caller is an org API key holding `agents:manage`
 * (the "authorizing principal"). The agent presents its passport id plus the
 * `verification_receipt` from ComputeID's `/v1/agents/{id}/verify`; Arkova
 * verifies the receipt OFFLINE against the pinned CA (no ComputeID call on the
 * admission path), binds the passport to a new agent row and mints an
 * agent-scoped key. The raw key is returned exactly once.
 */
import { generateKeyPairSync, sign as rsaSign, type KeyObject } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';

const dbFromMock = vi.fn();
const auditMock = vi.fn();
const mockConfig = vi.hoisted(() => ({
  enableComputeidIntegration: true,
  computeidCaCertPem: '' as string | undefined,
  apiKeyHmacSecret: 'test-api-key-hmac-secret' as string | undefined,
}));
vi.mock('../../config.js', () => ({ config: mockConfig }));
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args) } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({
  recordAuditEvent: (...args: unknown[]) => { auditMock(...args); return Promise.resolve(); },
}));

import { agentsComputeIdRouter, PASSPORT_AGENT_SCOPE_ALLOWLIST } from './agents-computeid.js';
import { requireScopeAnyAuth } from '../../middleware/requireScopeAnyAuth.js';
import { hashApiKey, type ApiKeyMeta } from '../../middleware/apiKeyAuth.js';
import { loadPinnedCa } from '../../integrations/computeid/ca-cert.js';

const HMAC = 'test-api-key-hmac-secret';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const KEY_ID = '44444444-4444-4444-4444-444444444444';
const PASSPORT = '0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f';
const NOW_ISO = '2026-09-07T12:00:00.000Z';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CA_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;
const CA = loadPinnedCa(CA_PEM);

const routeTables = (map: Record<string, unknown>) => routeDbTables(dbFromMock, map);

function receipt(priv: KeyObject = privateKey, payloadOverride: Record<string, unknown> = {}, issuedAgoMs = 60_000) {
  // The handler verifies against the REAL clock, so a valid fixture is issued
  // just now and expires in the future.
  const now = Date.now();
  const payload = {
    passport_id: PASSPORT,
    status: 'active',
    signature_valid: true,
    issued_at: new Date(now - issuedAgoMs).toISOString(),
    expires_at: new Date(now + 30 * 60_000).toISOString(),
    key_id: CA.keyId,
    ...payloadOverride,
  };
  const receipt_payload = JSON.stringify(payload);
  return {
    passport_id: payload.passport_id,
    status: payload.status,
    signature_valid: true,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    key_id: CA.keyId,
    receipt_signature: rsaSign('sha256', Buffer.from(receipt_payload, 'utf8'), priv).toString('base64'),
    receipt_algorithm: 'RSA-SHA256',
    receipt_payload,
  };
}
const apiKeyMeta = (scopes: string[] = ['agents:manage']): ApiKeyMeta => ({
  keyId: KEY_ID, orgId: ORG_ID, userId: USER_ID, scopes, rateLimitTier: 'paid', keyPrefix: 'ak_live_test',
});
const insertedAgent = (over: Record<string, unknown> = {}) => ({
  id: AGENT_ID, org_id: ORG_ID, registered_by: USER_ID, name: 'cortex-agent', status: 'active', agent_type: 'llm_agent',
  allowed_scopes: ['verify', 'anchor:write'], created_at: NOW_ISO, ...over,
});
function happyTables(existingRows: unknown[] = []) {
  const agents = builder([{ data: existingRows }, { data: insertedAgent() }]);
  const keys = builder({ data: { id: KEY_ID, key_prefix: 'ak_live_abcd', scopes: ['verify', 'anchor:write'], created_at: NOW_ISO } });
  routeTables({ agents, api_keys: keys });
  return { agents, keys };
}
function createApp(opts: { apiKey?: ApiKeyMeta | null; guard?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.apiKey) (req as unknown as { apiKey: ApiKeyMeta }).apiKey = opts.apiKey;
    next();
  });
  const mw = opts.guard ? [requireScopeAnyAuth('agents:manage')] : [];
  app.use('/api/v1/agents/computeid', ...mw, agentsComputeIdRouter);
  return app;
}
function admit(body: unknown, app = createApp({ apiKey: apiKeyMeta() })) {
  return request(app).post('/api/v1/agents/computeid/admit').set('Content-Type', 'application/json').send(body as object);
}
const validBody = (over: Record<string, unknown> = {}) => ({
  passport_id: PASSPORT, verification_receipt: receipt(), name: 'cortex-agent', allowed_scopes: ['verify', 'anchor:write'], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbFromMock.mockReset();
  mockConfig.enableComputeidIntegration = true;
  mockConfig.computeidCaCertPem = CA_PEM;
  mockConfig.apiKeyHmacSecret = HMAC;
});

describe('POST /api/v1/agents/computeid/admit — gating + auth', () => {
  it('503 vendor_gated when the integration flag is off', async () => {
    mockConfig.enableComputeidIntegration = false;
    const res = await admit(validBody());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('vendor_gated');
  });
  it('401 with no credential and 403 when the API key lacks agents:manage (router-level guard)', async () => {
    expect((await admit(validBody(), createApp({ apiKey: null, guard: true }))).status).toBe(401);
    expect((await admit(validBody(), createApp({ apiKey: apiKeyMeta(['verify']), guard: true }))).status).toBe(403);
  });
  it('401 api_key_required when reached without an API-key identity even if the guard is absent', async () => {
    const res = await admit(validBody(), createApp({ apiKey: null }));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('api_key_required');
  });
  it('reads the API-key HMAC secret from typed config (req.hmacSecret is only set by the JWT requireAuth this mount omits)', async () => {
    mockConfig.apiKeyHmacSecret = undefined;
    const res = await admit(validBody());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('hmac_unconfigured');
  });
  it('500 ca_unconfigured when the CA pin is missing or unparseable', async () => {
    mockConfig.computeidCaCertPem = undefined;
    expect((await admit(validBody())).body.error.code).toBe('ca_unconfigured');
    mockConfig.computeidCaCertPem = 'garbage';
    expect((await admit(validBody())).body.error.code).toBe('ca_unconfigured');
  });
});

describe('POST /api/v1/agents/computeid/admit — validation + receipt', () => {
  it('400 invalid_request on a malformed body or an unknown scope name', async () => {
    expect((await admit({ passport_id: PASSPORT })).body.error.code).toBe('invalid_request');
    expect((await admit(validBody({ allowed_scopes: ['bogus:scope'] }))).body.error.code).toBe('invalid_request');
  });
  it('401 receipt_invalid carries the verifier reason (one representative case; the matrix lives in receipt-verifier.test.ts)', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bad = await admit(validBody({ verification_receipt: receipt(other.privateKey) }));
    expect(bad.status).toBe(401);
    expect(bad.body.error).toMatchObject({ code: 'receipt_invalid', reason: 'invalid_signature' });
    expect(dbFromMock).not.toHaveBeenCalled();
  });
  it('400 no_permitted_scopes when every requested scope is outside the passport-agent allowlist', async () => {
    const res = await admit(validBody({ allowed_scopes: ['keys:manage', 'admin:rules'] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('no_permitted_scopes');
    expect(res.body.error.permitted).toEqual(PASSPORT_AGENT_SCOPE_ALLOWLIST);
  });
  it('409 passport_already_bound when a live agent in this org already holds the passport', async () => {
    routeTables({ agents: builder({ data: [{ id: AGENT_ID, status: 'active', revoked_at: null }] }) });
    const res = await admit(validBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('passport_already_bound');
  });
  it('409 passport_revoked when the passport was revoked here AFTER the receipt was issued (a captured receipt cannot resurrect it)', async () => {
    const revokedAfter = new Date(Date.now() - 30_000).toISOString(); // receipt issued 60s ago, revoked 30s ago
    routeTables({ agents: builder({ data: [{ id: AGENT_ID, status: 'revoked', revoked_at: revokedAfter }] }) });
    const res = await admit(validBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('passport_revoked');
  });
  it('409 passport_revoked when a revoked binding exists and the SIGNED payload carries no issued_at (cannot prove it post-dates)', async () => {
    // Outer issued_at is schema-required; only the signed payload omits it.
    const base = receipt();
    const signedNoIssued = JSON.stringify({ passport_id: PASSPORT, status: 'active', signature_valid: true, expires_at: base.expires_at, key_id: CA.keyId });
    const noIssued = {
      ...base,
      receipt_payload: signedNoIssued,
      receipt_signature: rsaSign('sha256', Buffer.from(signedNoIssued, 'utf8'), privateKey).toString('base64'),
    };
    routeTables({ agents: builder({ data: [{ id: AGENT_ID, status: 'revoked', revoked_at: '2020-01-01T00:00:00Z' }] }) });
    const res = await admit(validBody({ verification_receipt: noIssued }));
    expect(res.body.error.code).toBe('passport_revoked');
  });
  it('admits again when the receipt was issued AFTER the old revocation (fresh receipt post-dates it)', async () => {
    const revokedBefore = new Date(Date.now() - 120_000).toISOString(); // receipt issued 60s ago
    happyTables([{ id: 'old', status: 'revoked', revoked_at: revokedBefore }]);
    expect((await admit(validBody())).status).toBe(201);
  });
});

describe('POST /api/v1/agents/computeid/admit — success path', () => {
  it('201: creates the agent (org + principal from the caller key), binds the passport, mints a scoped key once, audits both events', async () => {
    const { agents, keys } = happyTables();
    const r = receipt();
    const res = await admit(validBody({ verification_receipt: r, allowed_scopes: ['verify', 'anchor:write', 'keys:manage', 'admin:rules'] }));
    expect(res.status).toBe(201);

    // Binding lookup covers live AND revoked rows in this org.
    expect(agents.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(agents.contains).toHaveBeenCalledWith('metadata', { computeid: { passport_id: PASSPORT } });
    expect(agents.neq).not.toHaveBeenCalled();

    expect(agents.insert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: ORG_ID, registered_by: USER_ID, agent_type: 'llm_agent', name: 'cortex-agent', allowed_scopes: ['verify', 'anchor:write'],
      metadata: expect.objectContaining({
        computeid: expect.objectContaining({ issuer: 'computeid', passport_id: PASSPORT, receipt_expires_at: r.expires_at, receipt_issued_at: r.issued_at }),
      }),
    }));

    const raw: string = res.body.key;
    expect(raw.startsWith('ak_live_')).toBe(true);
    expect(keys.insert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: ORG_ID, agent_id: AGENT_ID, created_by: USER_ID, scopes: ['verify', 'anchor:write'], key_hash: hashApiKey(raw, HMAC),
    }));
    expect(JSON.stringify(keys.insert.mock.calls[0][0])).not.toContain(raw);

    expect(res.body.agent).toMatchObject({ id: AGENT_ID, name: 'cortex-agent', status: 'active', allowed_scopes: ['verify', 'anchor:write'] });
    expect(res.body.agent.org_id).toBeUndefined();
    expect(res.body.agent.registered_by).toBeUndefined();
    expect(res.body.binding).toMatchObject({ issuer: 'computeid', passport_id: PASSPORT });
    expect(res.body.key_id).toBe(KEY_ID);

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'AGENT_PASSPORT_ADMITTED', event_category: 'SECURITY', target_type: 'agent', target_id: AGENT_ID, org_id: ORG_ID, actor_id: USER_ID,
    }));
    // Passport-minted keys are counted like every other agent key.
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'AGENT_KEY_CREATED', target_type: 'api_key', target_id: KEY_ID }));
  });
  it('normalizes an uppercase passport id to lowercase for storage and lookup; accepts the V2 write:anchors spelling', async () => {
    const { agents } = happyTables();
    const res = await admit(validBody({ passport_id: PASSPORT.toUpperCase(), allowed_scopes: ['write:anchors'] }));
    expect(res.status).toBe(201);
    expect(agents.contains).toHaveBeenCalledWith('metadata', { computeid: { passport_id: PASSPORT } });
    expect(agents.insert).toHaveBeenCalledWith(expect.objectContaining({ allowed_scopes: ['write:anchors'] }));
  });
  it('defaults to the verify scope and a passport-derived name when none are supplied', async () => {
    const { agents } = happyTables();
    const res = await admit({ passport_id: PASSPORT, verification_receipt: receipt() });
    expect(res.status).toBe(201);
    expect(agents.insert).toHaveBeenCalledWith(expect.objectContaining({ allowed_scopes: ['verify'], name: expect.stringContaining(PASSPORT.slice(0, 8)) }));
  });
  it('compensates: when the key insert fails the freshly created agent row is deleted and 500 is returned', async () => {
    const agents = builder([{ data: [] }, { data: insertedAgent() }]);
    routeTables({ agents, api_keys: builder({ error: { code: 'XX000', message: 'boom' } }) });
    const res = await admit(validBody());
    expect(res.status).toBe(500);
    expect(agents.delete).toHaveBeenCalled();
    expect(agents.eq).toHaveBeenCalledWith('id', AGENT_ID);
    expect(res.body.key).toBeUndefined();
  });
});
