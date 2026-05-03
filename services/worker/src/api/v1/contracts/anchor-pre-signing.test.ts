/**
 * SCRUM-1629 [Spec] tests — POST /api/v1/contracts/anchor-pre-signing
 *
 * These are red-baseline shape-pinning tests. The handler is currently
 * the [Spec] stub (returns 501 on success path). The tests below pin:
 *   - Validation rejects malformed input with RFC 7807-style problem JSON
 *   - Strict mode rejects unknown top-level fields
 *   - 401 when no API key
 *   - 501 when validation passes (until [Build] / SCRUM-1631 lands)
 *
 * SCRUM-1631 [Build] will:
 *   1. Update the success-path test to expect 201 + a PreSigningAnchorReceipt
 *   2. Add coverage for db idempotency, credit deduction, and provider
 *      enum routing
 *   3. Add a test asserting credential_type defaults to CONTRACT_PRESIGNING
 *      after migration 0285 adds it to the enum
 *
 * Until then, the 501 case below is the contract: integrators who hit the
 * endpoint with a valid body get a clear "spec only" signal, not a 404.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { anchorPreSigningRouter, PreSigningAnchorSchema } from './anchor-pre-signing.js';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeApp(withApiKey = true) {
  const app = express();
  app.use(express.json());
  if (withApiKey) {
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
  }
  app.use('/v1/contracts', anchorPreSigningRouter);
  return app;
}

const VALID_FINGERPRINT = 'a'.repeat(64);

const VALID_BODY = {
  fingerprint: VALID_FINGERPRINT,
  contract_metadata: {
    title: 'Master Services Agreement',
    counterparty_labels: ['Acme Corp', 'Arkova Inc'],
  },
  signing_workflow_metadata: {
    provider: 'docusign' as const,
    external_envelope_id: 'env-12345',
  },
};

describe('POST /api/v1/contracts/anchor-pre-signing — shape contract', () => {
  // ─── Auth gate ─────────────────────────────────────────────────────────
  it('401 without API key', async () => {
    const res = await request(makeApp(false))
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key/i);
  });

  // ─── Frozen response on stub ───────────────────────────────────────────
  it('501 with spec_only:true when valid body hits the stub', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('not_implemented');
    expect(res.body.spec_only).toBe(true);
    expect(res.body.message).toMatch(/SCRUM-1629/);
  });

  // ─── Fingerprint validation ────────────────────────────────────────────
  it('400 when fingerprint is missing', async () => {
    const { fingerprint: _, ...body } = VALID_BODY;
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.details.some((d: { path: string }) => d.path === 'fingerprint')).toBe(true);
  });

  it('400 when fingerprint is wrong length', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, fingerprint: 'a'.repeat(63) });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: { path: string }) => d.path === 'fingerprint')).toBe(true);
  });

  it('400 when fingerprint contains non-hex characters', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, fingerprint: 'g'.repeat(64) });
    expect(res.status).toBe(400);
  });

  // ─── Strict mode — unknown fields rejected ────────────────────────────
  it('400 when unknown top-level field is present (strict mode)', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, raw_pdf_bytes: 'not-allowed-per-1.6' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('400 when unknown field nested in contract_metadata (strict mode)', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        contract_metadata: {
          ...VALID_BODY.contract_metadata,
          counterparty_emails: ['leak@example.com'],
        },
      });
    expect(res.status).toBe(400);
  });

  // ─── credential_type literal lock ─────────────────────────────────────
  it('400 when credential_type is anything other than CONTRACT_PRESIGNING', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, credential_type: 'DEGREE' });
    expect(res.status).toBe(400);
  });

  it('accepts credential_type: CONTRACT_PRESIGNING (passes Zod)', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, credential_type: 'CONTRACT_PRESIGNING' });
    // Validation passes → reaches stub → 501.
    expect(res.status).toBe(501);
  });

  // ─── Provider enum lock ───────────────────────────────────────────────
  it('400 when signing provider is not in the enum', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        signing_workflow_metadata: {
          ...VALID_BODY.signing_workflow_metadata,
          provider: 'hellosign',
        },
      });
    expect(res.status).toBe(400);
  });

  it.each(['docusign', 'adobe_sign', 'other'] as const)(
    'accepts provider: %s',
    async (provider) => {
      const res = await request(makeApp())
        .post('/v1/contracts/anchor-pre-signing')
        .send({
          ...VALID_BODY,
          signing_workflow_metadata: {
            ...VALID_BODY.signing_workflow_metadata,
            provider,
          },
        });
      expect(res.status).toBe(501);
    },
  );

  // ─── Counterparty bounds ──────────────────────────────────────────────
  it('400 when counterparty_labels is empty', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        contract_metadata: { ...VALID_BODY.contract_metadata, counterparty_labels: [] },
      });
    expect(res.status).toBe(400);
  });

  it('400 when counterparty_labels exceeds max', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        contract_metadata: {
          ...VALID_BODY.contract_metadata,
          counterparty_labels: Array.from({ length: 21 }, (_, i) => `Party-${i}`),
        },
      });
    expect(res.status).toBe(400);
  });
});

// ─── Direct schema tests (no Express harness) ────────────────────────────
//
// Useful for SDK callers who want to validate shape locally before posting.
// Pins the parsed/inferred type against representative inputs.
describe('PreSigningAnchorSchema', () => {
  it('parses a minimal valid request', () => {
    const result = PreSigningAnchorSchema.safeParse(VALID_BODY);
    expect(result.success).toBe(true);
  });

  it('strips no fields silently — strict mode means unknown keys fail', () => {
    const result = PreSigningAnchorSchema.safeParse({
      ...VALID_BODY,
      __injected_field__: 'should fail',
    });
    expect(result.success).toBe(false);
  });

  it('accepts effective_date when ISO-8601 with offset', () => {
    const result = PreSigningAnchorSchema.safeParse({
      ...VALID_BODY,
      contract_metadata: {
        ...VALID_BODY.contract_metadata,
        effective_date: '2026-05-03T00:00:00Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects effective_date without offset', () => {
    const result = PreSigningAnchorSchema.safeParse({
      ...VALID_BODY,
      contract_metadata: {
        ...VALID_BODY.contract_metadata,
        effective_date: '2026-05-03',
      },
    });
    expect(result.success).toBe(false);
  });
});
