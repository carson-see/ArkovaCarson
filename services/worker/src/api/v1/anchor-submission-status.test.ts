import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  anchors: [] as Array<Record<string, unknown>>,
  intents: [] as Array<Record<string, unknown>>,
  anchorError: null as unknown,
  intentError: null as unknown,
}));

function query(table: string) {
  const filters: Array<{ kind: 'eq' | 'is'; column: string; value: unknown }> = [];
  const chain: Record<string, unknown> = {};
  chain.eq = vi.fn((column: string, value: unknown) => { filters.push({ kind: 'eq', column, value }); return chain; });
  chain.is = vi.fn((column: string, value: unknown) => { filters.push({ kind: 'is', column, value }); return chain; });
  chain.maybeSingle = vi.fn(async () => {
    const error = table === 'anchors' ? state.anchorError : state.intentError;
    const rows = table === 'anchors' ? state.anchors : state.intents;
    const matches = rows.filter((row) => filters.every((filter) => (
      filter.kind === 'is' ? (row[filter.column] ?? null) === filter.value : row[filter.column] === filter.value
    )));
    return { data: matches[0] ?? null, error };
  });
  return chain;
}

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => query(table)),
    })),
    rpc: vi.fn(),
  },
}));
vi.mock('../../config.js', () => ({ config: { enableInstantSecure: true, enableProfessionalEducationSchemaReady: true } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../middleware/perOrgRateLimit.js', () => ({ requireOrgQuota: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../../utils/jobQueue.js', () => ({ submitJob: vi.fn() }));
vi.mock('../../lib/urls.js', () => ({ buildVerifyUrl: (id: string) => `https://example.test/verify/${id}` }));

import { anchorSubmitRouter } from './anchor-submit.js';
import { requireScope } from '../../middleware/apiKeyAuth.js';

function app(orgId: string | null = '22222222-2222-4222-8222-222222222222') {
  const instance = express();
  instance.use((req, _res, next) => {
    req.apiKey = {
      keyId: 'key', keyPrefix: 'ak_test', userId: '11111111-1111-4111-8111-111111111111',
      orgId: orgId as string, scopes: ['anchor:write'], rateLimitTier: 'paid',
    };
    next();
  });
  instance.use(anchorSubmitRouter);
  return instance;
}

describe('GET /:publicId/submission-status', () => {
  beforeEach(() => {
    state.anchorError = null;
    state.intentError = null;
    state.anchors = [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', public_id: 'ARK-1', status: 'PENDING',
      user_id: '11111111-1111-4111-8111-111111111111',
      org_id: '22222222-2222-4222-8222-222222222222', deleted_at: null,
      updated_at: '2026-09-19T00:00:00Z', metadata: { securing_path: 'instant' },
    }];
    state.intents = [{
      anchor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'NEEDS_CREDIT', debit_reason: null, updated_at: '2026-09-19T00:01:00Z',
    }];
  });

  it('returns bounded retryable NEEDS_CREDIT state without private or internal fields', async () => {
    const response = await request(app()).get('/ARK-1/submission-status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      public_id: 'ARK-1', action: 'instant', anchor_status: 'PENDING', credit_state: 'pending',
      instant_status: 'NEEDS_CREDIT', retryable: true, updated_at: '2026-09-19T00:01:00Z',
    });
    expect(JSON.stringify(response.body)).not.toMatch(/anchor_id|org_id|user_id|debit_reason|tag|metadata/);
  });

  it.each([
    ['PROCESSING', 'spent'],
    ['HELD', 'spent'],
    ['SUBMITTED', 'spent'],
    ['FAILED', 'refunded'],
  ])('maps %s conservatively to %s', async (status, creditState) => {
    state.intents = [{ anchor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status, debit_reason: 'anchor.instant.intent.1', updated_at: '2026-09-19T00:02:00Z' }];
    const response = await request(app()).get('/ARK-1/submission-status');
    expect(response.body).toMatchObject({ instant_status: status, credit_state: creditState, retryable: false });
  });

  it.each([
    ['wrong owner', { user_id: '99999999-9999-4999-8999-999999999999' }, '22222222-2222-4222-8222-222222222222'],
    ['sibling org', { org_id: '33333333-3333-4333-8333-333333333333' }, '22222222-2222-4222-8222-222222222222'],
    ['org row from personal scope', { org_id: '22222222-2222-4222-8222-222222222222' }, null],
    ['deleted row', { deleted_at: '2026-09-18T00:00:00Z' }, '22222222-2222-4222-8222-222222222222'],
  ])('returns the bounded 404 for a %s', async (_name, changes, callerOrg) => {
    state.anchors = [{ ...state.anchors[0], ...changes }];
    const response = await request(app(callerOrg)).get('/ARK-1/submission-status');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'submission_not_found' });
  });

  it('fails closed on an unknown persisted intent status', async () => {
    state.intents = [{ ...state.intents[0], status: 'SURPRISE' }];
    const response = await request(app()).get('/ARK-1/submission-status');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'submission_status_unavailable' });
  });

  it('requires authentication and anchor write scope when mounted canonically', async () => {
    const unauthenticated = express().use(requireScope('anchor:write'), anchorSubmitRouter);
    expect((await request(unauthenticated).get('/ARK-1/submission-status')).status).toBe(401);

    const wrongScope = express().use((req, _res, next) => {
      req.apiKey = {
        keyId: 'key', keyPrefix: 'ak_test', userId: '11111111-1111-4111-8111-111111111111',
        orgId: '22222222-2222-4222-8222-222222222222', scopes: ['anchor:read'], rateLimitTier: 'paid',
      };
      next();
    }).use(requireScope('anchor:write'), anchorSubmitRouter);
    expect((await request(wrongScope).get('/ARK-1/submission-status')).status).toBe(403);
  });

  it('fails closed on either status read error', async () => {
    state.intentError = { message: 'database unavailable' };
    const response = await request(app()).get('/ARK-1/submission-status');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'submission_status_unavailable' });
  });
});
