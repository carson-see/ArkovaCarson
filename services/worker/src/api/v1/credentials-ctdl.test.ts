import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildCredentialsCtdlRouter, normalizeAnchorRow, type CredentialsCtdlLookup } from './credentials-ctdl.js';
import type { CtdlAnchor } from '../../ctdl/ctdl-serializer.js';
import { validateCtdlJsonLd } from '../../ctdl/ctdl-validation.js';

const { insertAudit, loggerWarn } = vi.hoisted(() => ({
  insertAudit: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      if (table === 'audit_events') return { insert: insertAudit };
      return { select: vi.fn() };
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn(), debug: vi.fn() },
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
    insertAudit.mockReturnValue({ error: null });
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
    expect(res.body).not.toHaveProperty('ceterms:ctid');
    expect(res.body['ceterms:offeredBy']).not.toHaveProperty('ceterms:ctid');
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

  it('still returns CTDL JSON-LD when audit logging fails', async () => {
    insertAudit.mockRejectedValueOnce(new Error('audit insert unavailable'));
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor()),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(200);
    expect(res.body['@type']).toBe('ceterms:BachelorDegree');
    await vi.waitFor(() => {
      expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({
        public_id: 'ARK-2026-CTDL-001',
        error: 'audit insert unavailable',
      }), 'Failed to write CTDL request audit event');
    });
  });

  it('logs Supabase audit insert errors without blocking the public response', async () => {
    insertAudit.mockResolvedValueOnce({ error: { message: 'audit row rejected' } });
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor()),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({
        public_id: 'ARK-2026-CTDL-001',
        error: 'audit row rejected',
      }), 'Failed to write CTDL request audit event');
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

  it('fails closed without CTDL output when transcript-like free text has low-confidence learner PII', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        credentialType: 'DEGREE',
        subType: 'transcript',
        label: 'Official transcript for Jane Q Student',
        description: 'Transcript record for learner Jane Q Student.',
        metadata: { document_type: 'official transcript' },
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    expect(JSON.stringify(res.body)).not.toContain('Jane Q Student');
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'safety_blocked',
      http_status: 404,
      credential_status: 'SECURED',
      credential_type: 'DEGREE',
    });
  });

  it('fails closed for name-first learner PII in transcript-like output', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        credentialType: 'DEGREE',
        subType: 'transcript',
        label: "Jane Q Student's transcript",
        description: 'Official learner record.',
        metadata: { document_type: 'official transcript' },
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    expect(JSON.stringify(res.body)).not.toContain('Jane Q Student');
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'safety_blocked',
      http_status: 404,
    });
  });

  it('fails closed (no published body) when a credential carries a fabricated CTID (CE-02)', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(
        anchor({ ctid: 'ce-ARK-2026-CTDL-001' } as Partial<CtdlAnchor>),
      ),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    // The guard throws inside buildCtdlJsonLd; the endpoint fails closed —
    // never publishes a body, never echoes the offending CTID.
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expect(JSON.stringify(res.body)).not.toContain('ce-ARK-2026-CTDL-001');
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'error',
      http_status: 500,
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

  // SCRUM-2372 (CE-01) — publishability gate, fixture-driven. Publishable
  // statuses return a CTDL body (200, or 410 for revoked); every non-publishable
  // status fails closed with 404 and no CTDL body / no learner PII.
  describe('CE-01 publishability gate (fixture-driven)', () => {
    const PUBLISHABLE: ReadonlyArray<[string, number]> = [
      ['SECURED', 200],
      ['ACTIVE', 200],
      ['EXPIRED', 200],
      ['SUPERSEDED', 200],
      ['REVOKED', 410],
    ];
    // [label, status] — label renders '' as a readable '(empty)' in the generated
    // test title while the actual empty string still drives the anchor status.
    const NON_PUBLISHABLE: Array<[string, string]> = [
      ['PENDING', 'PENDING'],
      ['DRAFT', 'DRAFT'],
      ['PROCESSING', 'PROCESSING'],
      ['FAILED', 'FAILED'],
      ['DELETED', 'DELETED'],
      ['UNKNOWN', 'UNKNOWN'],
      ['(empty)', ''],
    ];

    it.each(PUBLISHABLE)('publishes CTDL for status %s (HTTP %i)', async (status, expected) => {
      const lookup: CredentialsCtdlLookup = {
        lookupByPublicId: vi.fn().mockResolvedValue(anchor({
          status,
          revokedAt: status === 'REVOKED' ? '2026-05-21T00:00:00.000Z' : null,
        })),
      };

      const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

      expect(res.status).toBe(expected);
      expect(res.body['@context']).toBe('https://credreg.net/ctdl/schema/context/json');
      // No learner PII in any publishable body.
      expect(JSON.stringify(res.body)).not.toContain('recipient@example.com');
      expect(JSON.stringify(res.body)).not.toContain('fingerprint');
      expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
    });

    it.each(NON_PUBLISHABLE)('fails closed with 404 and no CTDL body for non-publishable status %s', async (_label, status) => {
      const lookup: CredentialsCtdlLookup = {
        lookupByPublicId: vi.fn().mockResolvedValue(anchor({ status })),
      };

      const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
      // No CTDL projection, no learner PII, no internal fields leak on a block.
      expect(res.body).not.toHaveProperty('@context');
      expect(JSON.stringify(res.body)).not.toContain('recipient@example.com');
      expect(JSON.stringify(res.body)).not.toContain('fingerprint');
      expect(JSON.stringify(res.body)).not.toContain('Arkova University');
    });
  });

  // SCRUM-2374 (CE-03) — expiration semantics through the public route.
  // The route sources issued-person expiry from anchors.expires_at (never mapped
  // to ceterms:expirationDate) and resource-availability expiry from an
  // allow-listed metadata key (mapped, when status permits).
  it('never surfaces an issued-person expires_at as ceterms:expirationDate (SECURED)', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        status: 'SECURED',
        expiresAt: '2027-05-19T00:00:00.000Z',
        metadata: {},
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('ceterms:expirationDate');
    expect(JSON.stringify(res.body)).not.toContain('2027-05-19');
    expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
  });

  it('maps a resource-availability offering expiry to ceterms:expirationDate', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        status: 'SECURED',
        expiresAt: '2027-05-19T00:00:00.000Z', // issued-person — must NOT appear
        resourceAvailableUntil: '2030-12-31T00:00:00.000Z', // offering — must appear
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(200);
    expect(res.body['ceterms:expirationDate']).toBe('2030-12-31T00:00:00.000Z');
    expect(JSON.stringify(res.body)).not.toContain('2027-05-19');
    expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
  });

  // MED PII-leak (end-to-end): a leaky metadata value that Date.parse()s must
  // NEVER surface an email in ceterms:expirationDate on the public projection.
  // Drives through normalizeAnchorRow (the real derivation path), not a
  // hand-set resourceAvailableUntil.
  it('never leaks an email from metadata into ceterms:expirationDate (end-to-end)', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockImplementation(async () =>
        normalizeAnchorRow({
          public_id: 'ARK-2026-CTDL-001',
          status: 'SECURED',
          credential_type: 'DEGREE',
          sub_type: 'bachelor',
          label: 'Bachelor of Science',
          description: 'Public credential description',
          created_at: '2026-05-20T12:00:00.000Z',
          chain_timestamp: '2026-05-20T12:10:00.000Z',
          issued_at: '2026-05-01T00:00:00.000Z',
          metadata: { resource_available_until: 'recipient@example.com 2030-01-01' },
          organization: { display_name: 'Arkova University', public_id: 'ORG-ARKOVA-U', website_url: 'https://example.edu' },
        }),
      ),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(200);
    // JSON-LD legitimately contains @context/@type, so assert the email address
    // (local-part@domain) is absent rather than a bare "@".
    expect(JSON.stringify(res.body)).not.toContain('recipient@example.com');
    expect(JSON.stringify(res.body)).not.toContain('example.com');
    expect(res.body).not.toHaveProperty('ceterms:expirationDate');
    expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
  });

  it('omits ceterms:expirationDate when no resource-availability offering expiry is present', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        status: 'SECURED',
        expiresAt: '2027-05-19T00:00:00.000Z', // issued-person only — never maps
        resourceAvailableUntil: null,
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('ceterms:expirationDate');
    expect(JSON.stringify(res.body)).not.toContain('2027-05-19');
  });

  it('omits ceterms:expirationDate on the public body for a revoked credential with a resource-availability offering expiry', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        status: 'REVOKED',
        resourceAvailableUntil: '2030-12-31T00:00:00.000Z',
        revokedAt: '2026-05-21T00:00:00.000Z',
        revocationReason: 'Revoked by issuer.',
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(410);
    expect(res.body['ceterms:credentialStatusType']).toBe('ceterms:Revoked');
    expect(res.body).not.toHaveProperty('ceterms:expirationDate');
    expect(JSON.stringify(res.body)).not.toContain('2030-12-31');
    expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
  });
});

