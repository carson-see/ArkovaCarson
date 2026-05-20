import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildCredentialsCtdlRouter, type CredentialsCtdlLookup } from './credentials-ctdl.js';
import type { CtdlAnchor } from '../../ctdl/ctdl-serializer.js';
import { validateCtdlJsonLd } from '../../ctdl/ctdl-validation.js';

const insertAudit = vi.fn();

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      if (table === 'audit_events') return { insert: insertAudit };
      return { select: vi.fn() };
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));

function anchor(overrides: Partial<CtdlAnchor> = {}): CtdlAnchor {
  return {
    publicId: 'ARK-2026-CTDL-001',
    status: 'SECURED',
    credentialType: 'DEGREE',
    subType: 'bachelor',
    label: 'Bachelor of Science',
    description: 'Public credential description',
    metadata: { fingerprint: 'a'.repeat(64), recipient_email: 'recipient@example.com' },
    createdAt: '2026-05-20T12:00:00.000Z',
    chainTimestamp: '2026-05-20T12:10:00.000Z',
    issuedAt: '2026-05-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    issuer: {
      name: 'Arkova University',
      publicId: 'ORG-ARKOVA-U',
      websiteUrl: 'https://example.edu',
    },
    ...overrides,
  };
}

function buildApp(lookup: CredentialsCtdlLookup) {
  const app = express();
  app.use(express.json());
  app.use('/', buildCredentialsCtdlRouter(lookup));
  return app;
}

describe('GET /credentials/:publicId/ctdl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns CTDL JSON-LD for a secured credential without auth', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor()),
    };

    const res = await request(buildApp(lookup))
      .get('/ARK-2026-CTDL-001/ctdl')
      .set('X-Request-Id', 'req-ctdl-001');

    expect(res.status).toBe(200);
    expect(res.type).toContain('application/ld+json');
    expect(res.body['@context']).toBe('https://credreg.net/ctdl/schema/context/json');
    expect(res.body['@type']).toBe('ceterms:BachelorDegree');
    expect(res.body['ceterms:ctid']).toBe('ce-ARK-2026-CTDL-001');
    expect(res.body['ceterms:verificationServiceProfile']['ceterms:verificationService']).toBe(
      'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    );
    expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
    expect(JSON.stringify(res.body)).not.toContain('recipient@example.com');
    expect(JSON.stringify(res.body)).not.toContain('fingerprint');

    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'ctdl.requested',
      event_category: 'VERIFICATION',
      target_type: 'credential',
      target_id: 'ARK-2026-CTDL-001',
    }));
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'published',
      http_status: 200,
      request_id: 'req-ctdl-001',
      credential_status: 'SECURED',
      credential_type: 'DEGREE',
    });
  });

  it('returns 404 for pending credentials and still audits the request', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({ status: 'PENDING' })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'not_publishable',
      http_status: 404,
      credential_status: 'PENDING',
    });
  });

  it('returns 410 with a revoked CTDL body for revoked credentials', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        status: 'REVOKED',
        revokedAt: '2026-05-21T00:00:00.000Z',
        revocationReason: 'Revoked by issuer.',
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(410);
    expect(res.body['ceterms:credentialStatusType']).toBe('ceterms:Revoked');
    expect(res.body['ceterms:revocationDate']).toBe('2026-05-21T00:00:00.000Z');
    expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'revoked',
      http_status: 410,
    });
  });

  it('returns 404 when no credential exists', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(null),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-MISSING/ctdl');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'not_found',
      http_status: 404,
    });
  });

  it('rejects malformed public IDs before lookup', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor()),
    };

    const res = await request(buildApp(lookup)).get('/%20bad/ctdl');

    expect(res.status).toBe(400);
    expect(lookup.lookupByPublicId).not.toHaveBeenCalled();
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'invalid',
      http_status: 400,
    });
  });
});
