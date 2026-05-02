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

const { mockSelectChain, mockInsertChain, mockInsert, mockLogger, mockConfig } = vi.hoisted(() => {
  const mockSelectChain = { single: vi.fn(), maybeSingle: vi.fn() };
  const mockInsertChain = { single: vi.fn() };
  const mockInsert = vi.fn((_value?: unknown) => ({ select: vi.fn(() => ({ single: mockInsertChain.single })) }));
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  // Mock the worker config so transitive import (anchor-submit → orgCredits →
  // config.js) doesn't try to load required env vars in the test env and
  // throw "Invalid worker configuration" before any test runs.
  const mockConfig = { enableOrgCreditEnforcement: false };
  return { mockSelectChain, mockInsertChain, mockInsert, mockLogger, mockConfig };
});

vi.mock('../../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));

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
      })),
    },
  };
});

vi.mock('../../lib/urls.js', () => ({
  buildVerifyUrl: (id: string) => `https://example.test/verify/${id}`,
}));

import { anchorSubmitRouter } from './anchor-submit.js';
import { requireScope } from '../../middleware/apiKeyAuth.js';

function makeApp(scopes = ['anchor:write']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { apiKey?: unknown }).apiKey = {
      keyId: 'key-1',
      userId: 'user-1',
      orgId: 'org-1',
      scopes,
      rateLimitTier: 'paid',
      keyPrefix: 'arkv_test_',
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
    expect(mockInsert.mock.calls[0]?.[0]).not.toHaveProperty('metadata');
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
});
