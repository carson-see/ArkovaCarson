/**
 * SCRUM-1632 [Spec] — red-baseline tests for POST /api/v1/contracts/anchor-post-signing.
 *
 * Pins the frozen v1 contract:
 *   - Auth gate (401 without API key)
 *   - Zod validation surface (every required field, every constraint)
 *   - Strict-mode unknown-field rejection
 *   - Stub returns 501 with `spec_only: true` on the validated-success path
 *
 * The [Implement] PR (SCRUM-1633) inherits these green and only swaps the
 * 501 success-path branch. If a [Implement] change accidentally widens
 * the request surface, that change will turn one of these tests red.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { anchorPostSigningRouter, PostSigningAnchorSchema } from './anchor-post-signing.js';

function buildApp(opts?: { withApiKey?: boolean }): Express {
  const app = express();
  app.use(express.json());
  if (opts?.withApiKey) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      // Mirrors the test apiKey stub used in anchor-pre-signing.test.ts —
      // populates the full ApiKeyMeta shape so handler-side checks like
      // req.apiKey.scopes / .keyId don't break in the [Implement] swap.
      req.apiKey = {
        keyId: 'key-test',
        orgId: 'org-1',
        userId: 'user-1',
        scopes: ['anchor:write'],
        rateLimitTier: 'paid',
        keyPrefix: 'ak_test',
      };
      next();
    });
  }
  app.use('/api/v1/contracts', anchorPostSigningRouter);
  return app;
}

const validBody = () => ({
  fingerprint: 'a'.repeat(64),
  parent: {
    parent_public_id: 'ARK-2026-DEADBEEF',
  },
  validation_report: {
    completed_at: '2026-05-04T12:00:00.000Z',
    envelope_status: 'completed',
    signers: [
      {
        label: 'Alice — Counterparty A',
        signed_at: '2026-05-04T11:55:00.000Z',
        signing_method: 'sso',
        country_iso2: 'US',
      },
    ],
    audit_trail_hash: 'b'.repeat(64),
  },
});

describe('POST /api/v1/contracts/anchor-post-signing — [Spec] auth + validation', () => {
  let app: Express;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('auth gate', () => {
    it('returns 401 when API key is missing', async () => {
      app = buildApp({ withApiKey: false });
      const res = await request(app)
        .post('/api/v1/contracts/anchor-post-signing')
        .send(validBody());
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/api key required/i);
    });
  });

  describe('Zod validation — fingerprint', () => {
    beforeEach(() => {
      app = buildApp({ withApiKey: true });
    });

    it('rejects non-hex fingerprint', async () => {
      const body = { ...validBody(), fingerprint: 'not-hex'.padEnd(64, 'z') };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    it('rejects fingerprint with wrong length', async () => {
      const body = { ...validBody(), fingerprint: 'a'.repeat(63) };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('lowercases mixed-case fingerprint at parse time', () => {
      const parsed = PostSigningAnchorSchema.safeParse({
        ...validBody(),
        fingerprint: 'A'.repeat(32) + 'a'.repeat(32),
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.fingerprint).toBe('a'.repeat(64));
      }
    });
  });

  describe('Zod validation — parent lookup discriminator', () => {
    beforeEach(() => {
      app = buildApp({ withApiKey: true });
    });

    it('accepts explicit parent_public_id', async () => {
      const body = { ...validBody(), parent: { parent_public_id: 'ARK-2026-CAFE0123' } };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(501);
    });

    it('accepts implicit (provider, external_envelope_id) lookup', async () => {
      const body = {
        ...validBody(),
        parent: { provider: 'docusign' as const, external_envelope_id: 'env-12345' },
      };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(501);
    });

    it('rejects parent missing both forms', async () => {
      const body = { ...validBody(), parent: {} };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects parent containing both explicit and implicit lookup fields', async () => {
      // CodeRabbit on PR #698: the discriminated-union design intends
      // exactly-one. Both .strict() schemas fail on the other's fields, so
      // the union as a whole rejects mixed payloads.
      const body = {
        ...validBody(),
        parent: {
          parent_public_id: 'ARK-2026-CAFE0123',
          provider: 'docusign' as const,
          external_envelope_id: 'env-12345',
        },
      };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects malformed parent_public_id', async () => {
      const body = { ...validBody(), parent: { parent_public_id: 'not-a-public-id' } };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects unknown signing provider', async () => {
      const body = {
        ...validBody(),
        parent: { provider: 'hellosign', external_envelope_id: 'env-1' },
      };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });
  });

  describe('Zod validation — validation_report', () => {
    beforeEach(() => {
      app = buildApp({ withApiKey: true });
    });

    it('rejects empty signers array', async () => {
      const body = validBody();
      body.validation_report.signers = [];
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects > 20 signers (upper bound)', async () => {
      const body = validBody();
      const signer = body.validation_report.signers[0];
      body.validation_report.signers = Array.from({ length: 21 }, (_, i) => ({
        ...signer,
        label: `Signer ${i}`,
      }));
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects unknown envelope_status', async () => {
      const body = validBody();
      body.validation_report.envelope_status = 'sent' as never;
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects unknown signing_method', async () => {
      const body = validBody();
      body.validation_report.signers[0].signing_method = 'fingerprint_scan' as never;
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects 3-char country_iso2', async () => {
      const body = validBody();
      body.validation_report.signers[0].country_iso2 = 'USA' as never;
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('accepts country_iso2 omitted (optional)', async () => {
      const body = validBody();
      // The validBody() factory always sets country_iso2; delete it via a
      // typed cast since the inferred field shape is non-optional in the
      // factory's literal type but is optional in the schema.
      const signer0 = body.validation_report.signers[0] as Record<string, unknown>;
      delete signer0.country_iso2;
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(501);
    });

    it('rejects non-ISO-8601 completed_at', async () => {
      const body = validBody();
      body.validation_report.completed_at = '2026-05-04 12:00:00';
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects completed_at without timezone offset', async () => {
      const body = validBody();
      body.validation_report.completed_at = '2026-05-04T12:00:00';
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects malformed audit_trail_hash', async () => {
      const body = validBody();
      body.validation_report.audit_trail_hash = 'short';
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('lowercases audit_trail_hash at parse time', () => {
      const body = validBody();
      body.validation_report.audit_trail_hash = 'B'.repeat(64);
      const parsed = PostSigningAnchorSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.validation_report.audit_trail_hash).toBe('b'.repeat(64));
      }
    });

    it('rejects provider_audit_certificate_url that is not a URL', async () => {
      const body = validBody();
      (body.validation_report as Record<string, unknown>).provider_audit_certificate_url = 'not a url';
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects non-HTTPS provider_audit_certificate_url', async () => {
      // CodeRabbit on PR #698: signed-audit references must use TLS so a
      // network attacker cannot tamper with the certificate in transit.
      const body = validBody();
      (body.validation_report as Record<string, unknown>).provider_audit_certificate_url =
        'http://example.com/cert.pem';
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('accepts provider_audit_certificate_url omitted (optional)', async () => {
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(validBody());
      expect(res.status).toBe(501);
    });
  });

  describe('credential_type lock', () => {
    beforeEach(() => {
      app = buildApp({ withApiKey: true });
    });

    it('defaults to CONTRACT_POSTSIGNING when omitted', () => {
      const parsed = PostSigningAnchorSchema.safeParse(validBody());
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.credential_type).toBe('CONTRACT_POSTSIGNING');
      }
    });

    it('rejects credential_type = CONTRACT_PRESIGNING', async () => {
      const body = { ...validBody(), credential_type: 'CONTRACT_PRESIGNING' };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects credential_type = ACADEMIC_TRANSCRIPT', async () => {
      const body = { ...validBody(), credential_type: 'ACADEMIC_TRANSCRIPT' };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });
  });

  describe('strict-mode unknown-field rejection', () => {
    beforeEach(() => {
      app = buildApp({ withApiKey: true });
    });

    it('rejects unknown top-level field', async () => {
      const body = { ...validBody(), bonus_key: 'not-allowed' };
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects unknown field in signer entry', async () => {
      const body = validBody();
      // RFC 5737 reserved documentation/example IP — non-routable; satisfies Sonar S1313.
      (body.validation_report.signers[0] as Record<string, unknown>).ip_address = '203.0.113.1';
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects unknown field in validation_report', async () => {
      const body = validBody();
      (body.validation_report as Record<string, unknown>).extra_field = 'nope';
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects email field in signer entry (PII guard)', async () => {
      const body = validBody();
      (body.validation_report.signers[0] as Record<string, unknown>).email = 'a@example.com';
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });

    it('rejects email-shaped value in signer label (PII guard)', async () => {
      // CodeRabbit on PR #698: the doc says "an opaque label (NEVER an
      // email)" but length-only validation let an email-shaped string pass.
      // Schema now refines label to refuse email-shape.
      const body = validBody();
      (body.validation_report.signers[0] as Record<string, unknown>).label = 'a@example.com';
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(body);
      expect(res.status).toBe(400);
    });
  });

  describe('stub success-path response shape', () => {
    beforeEach(() => {
      app = buildApp({ withApiKey: true });
    });

    it('returns 501 with spec_only: true on a fully-valid request', async () => {
      const res = await request(app).post('/api/v1/contracts/anchor-post-signing').send(validBody());
      expect(res.status).toBe(501);
      expect(res.body).toMatchObject({
        error: 'not_implemented',
        spec_only: true,
      });
      expect(res.body.message).toMatch(/SCRUM-1633/);
    });
  });
});
