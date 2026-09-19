import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  profileOrg: null as string | null,
  membership: true,
  captured: null as null | { orgId: string | null; body: Record<string, unknown> },
}));
vi.mock('../api/v1/anchor-submit.js', () => ({
  anchorSubmitRouter: (req: { apiKey?: { orgId: string | null }; body: Record<string, unknown> }, res: { json: (value: unknown) => void }) => {
    state.captured = { orgId: req.apiKey?.orgId ?? null, body: req.body };
    res.json({ ok: true });
  },
}));
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn((table: string) => ({
  select: vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: state.membership ? { id: 'membership' } : null, error: null })) })),
      maybeSingle: vi.fn(async () => ({ data: table === 'profiles' ? { org_id: state.profileOrg } : null, error: null })),
    })),
  })),
})) } }));

import { anchorSelfServiceRouter } from './anchor-self-service.js';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => { req.userId = '11111111-1111-4111-8111-111111111111'; next(); });
  instance.use(anchorSelfServiceRouter);
  return instance;
}

describe('anchor self-service context bridge', () => {
  beforeEach(() => { state.profileOrg = null; state.membership = true; state.captured = null; });

  it('passes personal scope as null and preserves validated UI metadata/tags', async () => {
    const body = { fingerprint: 'a'.repeat(64), action: 'instant', org_id: null, metadata: { ai_summary: 'safe', fraud_score: 0.1 }, private_tags: { user: ['tax'], organization: [] } };
    const response = await request(app()).post('/').send(body);
    expect(response.status).toBe(200);
    expect(state.captured).toEqual({ orgId: null, body: { ...body, org_id: undefined } });
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
});
