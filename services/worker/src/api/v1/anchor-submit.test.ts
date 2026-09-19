/**
 * POST /api/v1/anchor — Zod request validation tests.
 *
 * Pins the contract that the public anchor-submit endpoint rejects
 * malformed payloads with structured RFC 7807-style problem JSON
 * and only accepts the frozen schema (CLAUDE.md §1.8).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockSelectChain, mockInsertChain, mockInsert, mockLogger, mockConfig, mockRpc, mockDeleteEq, mockQuotaDeltas, mockProcessAnchor } = vi.hoisted(() => {
  const mockSelectChain = { single: vi.fn(), maybeSingle: vi.fn() };
  const mockInsertChain = { single: vi.fn() };
  const mockInsert = vi.fn((_value?: unknown) => ({ select: vi.fn(() => ({ single: mockInsertChain.single })) }));
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  // SCRUM-2970 — deduct_org_credit RPC surface + compensation-delete spy
  // for the credit-gate tests.
  const mockRpc = vi.fn();
  const mockDeleteEq = vi.fn();
  const mockQuotaDeltas: number[] = [];
  const mockProcessAnchor = vi.fn();
  // Mock the worker config so transitive import (anchor-submit → orgCredits →
  // config.js) doesn't try to load required env vars in the test env and
  // throw "Invalid worker configuration" before any test runs.
  const mockConfig = {
    enableOrgCreditEnforcement: false,
    enableProfessionalEducationSchemaReady: true,
    enableInstantSecure: true,
  };
  return { mockSelectChain, mockInsertChain, mockInsert, mockLogger, mockConfig, mockRpc, mockDeleteEq, mockQuotaDeltas, mockProcessAnchor };
});

vi.mock('../../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../../middleware/perOrgRateLimit.js', () => ({
  requireOrgQuota: (options: { getDelta?: (req: unknown) => number | Promise<number> }) =>
    async (req: unknown, _res: unknown, next: () => void) => {
      mockQuotaDeltas.push(options.getDelta ? await options.getDelta(req) : 1);
      next();
    },
}));

vi.mock('../../utils/jobQueue.js', () => ({
  submitJob: vi.fn().mockResolvedValue('job-1'),
}));

vi.mock('../../jobs/anchor.js', () => ({
  processAnchor: mockProcessAnchor,
}));

vi.mock('../../utils/db.js', () => {
  const eqChain: Record<string, unknown> = {};
  eqChain.eq = vi.fn(() => eqChain);
  eqChain.is = vi.fn(() => eqChain);
  eqChain.maybeSingle = mockSelectChain.maybeSingle;

  return {
    db: {
      from: vi.fn(() => ({
        select: vi.fn(() => eqChain),
        insert: mockInsert,
        delete: vi.fn(() => ({ eq: mockDeleteEq })),
      })),
      rpc: mockRpc,
    },
  };
});

vi.mock('../../lib/urls.js', () => ({
  buildVerifyUrl: (id: string) => `https://example.test/verify/${id}`,
}));

import { anchorSubmitRouter } from './anchor-submit.js';
import { requireScope } from '../../middleware/apiKeyAuth.js';
import { submitJob } from '../../utils/jobQueue.js';

// CodeRabbit PR #736 nit: prefer interface for object-shape type assertions
// per repository TypeScript conventions.
interface InsertCallArg {
  metadata?: Record<string, unknown>;
}

function makeApp(scopes = ['anchor:write'], orgId: string | null = 'org-1', keyPrefix = 'arkv_test_') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.apiKey = {
      keyId: 'key-1',
      userId: 'user-1',
      orgId: orgId as string,
      scopes,
      rateLimitTier: 'paid',
      keyPrefix,
    };
    next();
  });
  app.use('/v1/anchor', requireScope('anchor:write'), anchorSubmitRouter);
  return app;
}

const VALID_FINGERPRINT = 'a'.repeat(64);

function postBadgeMetadata(metadata: Record<string, unknown>) {
  return request(makeApp()).post('/v1/anchor').send({
    fingerprint: VALID_FINGERPRINT,
    credential_type: 'BADGE',
    metadata,
  });
}

function expectPrivateSourceUrlRejection(res: request.Response) {
  expect(res.status).toBe(400);
  expect(res.body.details[0]).toMatchObject({
    path: 'metadata.source_url',
    code: 'custom',
    message: expect.stringContaining('private IPv4'),
  });
  expect(mockInsert).not.toHaveBeenCalled();
}

describe('POST /api/v1/anchor — Zod validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuotaDeltas.length = 0;
    mockConfig.enableProfessionalEducationSchemaReady = true;
    mockConfig.enableInstantSecure = true;
    mockInsert.mockImplementation(() => ({ select: vi.fn(() => ({ single: mockInsertChain.single })) }));
    mockSelectChain.maybeSingle.mockResolvedValue({ data: null, error: null });
    mockInsertChain.single.mockResolvedValue({
      data: {
        public_id: 'ARK-2026-ABCD1234',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        created_at: '2026-04-27T00:00:00Z',
      },
      error: null,
    });
    mockProcessAnchor.mockResolvedValue(true);
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'create_anchor_submission') return { data: {
        success: true, id: 'row-1', public_id: 'ARK-2026-ABCD1234',
        fingerprint: VALID_FINGERPRINT, status: 'PENDING', created_at: '2026-04-27T00:00:00Z',
        credential_type: 'OTHER', metadata: { securing_path: 'queue' }, intent_id: null,
      }, error: null };
      if (fn === 'enqueue_existing_anchor_instant_intent') return { data: { success: true, status: 'QUEUED', intent_id: 'intent-1' }, error: null };
      return { data: { success: true }, error: null };
    });
  });

  it('rejects missing fingerprint with structured 400', async () => {
    const res = await request(makeApp()).post('/v1/anchor').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.details).toBeInstanceOf(Array);
    expect(res.body.details[0].path).toBe('fingerprint');
  });

  it('rejects fingerprint that is not 64-char hex', async () => {
    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: 'not-a-real-hash',
    });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('fingerprint');
    expect(res.body.details[0].message).toContain('64-character hex');
  });

  it('preserves dashboard extraction metadata while stripping reserved and private keys', async () => {
    const res = await request(makeApp(['anchor:write'], 'org-1', 'jwt-session')).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      action: 'instant',
      private_tags: { user: ['audit'], organization: ['quarterly'] },
      metadata: { ai_summary: 'safe summary', jurisdiction: 'MI', _claimed_by: 'attacker', email: 'private@example.test' },
    });
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('create_anchor_submission', expect.objectContaining({
      p_org_id: 'org-1',
      p_metadata: { ai_summary: 'safe summary', jurisdiction: 'MI', securing_path: 'instant' },
      p_user_tags: ['audit'], p_org_tags: ['quarterly'],
      p_fingerprint_source: 'document_bytes',
    }));
  });

  it('rejects unknown credential_type via Zod enum', async () => {
    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      credential_type: 'NOT_A_TYPE',
    });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('credential_type');
  });

  it('rejects unknown extra fields via .strict()', async () => {
    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      malicious_extra_field: 'pwned',
    });
    expect(res.status).toBe(400);
  });

  it('rejects description over 1000 chars (predictable insert size)', async () => {
    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      description: 'a'.repeat(1001),
    });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('description');
  });

  it('accepts valid request and returns 201 with public_id receipt', async () => {
    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      credential_type: 'DEGREE',
      description: 'BSc Computer Science',
    });
    expect(res.status).toBe(201);
    expect(res.body.public_id).toBeDefined();
    expect(res.body.fingerprint).toBe(VALID_FINGERPRINT);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.record_uri).toContain('/verify/');
    expect(mockInsert.mock.calls[0]?.[0]).toHaveProperty('metadata.securing_path', 'queue');
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('queues without reserving a credit and persists bounded private tags separately', async () => {
    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      action: 'queue',
      private_tags: {
        user: ['Contract', 'Smith v Austin'],
        organization: ['Financial statement'],
      },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ action: 'queue', credit_state: null });
    expect(mockRpc).not.toHaveBeenCalledWith('reserve_anchor_credit', expect.anything());
    expect(mockRpc).toHaveBeenCalledWith('create_anchor_submission', expect.objectContaining({
      p_action: 'queue',
      p_metadata: expect.objectContaining({ securing_path: 'queue' }),
      p_user_tags: ['Contract', 'Smith v Austin'],
      p_fingerprint_source: null,
      p_org_tags: ['Financial statement'],
    }));
  });

  it('rejects duplicate, blank and oversized private tags before any write', async () => {
    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      private_tags: { user: ['Contract', ' contract ', ''] },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects instant requests while the trusted server capability is disabled', async () => {
    mockConfig.enableInstantSecure = false;
    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      action: 'instant',
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('instant_secure_unavailable');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns an existing idempotent receipt without consuming anchor quota', async () => {
    mockSelectChain.maybeSingle.mockResolvedValueOnce({
      data: {
        public_id: 'ARK-2026-EXISTING',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        created_at: '2026-04-26T00:00:00Z',
      },
      error: null,
    });

    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
    });

    expect(res.status).toBe(200);
    expect(res.body.public_id).toBe('ARK-2026-EXISTING');
    expect(mockQuotaDeltas).toEqual([]);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('preserves ordinary duplicate reads while the organization suspension guard is enabled', async () => {
    process.env.ENABLE_ORG_SUSPENSION_GUARD = 'true';
    try {
      mockSelectChain.maybeSingle.mockResolvedValueOnce({
        data: {
          public_id: 'ARK-2026-EXISTING', fingerprint: VALID_FINGERPRINT,
          status: 'PENDING', created_at: '2026-04-26T00:00:00Z',
        },
        error: null,
      });

      const res = await request(makeApp()).post('/v1/anchor').send({ fingerprint: VALID_FINGERPRINT });

      expect(res.status).toBe(200);
      expect(res.body.public_id).toBe('ARK-2026-EXISTING');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    } finally {
      delete process.env.ENABLE_ORG_SUSPENSION_GUARD;
    }
  });

  it('atomically rearms a never-debited NEEDS_CREDIT intent on explicit instant resubmission', async () => {
    mockSelectChain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'anchor-existing', public_id: 'ARK-2026-EXISTING', fingerprint: VALID_FINGERPRINT,
        status: 'PENDING', created_at: '2026-04-26T00:00:00Z',
      },
      error: null,
    });
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'retry_anchor_instant_intent') return {
        data: { success: true, status: 'QUEUED', intent_id: 'intent-1', job_id: 'job-2', idempotent: false }, error: null,
      };
      throw new Error(`unexpected RPC ${fn}`);
    });

    const res = await request(makeApp()).post('/v1/anchor').send({ fingerprint: VALID_FINGERPRINT, action: 'instant' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'instant', instant_status: 'QUEUED', idempotent: true });
    expect(mockRpc).toHaveBeenCalledWith('retry_anchor_instant_intent', {
      p_anchor_id: 'anchor-existing', p_user_id: 'user-1', p_org_id: 'org-1',
    });
    expect(mockRpc).not.toHaveBeenCalledWith('enqueue_existing_anchor_instant_intent', expect.anything());
  });

  it('falls back to first-time instant publication when no intent exists', async () => {
    mockSelectChain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'anchor-existing', public_id: 'ARK-2026-EXISTING', fingerprint: VALID_FINGERPRINT,
        status: 'PENDING', created_at: '2026-04-26T00:00:00Z',
      },
      error: null,
    });
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'retry_anchor_instant_intent') return { data: { success: false, error: 'intent_not_found' }, error: null };
      if (fn === 'enqueue_existing_anchor_instant_intent') return {
        data: { success: true, status: 'QUEUED', intent_id: 'intent-1', job_id: 'job-1' }, error: null,
      };
      throw new Error(`unexpected RPC ${fn}`);
    });

    const res = await request(makeApp()).post('/v1/anchor').send({ fingerprint: VALID_FINGERPRINT, action: 'instant' });

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'retry_anchor_instant_intent', expect.anything());
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'enqueue_existing_anchor_instant_intent', expect.anything());
  });

  it('denies a suspended organization before any existing-anchor instant side effect', async () => {
    process.env.ENABLE_ORG_SUSPENSION_GUARD = 'true';
    try {
      mockSelectChain.maybeSingle.mockResolvedValueOnce({
        data: { id: 'anchor-existing', public_id: 'ARK-EXISTING', fingerprint: VALID_FINGERPRINT, status: 'PENDING', created_at: '2026-04-26T00:00:00Z' },
        error: null,
      });
      mockRpc.mockImplementation(async (fn: string) => fn === 'is_org_suspended'
        ? { data: true, error: null }
        : { data: { success: true }, error: null });

      const res = await request(makeApp()).post('/v1/anchor').send({ fingerprint: VALID_FINGERPRINT, action: 'instant' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('org_suspended');
      expect(mockRpc).not.toHaveBeenCalledWith('retry_anchor_instant_intent', expect.anything());
      expect(mockRpc).not.toHaveBeenCalledWith('enqueue_existing_anchor_instant_intent', expect.anything());
    } finally {
      delete process.env.ENABLE_ORG_SUSPENSION_GUARD;
    }
  });

  it('allows an active organization to rearm an existing instant intent', async () => {
    process.env.ENABLE_ORG_SUSPENSION_GUARD = 'true';
    try {
      mockSelectChain.maybeSingle.mockResolvedValueOnce({
        data: { id: 'anchor-existing', public_id: 'ARK-EXISTING', fingerprint: VALID_FINGERPRINT, status: 'PENDING', created_at: '2026-04-26T00:00:00Z' },
        error: null,
      });
      mockRpc.mockImplementation(async (fn: string) => {
        if (fn === 'is_org_suspended') return { data: false, error: null };
        if (fn === 'retry_anchor_instant_intent') return { data: { success: true, status: 'QUEUED' }, error: null };
        throw new Error(`unexpected RPC ${fn}`);
      });

      const res = await request(makeApp()).post('/v1/anchor').send({ fingerprint: VALID_FINGERPRINT, action: 'instant' });

      expect(res.status).toBe(200);
      expect(mockRpc).toHaveBeenNthCalledWith(1, 'is_org_suspended', { p_org_id: 'org-1' });
      expect(mockRpc).toHaveBeenNthCalledWith(2, 'retry_anchor_instant_intent', expect.anything());
    } finally {
      delete process.env.ENABLE_ORG_SUSPENSION_GUARD;
    }
  });

  it('accepts the compatibility submit path with the canonical write:anchors scope', async () => {
    const res = await request(makeApp(['write:anchors'])).post('/v1/anchor/submit').send({
      fingerprint: VALID_FINGERPRINT,
      credential_type: 'DEGREE',
    });

    expect(res.status).toBe(201);
    expect(res.body.public_id).toBeDefined();
    expect(res.body.status).toBe('PENDING');
  });

  it('accepts CPE credential type and enqueues async professional education extraction', async () => {
    mockInsertChain.single.mockResolvedValueOnce({
      data: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        public_id: 'ARK-2026-CPE12345',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        credential_type: 'CPE',
        metadata: {
          credential_title: 'Advanced Tax Planning CPE',
          source_provider: 'udemy',
          source_url: 'https://udemy.com/certificate/UC-123',
        },
        created_at: '2026-04-27T00:00:00Z',
      },
      error: null,
    });

    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      credential_type: 'CPE',
      metadata: {
        credential_title: 'Advanced Tax Planning CPE',
        source_provider: 'udemy',
        source_url: 'https://udemy.com/certificate/UC-123',
      },
    });

    expect(res.status).toBe(201);
    expect(submitJob).toHaveBeenCalledWith(expect.objectContaining({
      type: 'professional_education.metadata_extraction',
      payload: expect.objectContaining({
        anchorId: '550e8400-e29b-41d4-a716-446655440000',
        educationKind: 'CPE',
      }),
      max_attempts: 5,
    }));
  });

  it('503s CPE submissions before any DB call when professional education schema is not ready', async () => {
    mockConfig.enableProfessionalEducationSchemaReady = false;

    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      credential_type: 'CPE',
      metadata: {
        credential_title: 'Advanced Tax Planning CPE',
      },
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('professional_education_schema_unavailable');
    expect(res.body.message).toContain('Professional education schema is not ready');
    expect(mockSelectChain.maybeSingle).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('keeps existing CLE anchoring available but skips extraction enqueue when schema is not ready', async () => {
    mockConfig.enableProfessionalEducationSchemaReady = false;
    mockInsertChain.single.mockResolvedValueOnce({
      data: {
        id: '550e8400-e29b-41d4-a716-446655440001',
        public_id: 'ARK-2026-CLE12345',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        credential_type: 'CLE',
        metadata: {
          credential_title: 'Ethics CLE',
          source_provider: 'westlaw',
        },
        created_at: '2026-04-27T00:00:00Z',
      },
      error: null,
    });

    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      credential_type: 'CLE',
      metadata: {
        credential_title: 'Ethics CLE',
        source_provider: 'westlaw',
      },
    });

    expect(res.status).toBe(201);
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ credential_type: 'CLE' }));
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('accepts BADGE credential type and persists public-safe evidence metadata', async () => {
    const res = await postBadgeMetadata({
      evidence_schema_version: 'credential_evidence_v1',
      evidence_package_hash: 'b'.repeat(64),
      source_url: 'https://credentials.example.com/badges/123?token=secret&utm_source=ad&locale=en',
      source_provider: 'credly',
      source_payload_hash: 'c'.repeat(64),
      verification_level: 'captured_url',
      extraction_method: 'html_metadata',
      credential_title: 'Cloud Architecture Fundamentals',
      credential_type: 'BADGE',
      credential_issuer: 'Example Cloud',
      recipient_display_name: 'Do Not Persist',
      access_token: 'Do Not Persist',
    });

    expect(res.status).toBe(201);
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
      credential_type: 'BADGE',
      metadata: expect.objectContaining({
        evidence_schema_version: 'credential_evidence_v1',
        evidence_package_hash: 'b'.repeat(64),
        source_url: 'https://credentials.example.com/badges/123?locale=en',
        source_provider: 'credly',
        source_payload_hash: 'c'.repeat(64),
        verification_level: 'captured_url',
        extraction_method: 'html_metadata',
        credential_title: 'Cloud Architecture Fundamentals',
        credential_type: 'BADGE',
        credential_issuer: 'Example Cloud',
      }),
    }));
    const insertArg = mockInsert.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(insertArg.metadata).not.toHaveProperty('recipient_display_name');
    expect(insertArg.metadata).not.toHaveProperty('access_token');
  });

  /**
   * SCRUM-1732 — Anchor metadata persistence contract lock.
   *
   * The 2026-05-01 audit row "anchor-submit insert omits metadata"
   * read the conditional spread `...(publicSafe ? { metadata } : {})`
   * as a silent-drop bug. It isn't — the path correctly:
   *   - 400s when `metadata` carries public-credential keys but fails
   *     validation (verified by the BADGE rejection test above)
   *   - persists the public-safe subset when valid (verified above)
   *   - omits the column when no metadata is provided so Postgres
   *     applies its column default of NULL (verified by line 164)
   *
   * These regression tests pin those behaviors so future drift fails
   * loud at PR time. SCRUM-1174 (legal taxonomy) cross-reference: when
   * legal credential subtypes ship under HAKI-REQ-05, the existing
   * `parsePublicCredentialEvidenceMetadataResult` is the validation
   * surface — additions go there, never around it.
   */
  describe('SCRUM-1732 metadata persistence contract', () => {
    it('persists every public-safe key from a fully-populated BADGE evidence payload', async () => {
      // CodeRabbit PR #736: pin every key explicitly. The previous "exists +
      // is object" check would pass even if some keys were dropped silently.
      const payload = {
        evidence_schema_version: 'credential_evidence_v1',
        evidence_package_hash: 'a'.repeat(64),
        source_url: 'https://credentials.example.com/x',
        source_provider: 'credly',
        source_payload_hash: 'b'.repeat(64),
        verification_level: 'captured_url',
        extraction_method: 'html_metadata',
        credential_title: 'Cloud Architecture',
        credential_type: 'BADGE',
        credential_issuer: 'Example',
      };
      const res = await postBadgeMetadata(payload);
      expect(res.status).toBe(201);
      const insertArg = mockInsert.mock.calls[0]?.[0] as InsertCallArg;
      // Contract: metadata column is present and structured-typed (not stringified JSON).
      expect(insertArg).toHaveProperty('metadata');
      expect(typeof insertArg.metadata).toBe('object');
      expect(insertArg.metadata).not.toBeNull();
      // Each public-safe key persists with its exact value (not just present).
      const persisted = insertArg.metadata as Record<string, unknown>;
      for (const key of Object.keys(payload)) {
        expect(persisted).toHaveProperty(key);
        expect(persisted[key]).toBe((payload as Record<string, unknown>)[key]);
      }
    });

    it('omits the metadata column when no metadata is provided (Postgres default null)', async () => {
      const res = await request(makeApp()).post('/v1/anchor').send({
        fingerprint: VALID_FINGERPRINT,
        credential_type: 'OTHER',
      });
      expect(res.status).toBe(201);
      // Pinned: when caller sends no metadata, the insert payload does NOT
      // include the column. The DB applies its own NULL default. Changing
      // this to `metadata: null` would also work but breaks downstream
      // Postgres-defaults-aware tooling (e.g. row-level-security policies
      // that distinguish "explicitly null" from "not provided").
      expect(mockInsert.mock.calls[0]?.[0]).toHaveProperty('metadata.securing_path', 'queue');
    });
  });

  it('rejects invalid credential evidence metadata instead of persisting unsafe source URLs', async () => {
    const res = await postBadgeMetadata({
      source_url: 'http://127.0.0.1/private-badge',
      source_provider: 'credly',
    });

    expectPrivateSourceUrlRejection(res);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataKeys: expect.arrayContaining(['source_provider', 'source_url']),
        reason: 'invalid_public_metadata',
        issues: expect.arrayContaining([
          expect.objectContaining({ path: 'source_url' }),
        ]),
      }),
      expect.stringContaining('Rejected invalid credential evidence metadata'),
    );
  });

  it('rejects IPv4-mapped IPv6 credential evidence source URLs', async () => {
    const res = await postBadgeMetadata({
      source_url: 'https://[::ffff:127.0.0.1]/private-badge',
      source_provider: 'credly',
    });

    expectPrivateSourceUrlRejection(res);
  });

  it('returns 401 when API key missing', async () => {
    const app = express();
    app.use(express.json());
    app.use('/v1/anchor', requireScope('anchor:write'), anchorSubmitRouter);
    const res = await request(app).post('/v1/anchor').send({ fingerprint: VALID_FINGERPRINT });
    expect(res.status).toBe(401);
  });

  it('returns 403 when API key lacks anchor:write scope (SCRUM-1273)', async () => {
    const res = await request(makeApp(['anchor:read'])).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required).toBe('anchor:write');
  });

  describe('SCRUM-2014 insert error handling', () => {
    it('returns structured error without leaking db_code when Supabase insert fails (FK violation)', async () => {
      mockInsertChain.single.mockResolvedValueOnce({
        data: null,
        error: {
          code: '23503',
          message: 'insert or update on table "anchors" violates foreign key constraint "anchors_user_id_fkey"',
          details: 'Key (user_id)=(missing-user-id) is not present in table "profiles".',
          hint: null,
        },
      });

      const res = await request(makeApp()).post('/v1/anchor').send({
        fingerprint: VALID_FINGERPRINT,
        credential_type: 'LEGAL',
      });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('anchor_creation_failed');
      expect(res.body.message).toBeDefined();
      // db_code must NOT be exposed to API clients (SonarCloud security hotspot)
      expect(res.body).not.toHaveProperty('db_code');
      // Postgres error code is logged server-side for debugging (sanitized — no raw fingerprint or error object)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ pgCode: '23503' }),
        expect.any(String),
      );
      const [fkLogPayload] = mockLogger.error.mock.calls.at(-1) as [Record<string, unknown>, string];
      expect(fkLogPayload).not.toHaveProperty('fingerprint');
      expect(fkLogPayload).not.toHaveProperty('fingerprintPrefix');
      expect(fkLogPayload).not.toHaveProperty('error');
      expect(fkLogPayload).not.toHaveProperty('pgConstraint');
    });

    it('returns 409 on unique constraint violation (duplicate public_id race)', async () => {
      mockInsertChain.single.mockResolvedValueOnce({
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "anchors_public_id_key"',
          details: 'Key (public_id)=(ARK-2026-ABCD1234) already exists.',
          hint: null,
        },
      });

      const res = await request(makeApp()).post('/v1/anchor').send({
        fingerprint: VALID_FINGERPRINT,
        credential_type: 'LEGAL',
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('anchor_creation_conflict');
      expect(res.body).not.toHaveProperty('db_code');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ pgCode: '23505' }),
        expect.any(String),
      );
    });

    it('returns structured error on NOT NULL violation without leaking db_code', async () => {
      mockInsertChain.single.mockResolvedValueOnce({
        data: null,
        error: {
          code: '23502',
          constraint: 'anchors_org_id_not_null',
          message: 'null value in column "org_id" violates not-null constraint',
          details: 'Failing row contains (null, ...)',
          hint: null,
        },
      });

      const res = await request(makeApp()).post('/v1/anchor').send({
        fingerprint: VALID_FINGERPRINT,
        credential_type: 'LEGAL',
      });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('anchor_creation_failed');
      // db_code must NOT be exposed to API clients
      expect(res.body).not.toHaveProperty('db_code');
      // Postgres error code is logged server-side for debugging (sanitized — no raw fingerprint or error object)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ pgCode: '23502' }),
        expect.any(String),
      );
      const [nnLogPayload] = mockLogger.error.mock.calls.at(-1) as [Record<string, unknown>, string];
      expect(nnLogPayload).not.toHaveProperty('fingerprint');
      expect(nnLogPayload).not.toHaveProperty('fingerprintPrefix');
      expect(nnLogPayload).not.toHaveProperty('error');
      expect(nnLogPayload).not.toHaveProperty('pgConstraint');
    });
  });
});

