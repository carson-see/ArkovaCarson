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

// Mock the worker config BEFORE importing anything that transitively imports
// config.js (apiKeyAuth → config). Otherwise config.js throws "Invalid worker
// configuration" in the test env without prod env vars.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { enableOrgCreditEnforcement: false },
}));

vi.mock('../../../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// db isn't actually used by the stub handler or by `requireScope`, but
// transitive imports (apiKeyAuth → db) call `getDb()` at module load and
// fail without env vars. The mock keeps the test hermetic.
vi.mock('../../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

import { anchorPreSigningRouter, PreSigningAnchorSchema } from './anchor-pre-signing.js';
import { requireScope } from '../../../middleware/apiKeyAuth.js';

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

  it('accepts credential_type: CONTRACT_PRESIGNING explicitly (passes Zod)', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, credential_type: 'CONTRACT_PRESIGNING' });
    // Validation passes → reaches stub → 501.
    expect(res.status).toBe(501);
  });

  it('accepts request without credential_type (defaults to CONTRACT_PRESIGNING)', async () => {
    // .default('CONTRACT_PRESIGNING') makes the field implicit-but-pinned;
    // the resolved value is always CONTRACT_PRESIGNING after Zod parse.
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
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

  it('parses credential_type to CONTRACT_PRESIGNING when omitted (.default lock)', () => {
    const result = PreSigningAnchorSchema.safeParse(VALID_BODY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.credential_type).toBe('CONTRACT_PRESIGNING');
    }
  });

  it('canonicalizes fingerprint to lowercase at parse time (idempotency lock)', () => {
    const upper = 'A'.repeat(64);
    const result = PreSigningAnchorSchema.safeParse({ ...VALID_BODY, fingerprint: upper });
    expect(result.success).toBe(true);
    if (result.success) {
      // Same digest in mixed case must parse to the same lowercase string,
      // otherwise downstream idempotency lookup would split rows.
      expect(result.data.fingerprint).toBe('a'.repeat(64));
    }
  });

  it('canonicalizes mixed-case fingerprint to lowercase', () => {
    const mixed = 'AaBbCcDdEeFf' + '0'.repeat(52);
    const result = PreSigningAnchorSchema.safeParse({ ...VALID_BODY, fingerprint: mixed });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fingerprint).toBe(mixed.toLowerCase());
    }
  });
});

// ─── Router-level scope-gate test (CodeRabbit major) ─────────────────────
//
// The other tests bypass the v1 router and mount the handler directly. That
// pins request/response shape but does NOT verify the security contract that
// `requireScope('anchor:write')` is the gate in front of the handler. One
// integration case here locks that contract: a request from an API key
// without the `anchor:write` scope MUST 403 *before* reaching the handler
// (which would otherwise return 501 — a successful response would mean the
// scope gate is missing).
describe('POST /api/v1/contracts/anchor-pre-signing — scope gate', () => {
  it('403 when API key lacks anchor:write scope', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { apiKey?: unknown }).apiKey = {
        keyId: 'key-1',
        userId: 'user-1',
        orgId: 'org-1',
        scopes: ['verify'], // missing anchor:write
        rateLimitTier: 'paid',
        keyPrefix: 'arkv_test_',
      };
      next();
    });
    // Mirror the production mount in services/worker/src/api/v1/router.ts —
    // requireScope('anchor:write') runs in front of anchorPreSigningRouter.
    app.use('/v1/contracts', requireScope('anchor:write'), anchorPreSigningRouter);

    const res = await request(app)
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    // Critical assertion: did NOT reach the handler. The 501 stub response
    // would mean the scope gate is missing.
    expect(res.body.error).not.toBe('not_implemented');
    // Pin the exact requireScope error payload — proves 403 came from
    // requireScope('anchor:write'), not from some other middleware that
    // happened to return 403 with a different shape.
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required).toBe('anchor:write');
  });
});
