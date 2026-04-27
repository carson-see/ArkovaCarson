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

const { mockSelectChain, mockInsertChain, mockLogger, mockConfig } = vi.hoisted(() => {
  const mockSelectChain = { single: vi.fn(), maybeSingle: vi.fn() };
  const mockInsertChain = { single: vi.fn() };
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  // Mock the worker config so transitive import (anchor-submit → orgCredits →
  // config.js) doesn't try to load required env vars in the test env and
  // throw "Invalid worker configuration" before any test runs.
  const mockConfig = { enableOrgCreditEnforcement: false };
  return { mockSelectChain, mockInsertChain, mockLogger, mockConfig };
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

  const insertSelectChain: Record<string, unknown> = { single: mockInsertChain.single };

  return {
    db: {
      from: vi.fn(() => ({
        select: vi.fn(() => eqChain),
        insert: vi.fn(() => ({ select: vi.fn(() => insertSelectChain) })),
      })),
    },
  };
});

vi.mock('../../lib/urls.js', () => ({
  buildVerifyUrl: (id: string) => `https://example.test/verify/${id}`,
}));

import { anchorSubmitRouter } from './anchor-submit.js';

function makeApp() {
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
  app.use('/v1/anchor', anchorSubmitRouter);
  return app;
}

const VALID_FINGERPRINT = 'a'.repeat(64);

describe('POST /api/v1/anchor — Zod validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('returns 401 when API key missing', async () => {
    const app = express();
    app.use(express.json());
    app.use('/v1/anchor', anchorSubmitRouter);
    const res = await request(app).post('/v1/anchor').send({ fingerprint: VALID_FINGERPRINT });
    expect(res.status).toBe(401);
  });
});
