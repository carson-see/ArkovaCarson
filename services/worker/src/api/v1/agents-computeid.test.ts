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

const dbFromMock = vi.fn();
const dbRpcMock = vi.fn();
const auditMock = vi.fn();
const agentEventMock = vi.fn();
const mockConfig = vi.hoisted(() => ({
  enableComputeidIntegration: true,
  computeidCaCertPem: '' as string | undefined,
  apiKeyHmacSecret: 'test-api-key-hmac-secret' as string | undefined,
}));
vi.mock('../../config.js', () => ({ config: mockConfig }));
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: (...args: unknown[]) => dbRpcMock(...args) } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({
  recordAuditEvent: (...args: unknown[]) => { auditMock(...args); return Promise.resolve(); },
}));
vi.mock('../../webhooks/agentEvents.js', () => ({
  emitAgentEvent: (...args: unknown[]) => agentEventMock(...args), hintAgentWebhookDrain: vi.fn(),
}));

import { agentsComputeIdRouter, PASSPORT_AGENT_SCOPE_ALLOWLIST } from './agents-computeid.js';
import { requireScopeAnyAuth } from '../../middleware/requireScopeAnyAuth.js';
import { hashApiKey, type ApiKeyMeta } from '../../middleware/apiKeyAuth.js';
import { loadPinnedCa } from '../../integrations/computeid/ca-cert.js';
import { API_KEY_SCOPES, scopeSatisfies } from '../apiScopes.js';

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
function admissionResult() {
  return { agent: insertedAgent(), binding: { issuer: 'computeid', passport_id: PASSPORT },
    key: { id: KEY_ID, key_prefix: 'ak_live_abcd', scopes: ['verify', 'anchor:write'], created_at: NOW_ISO } };
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
  dbRpcMock.mockReset().mockResolvedValue({ data: admissionResult(), error: null });
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
  it.each(['passport_already_bound', 'passport_revoked'])('409 for the database authority decision %s', async (error) => {
    dbRpcMock.mockResolvedValue({ data: { error }, error: null });
    const res = await admit(validBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(error);
    expect(res.body.key).toBeUndefined();
  });
  it('rejects a revoked passport even with a newly issued receipt (terminal provider authority)', async () => {
    dbRpcMock.mockResolvedValue({ data: { error: 'passport_revoked' }, error: null });
    expect((await admit(validBody())).status).toBe(409);
    expect(dbFromMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/agents/computeid/admit — atomic admission', () => {
  it('201: binds the authenticated principal/org and persists only the key hash in one RPC', async () => {
    const r = receipt();
    const res = await admit(validBody({ verification_receipt: r, allowed_scopes: ['verify', 'anchor:write', 'keys:manage', 'admin:rules'] }));
    expect(res.status).toBe(201);
    const raw: string = res.body.key;
    expect(raw.startsWith('ak_live_')).toBe(true);
    expect(dbRpcMock).toHaveBeenCalledExactlyOnceWith('admit_computeid_agent_with_outbox', expect.objectContaining({
      p_org_id: ORG_ID, p_principal_id: USER_ID, p_passport_id: PASSPORT,
      p_receipt_issued_at: r.issued_at, p_receipt_expires_at: r.expires_at,
      p_name: 'cortex-agent', p_scopes: ['verify', 'anchor:write'],
      p_key_hash: hashApiKey(raw, HMAC), p_key_prefix: raw.slice(0, 12),
    }));
    expect(JSON.stringify(dbRpcMock.mock.calls)).not.toContain(raw);
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled(); // Both audits belong to the SQL transaction.
    expect(res.body.agent).toMatchObject({ id: AGENT_ID, status: 'active' });
    expect(res.body.agent.org_id).toBeUndefined();
    expect(res.body.agent.registered_by).toBeUndefined();
    expect(res.body.binding).toMatchObject({ issuer: 'computeid', passport_id: PASSPORT });
    expect(res.body.key_id).toBe(KEY_ID);
    expect(agentEventMock).not.toHaveBeenCalled();
  });
  it('admits an uppercase UUID inside the actually signed payload and normalizes storage', async () => {
    const res = await admit(validBody({ passport_id: PASSPORT.toUpperCase(),
      verification_receipt: receipt(privateKey, { passport_id: PASSPORT.toUpperCase() }), allowed_scopes: ['write:anchors'] }));
    expect(res.status).toBe(201);
    expect(dbRpcMock).toHaveBeenCalledWith('admit_computeid_agent_with_outbox', expect.objectContaining({ p_passport_id: PASSPORT, p_scopes: ['write:anchors'] }));
  });
  it('defaults to verify and a passport-derived name', async () => {
    expect((await admit({ passport_id: PASSPORT, verification_receipt: receipt() })).status).toBe(201);
    expect(dbRpcMock).toHaveBeenCalledWith('admit_computeid_agent_with_outbox', expect.objectContaining({ p_scopes: ['verify'], p_name: expect.stringContaining(PASSPORT.slice(0, 8)) }));
  });
  it('returns no key on transaction/audit failure, without issuing any compensating delete', async () => {
    dbRpcMock.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'audit insert failed' } });
    const res = await admit(validBody());
    expect(res.status).toBe(500);
    expect(res.body.key).toBeUndefined();
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(dbRpcMock).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, 'revoked_typo', ['active'], { value: 'active' }])(
    'rejects malformed committed status without fabricating a notification (%s)', async (status) => {
      dbRpcMock.mockResolvedValue({ data: { ...admissionResult(), agent: { ...insertedAgent(), status } }, error: null });
      expect((await admit(validBody())).status).toBe(500);
      expect(agentEventMock).not.toHaveBeenCalled();
    });
  it('preserves a possibly committed key when the RPC reply is lost', async () => {
    dbRpcMock.mockRejectedValue(new Error('transport response lost'));
    const res = await admit(validBody());
    expect(res.status).toBe(500);
    expect(res.body.key).toBeUndefined();
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(dbRpcMock).toHaveBeenCalledTimes(1);
  });
  it('returns no raw credential for an invalid RPC success shape', async () => {
    dbRpcMock.mockResolvedValue({ data: true, error: null });
    const res = await admit(validBody());
    expect(res.status).toBe(500);
    expect(res.body.key).toBeUndefined();
  });
  it('honors global provider revocation independently of the caller organization', async () => {
    dbRpcMock.mockResolvedValue({ data: { error: 'passport_revoked' }, error: null });
    const otherOrg = { ...apiKeyMeta(), orgId: '99999999-9999-4999-8999-999999999999' };
    const res = await admit(validBody(), createApp({ apiKey: otherOrg }));
    expect(res.status).toBe(409);
    expect(res.body.key).toBeUndefined();
    expect(dbRpcMock).toHaveBeenCalledWith('admit_computeid_agent_with_outbox', expect.objectContaining({ p_org_id: otherOrg.orgId, p_passport_id: PASSPORT }));
  });
});


it('documents the effective legacy read aliases without granting any management capability', () => {
  const effective = API_KEY_SCOPES.filter((scope) => scopeSatisfies([...PASSPORT_AGENT_SCOPE_ALLOWLIST], scope));
  expect([...effective].sort()).toEqual(['anchor:read', 'anchor:write', 'attestations:read', 'oracle:read', 'read:records', 'read:search', 'verify', 'verify:batch', 'write:anchors']);
});
