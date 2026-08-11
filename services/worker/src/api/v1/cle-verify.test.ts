/**
 * SCRUM-1868 — CLE public API response sanitizer.
 *
 * Pin that `/api/v1/cle/*` never leaks internal anchor UUIDs, raw CLE
 * metadata, attorney identifiers, filenames, attestation claims, or chain
 * transaction IDs in customer-facing responses.
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleVerifyRouter } from './cle-verify.js';

const mockTables = vi.hoisted(() => ({
  anchorsRows: [] as Array<Record<string, unknown>>,
  attestationRows: [] as Array<Record<string, unknown>>,
  insertedAnchor: { id: 'anchor-internal-submit', public_id: 'ARK-2026-CLE-SUBMIT' },
  insertedPayload: null as Record<string, unknown> | null,
}));

const mockLoggerInfo = vi.hoisted(() => vi.fn());

vi.mock('../../utils/db.js', () => {
  type QueryResult = { data: Array<Record<string, unknown>>; error: null };
  type MockMethod = ReturnType<typeof vi.fn>;
  type MockQuery = Promise<QueryResult> & {
    select: MockMethod;
    eq: MockMethod;
    in: MockMethod;
    ilike: MockMethod;
    order: MockMethod;
    gte: MockMethod;
    lte: MockMethod;
    limit: MockMethod;
    insert: MockMethod;
    single: MockMethod;
    maybeSingle: MockMethod;
  };

  function createQuery(table: string): MockQuery {
    const query = Promise.resolve().then(() => {
      const data = table === 'attestations' ? mockTables.attestationRows : mockTables.anchorsRows;
      return { data, error: null };
    }) as MockQuery;

    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.in = vi.fn(() => query);
    query.ilike = vi.fn(() => query);
    query.order = vi.fn(() => query);
    query.gte = vi.fn(() => query);
    query.lte = vi.fn(() => query);
    query.limit = vi.fn(() => query);
    query.insert = vi.fn((payload: Record<string, unknown>) => {
      mockTables.insertedPayload = payload;
      return query;
    });
    query.single = vi.fn(() => Promise.resolve({ data: mockTables.insertedAnchor, error: null }));
    // `/cle/submit` resolves the caller's org from `profiles` to attribute the
    // anchor row. Org attribution itself is covered by
    // `cle-submit-org-attribution.test.ts`; here the org is simply present so
    // the submit path reaches the sanitizer assertions this suite is about.
    query.maybeSingle = vi.fn(() =>
      Promise.resolve({
        data: table === 'profiles' ? { org_id: 'org-cle-1', role: null, is_platform_admin: false } : null,
        error: null,
      }),
    );

    return query;
  }

  return {
    db: {
      from: vi.fn((table: string) => createQuery(table)),
    },
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: mockLoggerInfo, debug: vi.fn() },
}));

vi.mock('../../auth.js', () => ({
  verifyAuthToken: vi.fn(() => Promise.resolve('user-cle-1')),
}));

vi.mock('../../config.js', () => ({
  config: {
    nodeEnv: 'test',
    apiKeyHmacSecret: 'test-secret',
    corsAllowedOrigins: '',
    frontendUrl: 'https://app.arkova.ai',
    bitcoinNetwork: 'signet',
  },
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/cle', cleVerifyRouter);
  return app;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

describe('cle-verify public response sanitizer (SCRUM-1868)', () => {
  beforeEach(() => {
    mockTables.anchorsRows = [
      {
        id: 'anchor-internal-1',
        public_id: 'ARK-2026-CLE-001',
        filename: 'CLE_Michigan_BAR-123_2026-04-01.json',
        credential_type: 'CLE',
        metadata: {
          bar_number: 'BAR-123',
          attorney_name: 'Ada Counsel',
          course_title: 'Ethics Update',
          provider_name: 'State Bar CLE',
          credit_hours: 7,
          credit_category: 'Ethics',
          delivery_method: 'Live Webcast',
          completion_date: '2026-04-01',
          jurisdiction: 'Michigan',
        },
        status: 'SECURED',
        created_at: '2026-04-02T00:00:00Z',
        chain_tx_id: 'tx-secret-1',
        chain_block_height: 123,
      },
      {
        id: 'anchor-internal-2',
        public_id: 'ARK-2026-CLE-002',
        filename: 'CLE_Michigan_BAR-123_2026-04-10.json',
        credential_type: 'CLE',
        metadata: {
          bar_number: 'BAR-123',
          attorney_name: 'Ada Counsel',
          course_title: 'Technology Competence',
          provider_name: 'PLI',
          credit_hours: 5,
          credit_category: 'General',
          delivery_method: 'On-Demand',
          completion_date: '2026-04-10',
          jurisdiction: 'Michigan',
        },
        status: 'SECURED',
        created_at: '2026-04-11T00:00:00Z',
        chain_tx_id: 'tx-secret-2',
      },
      {
        id: 'anchor-other-attorney',
        public_id: 'ARK-2026-CLE-OTHER',
        filename: 'CLE_Michigan_BAR-999_2026-04-01.json',
        metadata: {
          bar_number: 'BAR-999',
          attorney_name: 'Other Lawyer',
          credit_hours: 20,
          credit_category: 'Ethics',
          jurisdiction: 'Michigan',
        },
        status: 'SECURED',
        created_at: '2026-04-03T00:00:00Z',
        chain_tx_id: 'tx-other',
      },
      {
        id: 'anchor-other-jurisdiction',
        public_id: 'ARK-2026-CLE-OHIO',
        filename: 'CLE_Ohio_BAR-123_2026-04-15.json',
        credential_type: 'CLE',
        metadata: {
          bar_number: 'BAR-123',
          attorney_name: 'Ada Counsel',
          course_title: 'Ohio Professional Responsibility',
          provider_name: 'Ohio CLE Institute',
          credit_hours: 12,
          credit_category: 'Ethics',
          completion_date: '2026-04-15',
          jurisdiction: 'Ohio',
        },
        status: 'SECURED',
        created_at: '2026-04-16T00:00:00Z',
        chain_tx_id: 'tx-secret-ohio',
      },
    ];
    mockTables.attestationRows = [
      {
        id: 'attestation-internal-1',
        public_id: 'ARK-ATT-CLE-001',
        attestation_type: 'CLE completion',
        claims: { attorney_name: 'Ada Counsel', bar_number: 'BAR-123', sensitive: true },
        status: 'ACTIVE',
        created_at: '2026-04-12T00:00:00Z',
      },
    ];
    mockTables.insertedAnchor = { id: 'anchor-internal-submit', public_id: 'ARK-2026-CLE-SUBMIT' };
    mockTables.insertedPayload = null;
    mockLoggerInfo.mockClear();
  });

  it('GET /cle/verify preserves aggregate CLE compliance math while stripping sensitive fields', async () => {
    const res = await request(createApp())
      .get('/api/v1/cle/verify')
      .query({ bar_number: 'BAR-123', jurisdiction: 'Michigan' })
      .expect(200);

    expect(res.body).toMatchObject({
      jurisdiction: 'Michigan',
      compliance_status: 'compliant',
      summary: {
        total_cle_hours: 12,
        ethics_hours: 7,
        total_anchored_records: 2,
        total_attestations: 1,
      },
    });
    expect(res.body.summary.credits_by_category).toEqual({ Ethics: 7, General: 5 });
    expect(res.body.records).toHaveLength(2);
    expect(res.body.records[0]).toMatchObject({
      public_id: 'ARK-2026-CLE-001',
      course_title: 'Ethics Update',
      provider_name: 'State Bar CLE',
      credit_hours: 7,
      credit_category: 'Ethics',
      delivery_method: 'Live Webcast',
      completion_date: '2026-04-01',
      jurisdiction: 'Michigan',
      anchor_status: 'SECURED',
      anchored_at: '2026-04-02T00:00:00Z',
    });
    expect(res.body.attestations).toEqual([
      {
        public_id: 'ARK-ATT-CLE-001',
        attestation_type: 'CLE completion',
        status: 'ACTIVE',
        created_at: '2026-04-12T00:00:00Z',
      },
    ]);

    const payload = stringify(res.body);
    expect(payload).not.toContain('anchor-internal');
    expect(payload).not.toContain('attestation-internal');
    expect(payload).not.toContain('BAR-123');
    expect(payload).not.toContain('Ada Counsel');
    expect(payload).not.toContain('chain_tx_id');
    expect(payload).not.toContain('tx-secret');
    expect(payload).not.toContain('filename');
    expect(payload).not.toContain('metadata');
    expect(payload).not.toContain('claims');
    expect(payload).not.toContain('Ohio Professional Responsibility');
  });

  it('GET /cle/credits returns public credit rows without bar number, filename fallback, metadata, or chain receipt', async () => {
    const res = await request(createApp())
      .get('/api/v1/cle/credits')
      .query({ bar_number: 'BAR-123', jurisdiction: 'Michigan' })
      .expect(200);

    expect(res.body).toMatchObject({
      jurisdiction: 'Michigan',
      total_credits: 2,
    });
    expect(res.body.credits[0]).toMatchObject({
      public_id: 'ARK-2026-CLE-001',
      course_title: 'Ethics Update',
      provider_name: 'State Bar CLE',
      credit_hours: 7,
      credit_category: 'Ethics',
      delivery_method: 'Live Webcast',
      completion_date: '2026-04-01',
      jurisdiction: 'Michigan',
      anchor_status: 'SECURED',
      anchored_at: '2026-04-02T00:00:00Z',
    });

    const payload = stringify(res.body);
    expect(payload).not.toContain('anchor-internal');
    expect(payload).not.toContain('BAR-123');
    expect(payload).not.toContain('Ada Counsel');
    expect(payload).not.toContain('chain_tx_id');
    expect(payload).not.toContain('tx-secret');
    expect(payload).not.toContain('filename');
    expect(payload).not.toContain('metadata');
  });

  it('omits jurisdiction fields instead of returning jurisdiction null', async () => {
    mockTables.anchorsRows = mockTables.anchorsRows.map((row) => {
      const metadata = row.metadata as Record<string, unknown>;
      return { ...row, metadata: { ...metadata, jurisdiction: null } };
    });

    const verifyRes = await request(createApp())
      .get('/api/v1/cle/verify')
      .query({ bar_number: 'BAR-123' })
      .expect(200);
    const creditsRes = await request(createApp())
      .get('/api/v1/cle/credits')
      .query({ bar_number: 'BAR-123' })
      .expect(200);

    expect(verifyRes.body).not.toHaveProperty('jurisdiction');
    expect(creditsRes.body).not.toHaveProperty('jurisdiction');
    expect(verifyRes.body.records[0]).not.toHaveProperty('jurisdiction');
    expect(creditsRes.body.credits[0]).not.toHaveProperty('jurisdiction');
    expect(stringify(verifyRes.body)).not.toContain('"jurisdiction":null');
    expect(stringify(creditsRes.body)).not.toContain('"jurisdiction":null');
  });

  it('GET /cle/credits handles non-string jurisdiction metadata while filtering', async () => {
    mockTables.anchorsRows = mockTables.anchorsRows.map((row) => {
      const metadata = row.metadata as Record<string, unknown>;
      return { ...row, metadata: { ...metadata, jurisdiction: { state: 'Michigan' } } };
    });

    const res = await request(createApp())
      .get('/api/v1/cle/credits')
      .query({ bar_number: 'BAR-123', jurisdiction: 'Michigan' })
      .expect(200);

    expect(res.body).toMatchObject({
      jurisdiction: 'Michigan',
      total_credits: 0,
      credits: [],
    });
  });

  it('POST /cle/submit returns only public anchor identifiers and logs without attorney identifiers', async () => {
    const res = await request(createApp())
      .post('/api/v1/cle/submit')
      .set('Authorization', 'Bearer jwt-test')
      .send({
        bar_number: 'BAR-123',
        attorney_name: 'Ada Counsel',
        course_title: 'Ethics Update',
        provider_name: 'State Bar CLE',
        provider_accreditation_number: 'ACC-123',
        credit_hours: 7,
        credit_category: 'Ethics',
        delivery_method: 'Live Webcast',
        jurisdiction: 'Michigan',
        completion_date: '2026-04-01',
        course_number: 'CLE-ETH-1',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      public_id: 'ARK-2026-CLE-SUBMIT',
      status: 'PENDING',
      credit: {
        course_title: 'Ethics Update',
        credit_hours: 7,
        credit_category: 'Ethics',
        jurisdiction: 'Michigan',
        completion_date: '2026-04-01',
      },
    });

    const payload = stringify(res.body);
    expect(payload).not.toContain('anchor-internal-submit');
    expect(payload).not.toContain('BAR-123');
    expect(payload).not.toContain('Ada Counsel');
    // The resolved org id is now an internal value flowing through the handler
    // (mock profiles.org_id) — pin that it never reaches the response body.
    expect(payload).not.toContain('org-cle-1');
    expect(res.body).not.toHaveProperty('id');
    expect(res.body).not.toHaveProperty('org_id');
    expect(res.body.credit).not.toHaveProperty('bar_number');

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const logPayload = stringify(mockLoggerInfo.mock.calls[0][0]);
    expect(logPayload).not.toContain('BAR-123');
    expect(logPayload).not.toContain('Ada Counsel');
    expect(logPayload).not.toContain('anchor-internal-submit');
    expect(logPayload).not.toContain('anchor_id');
    expect(logPayload).not.toContain('org-cle-1');

    expect(String(mockTables.insertedPayload?.filename)).toMatch(
      /^CLE_[A-Za-z0-9_-]+_\d{4}-\d{2}-\d{2}_[a-f0-9]{12}\.json$/,
    );
    expect(String(mockTables.insertedPayload?.filename)).not.toMatch(/BAR|bar_number|Ada/i);
    expect(String(mockTables.insertedPayload?.fingerprint)).toMatch(/^[a-f0-9]{64}$/);
  });
});
