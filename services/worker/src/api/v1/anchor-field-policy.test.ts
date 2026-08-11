/**
 * DPA clause 4.6 — org-scoped field rejection, enforced on BOTH anchor write
 * paths.
 *
 * `POST /api/v1/anchor` (single) and `POST /api/v1/anchor/bulk` (HAKI-REQ-02,
 * the endpoint the partner actually integrates against) both accepted
 * `description` identically for every org. Where a DPA permits only a
 * fingerprint, a non-identifying matter reference and a credential type, and
 * obliges Arkova to reject prohibited fields INDEPENDENTLY of the counterparty
 * agreeing to stop sending them, "the partner will stop sending it" is not a
 * control. This suite is the control.
 *
 * These tests drive the REAL enforcement path (`enforceOrgFieldPolicy`) through
 * the real routers; only the Supabase read of `organization_field_policies` is
 * stubbed, dispatched by table name.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockConfig = vi.hoisted(() => ({
  enableOrgCreditEnforcement: false,
  enableProfessionalEducationSchemaReady: true,
}));
const mockState = vi.hoisted(() => ({
  /** Row returned for organization_field_policies, or null for "no policy". */
  policyRow: null as Record<string, unknown> | null,
  /** Anchors inserted through the routers during a test. */
  inserts: [] as unknown[],
  /** Reads of the policy table, to prove the guard actually consulted it. */
  policyReads: 0,
}));

vi.mock('../../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));
vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../../lib/urls.js', () => ({
  buildVerifyUrl: (id: string) => `https://example.test/verify/${id}`,
}));
vi.mock('../../utils/jobQueue.js', () => ({
  submitJob: vi.fn().mockResolvedValue('job-1'),
}));
vi.mock('../../middleware/perOrgRateLimit.js', () => ({
  requireOrgQuota: () => async (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../utils/orgCredits.js', () => ({
  deductOrgCredit: vi.fn().mockResolvedValue({ allowed: true }),
}));

// One db double for every table these routes touch, dispatched by table name.
vi.mock('../../utils/db.js', () => {
  const makeChain = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = vi.fn(self);
    chain.eq = vi.fn(self);
    chain.is = vi.fn(self);
    chain.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
    // Duplicate-check terminal on the bulk path.
    chain.in = vi.fn(() => Promise.resolve({ data: [], error: null }));
    chain.maybeSingle = vi.fn(() => {
      if (table === 'organization_field_policies') {
        mockState.policyReads += 1;
        return Promise.resolve({ data: mockState.policyRow, error: null });
      }
      // anchors dedup lookup — never a duplicate in these tests.
      return Promise.resolve({ data: null, error: null });
    });
    chain.insert = vi.fn((payload: unknown) => {
      mockState.inserts.push(payload);
      return chain;
    });
    chain.single = vi.fn(() =>
      Promise.resolve({
        data: {
          id: 'anchor-uuid',
          public_id: 'ARK-2026-TEST0001',
          fingerprint: 'a'.repeat(64),
          status: 'PENDING',
          created_at: '2026-08-10T00:00:00.000Z',
          credential_type: 'LEGAL',
          metadata: null,
        },
        error: null,
      }),
    );
    chain.delete = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
    return chain;
  };
  return { db: { from: vi.fn((table: string) => makeChain(table)), rpc: vi.fn() } };
});

import { anchorSubmitRouter } from './anchor-submit.js';
import { anchorBulkRouter } from './anchor-bulk.js';
import { clearOrgFieldPolicyCache, ORG_FIELD_POLICY_REJECTED_ERROR } from '../../utils/orgFieldPolicy.js';

const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);

const HAKI_POLICY_ROW = {
  org_id: 'org-1',
  disallowed_fields: ['description'],
  enabled: true,
  policy_reason:
    'DPA Schedule 1 permits the document fingerprint, a non-identifying matter reference and credential type only.',
  contract_reference: 'DPA Schedule 1 / clause 4.6',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { apiKey?: unknown }).apiKey = {
      keyId: 'key-1',
      userId: 'user-1',
      orgId: 'org-1',
      scopes: ['anchor:write'],
      rateLimitTier: 'paid',
      keyPrefix: 'arkv_test_',
    };
    next();
  });
  app.use('/api/v1/anchor/bulk', anchorBulkRouter);
  app.use('/api/v1/anchor', anchorSubmitRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearOrgFieldPolicyCache();
  mockState.policyRow = null;
  mockState.inserts = [];
  mockState.policyReads = 0;
});