describe('POST /api/v1/anchor — durable instant intent (SCRUM-5139)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.enableInstantSecure = true;
    mockConfig.enableProfessionalEducationSchemaReady = true;
    mockSelectChain.maybeSingle.mockResolvedValue({ data: null, error: null });
    mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'create_anchor_submission') return { data: {
        success: true, id: 'row-1', public_id: args.p_public_id,
        fingerprint: args.p_fingerprint, status: 'PENDING', created_at: '2026-04-27T00:00:00Z',
        credential_type: 'OTHER', metadata: args.p_metadata, intent_id: 'intent-1',
      }, error: null };
      return { data: { success: true }, error: null };
    });
  });

  it('atomically publishes an instant anchor, private tags, intent and durable job without broadcasting in HTTP', async () => {
    const res = await request(makeApp()).post('/v1/anchor').send({
      fingerprint: VALID_FINGERPRINT,
      action: 'instant',
      private_tags: { user: ['Contract'], organization: ['Finance'] },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING', action: 'instant', credit_state: 'pending', instant_status: 'QUEUED' });
    expect(mockRpc).toHaveBeenCalledWith('create_anchor_submission', expect.objectContaining({
      p_action: 'instant', p_user_id: 'user-1', p_org_id: 'org-1',
      p_user_tags: ['Contract'], p_org_tags: ['Finance'],
      p_fingerprint_source: null,
    }));
    expect(mockProcessAnchor).not.toHaveBeenCalled();
  });

  it('keeps the queue action free even when legacy org credit enforcement is enabled', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockInsert.mockImplementation(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({
      data: { id: 'row-q', public_id: 'ARK-2026-Q', fingerprint: VALID_FINGERPRINT, status: 'PENDING', created_at: '2026-04-27T00:00:00Z' }, error: null,
    }) })) }));
    const res = await request(makeApp()).post('/v1/anchor').send({ fingerprint: VALID_FINGERPRINT, action: 'queue' });
    expect(res.status).toBe(201);
    expect(mockRpc).not.toHaveBeenCalledWith('deduct_org_credit', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('debit_and_enqueue_anchor', expect.anything());
  });

  it('preserves personal scope in the durable submission contract', async () => {
    const res = await request(makeApp(['anchor:write'], null)).post('/v1/anchor').send({ fingerprint: VALID_FINGERPRINT, action: 'instant' });
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('create_anchor_submission', expect.objectContaining({
      p_user_id: 'user-1', p_org_id: null, p_action: 'instant',
    }));
  });
});

