import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  profileOrg: null as string | null,
  membership: true,
  membershipRole: 'owner',
  linkRecipient: vi.fn(),
  captured: null as null | { orgId: string | null; body: Record<string, unknown>; method: string; url: string },
  bulkBodies: [] as Array<Record<string, unknown>>,
}));
vi.mock('../api/v1/anchor-submit.js', () => ({
  BULK_FINGERPRINT_SOURCE: Symbol('testBulkFingerprintSource'),
  anchorSubmitRouter: (req: { apiKey?: { orgId: string | null }; body: Record<string, unknown>; method: string; url: string }, res: { json: (value: unknown) => void }) => {
    state.captured = { orgId: req.apiKey?.orgId ?? null, body: req.body, method: req.method, url: req.url };
    res.json({ ok: true });
  },
  handleAnchorSubmit: async (req: { body: Record<string, unknown> }, res: { status: (code: number) => unknown; json: (value: unknown) => void }) => {
    state.bulkBodies.push(req.body);
    const fingerprint = req.body.fingerprint as string;
    if (fingerprint.startsWith('f')) {
      res.status(503);
      res.json({ error: 'instant_intent_unavailable' });
      return;
    }
    res.status(fingerprint.startsWith('b') ? 200 : 201);
    res.json({
      public_id: `ARK-${fingerprint.slice(0, 4)}`,
      fingerprint,
      idempotent: fingerprint.startsWith('b'),
      instant_status: req.body.action === 'instant' ? 'QUEUED' : null,
    });
  },
}));
vi.mock('../api/bulk-recipient.js', () => ({ linkBulkRecipient: state.linkRecipient }));
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn((table: string) => ({
  select: vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: state.membership ? { id: 'membership', role: state.membershipRole } : null, error: null })) })),
      maybeSingle: vi.fn(async () => ({ data: table === 'profiles' ? { org_id: state.profileOrg, is_platform_admin: false } : null, error: null })),
    })),
  })),
})) } }));

import { anchorSelfServiceRouter } from './anchor-self-service.js';
import { handleAnchorImport } from './anchor-self-service-bulk.js';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => { req.userId = '11111111-1111-4111-8111-111111111111'; next(); });
  instance.use(anchorSelfServiceRouter);
  return instance;
}