describe('POST /api/v1/anchor (single) — org field policy', () => {
  it('REJECTS description with 400 for a policy-configured org, and inserts nothing', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    const res = await request(buildApp())
      .post('/api/v1/anchor')
      .send({ fingerprint: FINGERPRINT, credential_type: 'LEGAL', description: 'client matter note' })
      .expect(400);

    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(res.body.details).toEqual([
      expect.objectContaining({ path: 'description', code: ORG_FIELD_POLICY_REJECTED_ERROR }),
    ]);
    expect(res.body.message).toMatch(/not permitted/i);
    expect(mockState.inserts).toHaveLength(0);
    expect(mockState.policyReads).toBeGreaterThan(0);
  });

  it('surfaces the contractual reason so the integrator can act on it', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    const res = await request(buildApp())
      .post('/api/v1/anchor')
      .send({ fingerprint: FINGERPRINT, description: 'x' })
      .expect(400);
    expect(res.body.policy_reason).toBe(HAKI_POLICY_ROW.policy_reason);
  });

  it('never echoes the rejected value back', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    const secret = 'Wanjiku-v-Republic-confidential';
    const res = await request(buildApp())
      .post('/api/v1/anchor')
      .send({ fingerprint: FINGERPRINT, description: secret })
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('REJECTS the metadata-nested bypass', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    const res = await request(buildApp())
      .post('/api/v1/anchor')
      .send({ fingerprint: FINGERPRINT, metadata: { description: 'client matter note' } })
      .expect(400);
    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(res.body.details[0].path).toBe('metadata.description');
    expect(mockState.inserts).toHaveLength(0);
  });

  it('REJECTS a differently-cased key (400, never a silent accept)', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    const res = await request(buildApp())
      .post('/api/v1/anchor')
      .send({ fingerprint: FINGERPRINT, Description: 'client matter note' })
      .expect(400);
    expect(mockState.inserts).toHaveLength(0);
    // Either the strict-schema unknown-key rejection or the policy rejection is
    // acceptable — what is NOT acceptable is a 2xx.
    expect(['invalid_request', ORG_FIELD_POLICY_REJECTED_ERROR]).toContain(res.body.error);
  });

  it('leaves an org WITHOUT a policy completely unaffected (24,907-anchor regression guard)', async () => {
    mockState.policyRow = null;
    const res = await request(buildApp())
      .post('/api/v1/anchor')
      .send({ fingerprint: FINGERPRINT, credential_type: 'LEGAL', description: 'perfectly fine' })
      .expect(201);

    expect(res.body.public_id).toBe('ARK-2026-TEST0001');
    expect(mockState.inserts).toHaveLength(1);
    expect((mockState.inserts[0] as { description?: string }).description).toBe('perfectly fine');
  });

  it('accepts the three permitted fields for the policy-configured org', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    await request(buildApp())
      .post('/api/v1/anchor')
      .send({ fingerprint: FINGERPRINT, credential_type: 'LEGAL', metadata: { matter_or_case_ref: 'HK-2026-114' } })
      .expect(201);
    expect(mockState.inserts).toHaveLength(1);
  });
});

describe('POST /api/v1/anchor/bulk — org field policy (the endpoint HakiChain uses)', () => {
  it('REJECTS a row carrying description with 400, and inserts nothing', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        anchors: [
          { fingerprint: FINGERPRINT, credential_type: 'LEGAL', matter_or_case_ref: 'HK-1' },
          { fingerprint: OTHER_FINGERPRINT, credential_type: 'LEGAL', description: 'client matter note' },
        ],
      })
      .expect(400);

    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(res.body.details).toEqual([
      expect.objectContaining({ path: 'anchors.1.description', code: ORG_FIELD_POLICY_REJECTED_ERROR }),
    ]);
    expect(mockState.inserts).toHaveLength(0);
  });

  it('rejects the WHOLE batch, not just the offending row (no partial acceptance)', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        anchors: [
          { fingerprint: FINGERPRINT, description: 'a' },
          { fingerprint: OTHER_FINGERPRINT, description: 'b' },
        ],
      })
      .expect(400);
    expect(mockState.inserts).toHaveLength(0);
  });

  it('reports every offending row, not only the first', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        anchors: [
          { fingerprint: FINGERPRINT, description: 'a' },
          { fingerprint: OTHER_FINGERPRINT, description: 'b' },
        ],
      })
      .expect(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toEqual([
      'anchors.0.description',
      'anchors.1.description',
    ]);
  });

  it('rejects on dry_run too — validation must tell the truth before the real run', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({ dry_run: true, anchors: [{ fingerprint: FINGERPRINT, description: 'x' }] })
      .expect(400);
    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
  });

  it('leaves an org WITHOUT a policy completely unaffected', async () => {
    mockState.policyRow = null;
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({ anchors: [{ fingerprint: FINGERPRINT, credential_type: 'LEGAL', description: 'fine' }] })
      .expect(201);
    expect(res.body.queued).toBe(1);
    expect(mockState.inserts).toHaveLength(1);
    expect(
      (mockState.inserts[0] as { metadata: Record<string, unknown> }).metadata.description,
    ).toBe('fine');
  });

  it('accepts the three permitted fields for the policy-configured org', async () => {
    mockState.policyRow = HAKI_POLICY_ROW;
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        anchors: [
          { fingerprint: FINGERPRINT, credential_type: 'LEGAL', matter_or_case_ref: 'HK-2026-114' },
        ],
      })
      .expect(201);
    expect(res.body.queued).toBe(1);
  });
});