// SCRUM-2374 (CE-03) — normalizeAnchorRow is where a raw anchors row is mapped
// into a CtdlAnchor. It is the only place a RESOURCE-AVAILABILITY / offering
// expiry is derived (from an allow-listed metadata key) and where the
// ISSUED-PERSON expiry (anchors.expires_at) is read but deliberately kept off
// ceterms:expirationDate. These tests pin that mapping at the DB-row layer.
describe('normalizeAnchorRow — CE-03 expiration mapping', () => {
  const baseRow = {
    public_id: 'ARK-2026-CTDL-001',
    status: 'SECURED',
    credential_type: 'CERTIFICATE',
    created_at: '2026-05-20T12:00:00.000Z',
    expires_at: '2027-05-19T00:00:00.000Z',
  };

  it('reads issued-person expiry from expires_at without deriving a resource-availability date', () => {
    const anchor = normalizeAnchorRow({ ...baseRow, metadata: null });
    expect(anchor.expiresAt).toBe('2027-05-19T00:00:00.000Z');
    expect(anchor.resourceAvailableUntil).toBeNull();
  });

  it.each([
    'resource_available_until',
    'resourceAvailableUntil',
    'offering_available_until',
    'offeringAvailableUntil',
    'offering_end_date',
    'offeringEndDate',
  ])('derives resourceAvailableUntil from allow-listed metadata key %s', (key) => {
    const anchor = normalizeAnchorRow({
      ...baseRow,
      metadata: { [key]: '2030-12-31T00:00:00.000Z' },
    });
    expect(anchor.resourceAvailableUntil).toBe('2030-12-31T00:00:00.000Z');
    // Issued-person expiry is still read but stays distinct from the offering date.
    expect(anchor.expiresAt).toBe('2027-05-19T00:00:00.000Z');
  });

  it('ignores a non-date resource-availability metadata value (honest omission)', () => {
    const anchor = normalizeAnchorRow({
      ...baseRow,
      metadata: { resource_available_until: 'not-a-date' },
    });
    expect(anchor.resourceAvailableUntil).toBeNull();
  });

  it('ignores a non-allow-listed metadata key that looks expiry-like', () => {
    const anchor = normalizeAnchorRow({
      ...baseRow,
      metadata: { expires_at: '2030-12-31T00:00:00.000Z', person_expiry: '2030-12-31T00:00:00.000Z' },
    });
    expect(anchor.resourceAvailableUntil).toBeNull();
  });

  // MED PII-leak — Date.parse() is lenient enough that an issuer email prefixed
  // to a date parses as "valid", and the pre-fix code returned the RAW string
  // verbatim, leaking the email into ceterms:expirationDate on the public body.
  it('rejects a metadata value carrying an email even if it Date.parse()s (PII leak)', () => {
    const leaky = 'recipient@example.com 2030-01-01';
    // Sanity-pin the exact leak precondition the fix defends against.
    expect(Number.isNaN(Date.parse(leaky))).toBe(false);

    const anchor = normalizeAnchorRow({
      ...baseRow,
      metadata: { resource_available_until: leaky },
    });
    // The email must NEVER survive into the derived offering expiry.
    expect(anchor.resourceAvailableUntil ?? '').not.toContain('@');
    expect(anchor.resourceAvailableUntil ?? '').not.toContain('example.com');
    expect(anchor.resourceAvailableUntil).toBeNull();
  });

  it('rejects a metadata value carrying a phone number', () => {
    const anchor = normalizeAnchorRow({
      ...baseRow,
      metadata: { resource_available_until: '2030-01-01 555-123-4567' },
    });
    expect(anchor.resourceAvailableUntil).toBeNull();
  });

  it('canonicalizes a non-ISO date string to bare ISO 8601 (no verbatim passthrough)', () => {
    const anchor = normalizeAnchorRow({
      ...baseRow,
      metadata: { resource_available_until: '12/31/2030' },
    });
    const derived = anchor.resourceAvailableUntil;
    // Either canonical ISO or omitted — never the raw "12/31/2030" string.
    expect(derived).not.toBe('12/31/2030');
    if (typeof derived === 'string') {
      expect(derived).toMatch(/^\d{4}-\d{2}-\d{2}/);
      // Must round-trip through Date as a canonical ISO value.
      expect(new Date(derived).toISOString()).toBe(derived);
    }
  });

  it('passes a valid full-ISO offering date through unchanged (canonical is a no-op)', () => {
    const anchor = normalizeAnchorRow({
      ...baseRow,
      metadata: { resource_available_until: '2030-12-31T00:00:00.000Z' },
    });
    expect(anchor.resourceAvailableUntil).toBe('2030-12-31T00:00:00.000Z');
  });

  // Pins the string-or-null coercion (asStringOrNull) applied to every optional
  // field: a non-string row value (number/object/array/boolean) must become null,
  // never leak a coerced/stringified artifact into the CtdlAnchor projection.
  it('coerces non-string row + issuer fields to null (no stringified leakage)', () => {
    const anchor = normalizeAnchorRow({
      ...baseRow,
      org_id: 12345,
      credential_type: { nested: 'object' },
      sub_type: ['array'],
      label: true,
      description: 0,
      chain_timestamp: 99,
      issued_at: {},
      expires_at: [],
      revoked_at: false,
      revocation_reason: 3.14,
      organization: {
        display_name: 42,
        public_id: null,
        website_url: undefined,
        domain: ['x'],
      },
    });

    expect(anchor.orgId).toBeNull();
    expect(anchor.credentialType).toBeNull();
    expect(anchor.subType).toBeNull();
    expect(anchor.label).toBeNull();
    expect(anchor.description).toBeNull();
    expect(anchor.chainTimestamp).toBeNull();
    expect(anchor.issuedAt).toBeNull();
    expect(anchor.expiresAt).toBeNull();
    expect(anchor.revokedAt).toBeNull();
    expect(anchor.revocationReason).toBeNull();
    expect(anchor.issuer).toEqual({
      name: null,
      publicId: null,
      websiteUrl: null,
      domain: null,
    });
  });
});