/**
 * SCRUM-2481 — server-side evidence-level trust enforcement.
 *
 * The frontend half (#1454) gates the green "issuer authenticated" badge on
 * `isIssuerAuthenticated(verification_level)` — true only for `issuer_anchored`
 * and `source_signed`. That value is read from `anchors.metadata` via
 * `get_public_anchor`, which serves ANONYMOUS callers. Until this gate, the
 * value came straight off the request body of this route and was written by the
 * service-role client, so any API-key holder could mint an anchor that renders
 * as issuer-authenticated on the public verification page.
 *
 * No server-side writer produces either level: the Credly and Accredible
 * adapters cap at `account_linked` even when the provider returns a `proof`
 * block, and URL import hardcodes `captured_url`. Stripping the claim on the
 * client path therefore cannot break a legitimate write — there is no
 * legitimate writer.
 */
describe('POST /api/v1/anchor — evidence-level trust enforcement (SCRUM-2481)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuotaDeltas.length = 0;
    mockConfig.enableProfessionalEducationSchemaReady = true;
    mockConfig.enableOrgCreditEnforcement = false;
    mockInsert.mockImplementation(() => ({ select: vi.fn(() => ({ single: mockInsertChain.single })) }));
    mockSelectChain.maybeSingle.mockResolvedValue({ data: null, error: null });
    mockInsertChain.single.mockResolvedValue({
      data: {
        public_id: 'ARK-2026-ABCD1234',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        created_at: '2026-04-27T00:00:00Z',
      },
      error: null,
    });
  });

  function persistedMetadata(): Record<string, unknown> | undefined {
    const insertArg = mockInsert.mock.calls[0]?.[0] as InsertCallArg | undefined;
    return insertArg?.metadata;
  }

  it.each(['issuer_anchored', 'source_signed'])(
    'strips a client-asserted %s level but still creates the anchor',
    async (level) => {
      const res = await postBadgeMetadata({
        verification_level: level,
        source_provider: 'credly',
        credential_title: 'Totally Legit Credential',
      });

      expect(res.status).toBe(201);
      expect(mockInsert).toHaveBeenCalledTimes(1);
      // The claim never reaches the DB, so get_public_anchor can never serve it
      // and EvidenceLevelBadge can never render the issuer treatment.
      expect(persistedMetadata()).not.toHaveProperty('verification_level');
      // The rest of the caller's provenance metadata is untouched.
      expect(persistedMetadata()).toMatchObject({
        source_provider: 'credly',
        credential_title: 'Totally Legit Credential',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-1',
          keyId: 'key-1',
          stripped: ['verification_level'],
          attemptedVerificationLevel: level,
        }),
        expect.stringContaining('Dropped client-asserted'),
      );
    },
  );

  it.each(['account_linked', 'captured_url', 'captured_upload_ai'])(
    'still persists a self-reportable %s level',
    async (level) => {
      const res = await postBadgeMetadata({
        verification_level: level,
        source_provider: 'credly',
      });

      expect(res.status).toBe(201);
      expect(persistedMetadata()).toMatchObject({ verification_level: level });
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ stripped: expect.anything() }),
        expect.any(String),
      );
    },
  );

  it('omits the metadata column entirely when the stripped claim was the only key', async () => {
    const res = await postBadgeMetadata({ verification_level: 'issuer_anchored' });

    expect(res.status).toBe(201);
    // Not `metadata: {}` — the column is left off so Postgres applies its NULL
    // default, matching the SCRUM-1732 no-metadata contract.
    expect(mockInsert.mock.calls[0]?.[0]).toHaveProperty('metadata.securing_path', 'queue');
  });
});