describe('anchor self-service context bridge', () => {
  beforeEach(() => {
    state.profileOrg = null; state.membership = true; state.membershipRole = 'owner';
    state.captured = null; state.bulkBodies = []; state.linkRecipient.mockReset();
  });

  it('passes personal scope as null and preserves validated UI metadata/tags', async () => {
    const body = { fingerprint: 'a'.repeat(64), action: 'instant', org_id: null, metadata: { ai_summary: 'safe', fraud_score: 0.1 }, private_tags: { user: ['tax'], organization: [] } };
    const response = await request(app()).post('/').send(body);
    expect(response.status).toBe(200);
    expect(state.captured).toMatchObject({
      orgId: null,
      body: { fingerprint: body.fingerprint, action: body.action, metadata: body.metadata, private_tags: body.private_tags },
      method: 'POST',
    });
    expect(state.captured?.body).not.toHaveProperty('org_id');
  });

  it('authorizes a selected member org and uses that exact scope instead of profile org', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    const selected = '33333333-3333-4333-8333-333333333333';
    const response = await request(app()).post('/').send({ fingerprint: 'b'.repeat(64), org_id: selected, metadata: { jurisdiction: 'MI' } });
    expect(response.status).toBe(200);
    expect(state.captured?.orgId).toBe(selected);
    expect(state.captured?.body.metadata).toEqual({ jurisdiction: 'MI' });
  });

  it('requires an explicit caller-owned scope for GET status and forwards the public path', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    const missing = await request(app()).get('/ARK-1/submission-status');
    expect(missing.status).toBe(400);

    const personal = await request(app()).get('/ARK-1/submission-status?scope=user');
    expect(personal.status).toBe(200);
    expect(state.captured).toMatchObject({ orgId: null, method: 'GET', url: '/ARK-1/submission-status?scope=user' });

    const selected = '33333333-3333-4333-8333-333333333333';
    const organization = await request(app()).get(`/ARK-1/submission-status?org_id=${selected}`);
    expect(organization.status).toBe(200);
    expect(state.captured).toMatchObject({ orgId: selected, method: 'GET' });
  });

  it('does not reveal a status across organization membership boundaries', async () => {
    state.membership = false;
    const selected = '33333333-3333-4333-8333-333333333333';
    const response = await request(app()).get(`/ARK-1/submission-status?org_id=${selected}`);
    expect(response.status).toBe(403);
    expect(state.captured).toBeNull();
  });

  it('runs each bulk row through the canonical submit contract and returns bounded partial results', async () => {
    const response = await request(app()).post('/bulk').send({
      org_id: null,
      action: 'instant',
      description: 'One import',
      private_tags: { user: ['tax'], organization: [] },
      rows: [
        { fingerprint: 'a'.repeat(64), filename: 'new.pdf', fingerprint_provided: false },
        { fingerprint: 'b'.repeat(64), filename: 'same.pdf', fingerprint_provided: true },
        { fingerprint: 'f'.repeat(64), filename: 'failed.pdf', fingerprint_provided: false },
      ],
    });
    expect(response.status).toBe(207);
    expect(response.body).toEqual({
      total: 3, created: 1, skipped: 1, failed: 1,
      results: [
        { fingerprint: 'a'.repeat(64), status: 'created', public_id: 'ARK-aaaa', instant_status: 'QUEUED' },
        { fingerprint: 'b'.repeat(64), status: 'skipped', public_id: 'ARK-bbbb', instant_status: 'QUEUED' },
        { fingerprint: 'f'.repeat(64), status: 'failed', reason: 'instant_intent_unavailable' },
      ],
    });
    expect(state.bulkBodies).toHaveLength(3);
    expect(state.bulkBodies[0]).toMatchObject({
      action: 'instant', description: 'One import',
      private_tags: { user: ['tax'], organization: [] },
    });
    expect(state.bulkBodies[0]).not.toHaveProperty('recipient_email');
    expect(state.bulkBodies[0]).not.toHaveProperty('fingerprint_provided');
  });

  it('rejects more than 100 rows before submitting any row', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      fingerprint: index.toString(16).padStart(64, '0'),
      filename: `${index}.pdf`,
      fingerprint_provided: false,
    }));
    const response = await request(app()).post('/bulk').send({ org_id: null, action: 'queue', rows });
    expect(response.status).toBe(400);
    expect(state.bulkBodies).toEqual([]);
  });

  it('rejects recipient_name without recipient_email before submitting any row', async () => {
    const response = await request(app()).post('/bulk').send({
      org_id: null,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_name: 'Recipient Only',
      }],
    });
    expect(response.status).toBe(400);
    expect(state.bulkBodies).toEqual([]);
  });

  it('rejects recipient provisioning before any anchor/auth work for a non-admin member', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.membershipRole = 'member';
    const response = await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_email: 'recipient@example.test',
      }],
    });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('recipient_provisioning_forbidden');
    expect(state.bulkBodies).toEqual([]);
    expect(state.linkRecipient).not.toHaveBeenCalled();
  });

  it('derives the API-key import tenant and rejects a caller-chosen mismatch', async () => {
    const api = express();
    api.use(express.json());
    api.use((req, _res, next) => {
      req.apiKey = {
        keyId: 'key-1', keyPrefix: 'arkv_', userId: 'user-1',
        orgId: '22222222-2222-4222-8222-222222222222', scopes: ['anchor:write'], rateLimitTier: 'paid',
      };
      next();
    });
    api.post('/api/v1/anchor/import', handleAnchorImport);
    const row = { fingerprint: 'a'.repeat(64), filename: 'one.pdf', fingerprint_provided: true };

    const accepted = await request(api).post('/api/v1/anchor/import').send({ action: 'queue', rows: [row] });
    expect(accepted.status).toBe(200);
    expect(state.bulkBodies).toHaveLength(1);

    const denied = await request(api).post('/api/v1/anchor/import').send({
      org_id: '33333333-3333-4333-8333-333333333333', action: 'queue', rows: [row],
    });
    expect(denied.status).toBe(403);
    expect(state.bulkBodies).toHaveLength(1);
  });
});
