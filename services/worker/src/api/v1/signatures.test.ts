import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Filter = {
  op: 'eq' | 'in';
  column: string;
  value: unknown;
};

type QueryRecord = {
  table: string;
  filters: Filter[];
};

const { mockFrom, queries, insertedRows } = vi.hoisted(() => {
  type LocalFilter = {
    op: 'eq' | 'in';
    column: string;
    value: unknown;
  };

  type LocalQueryRecord = {
    table: string;
    filters: LocalFilter[];
  };

  const queries: LocalQueryRecord[] = [];
  const insertedRows: Array<{ table: string; payload: unknown }> = [];

  function hasEq(filters: LocalFilter[], column: string, value: unknown): boolean {
    return filters.some((filter) => (
      filter.op === 'eq'
      && filter.column === column
      && filter.value === value
    ));
  }

  function resolveSingle(table: string, filters: LocalFilter[]) {
    if (table === 'org_members') {
      return Promise.resolve({
        data: { org_id: 'org-b', role: 'admin' },
        error: null,
      });
    }

    if (table === 'signing_certificates') {
      return Promise.resolve({
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          org_id: 'org-b',
          subject_cn: 'Signer B',
          subject_org: 'Org B',
          issuer_cn: 'Arkova Test CA',
          issuer_org: 'Arkova',
          serial_number: 'cert-serial',
          fingerprint_sha256: 'f'.repeat(64),
          certificate_pem: '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----',
          chain_pem: [],
          kms_provider: 'gcp',
          kms_key_id: 'kms-key',
          key_algorithm: 'RSA-2048',
          not_before: '2026-01-01T00:00:00.000Z',
          not_after: '2027-01-01T00:00:00.000Z',
          status: 'ACTIVE',
          trust_level: 'ADVANCED',
          qtsp_name: null,
          eu_trusted_list_entry: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          created_by: 'user-b',
          metadata: {},
        },
        error: null,
      });
    }

    if (table === 'attestations') {
      const orgAFixture = {
        id: 'attestation-org-a',
        public_id: 'ARK-ORGA-VER-ABC123',
        attester_org_id: 'org-a',
      };
      const matchesPublicId = hasEq(filters, 'public_id', orgAFixture.public_id);
      const matchesOrg = hasEq(filters, 'attester_org_id', orgAFixture.attester_org_id);
      return Promise.resolve({
        data: matchesPublicId && matchesOrg ? orgAFixture : null,
        error: matchesPublicId && matchesOrg ? null : { code: 'PGRST116', message: 'No rows' },
      });
    }

    return Promise.resolve({ data: null, error: null });
  }

  function createBuilder(table: string) {
    const filters: LocalFilter[] = [];
    const record = { table, filters };
    queries.push(record);

    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn((column: string, value: unknown) => {
      filters.push({ op: 'eq', column, value });
      return builder;
    });
    builder.in = vi.fn((column: string, value: unknown) => {
      filters.push({ op: 'in', column, value });
      return builder;
    });
    builder.limit = vi.fn(() => builder);
    builder.single = vi.fn(() => resolveSingle(table, filters));
    builder.insert = vi.fn((payload: unknown) => {
      insertedRows.push({ table, payload });
      return builder;
    });
    builder.update = vi.fn(() => builder);
    return builder;
  }

  return {
    mockFrom: vi.fn((table: string) => createBuilder(table)),
    queries,
    insertedRows,
  };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: mockFrom },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../lib/urls.js', () => ({
  buildSignatureVerifyUrl: (id: string) => `https://app.arkova.ai/verify-signature/${id}`,
}));

vi.mock('../../signatures/engineFactory.js', () => ({
  getAdesEngine: vi.fn(() => ({
    sign: vi.fn(async () => {
      throw new Error('signing engine should not be reached');
    }),
  })),
}));

import { signaturesRouter } from './signatures.js';

function appWithAuth() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { authUserId: string }).authUserId = 'user-b';
    next();
  });
  app.use(signaturesRouter);
  return app;
}

describe('signatures attestation tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queries.length = 0;
    insertedRows.length = 0;
  });

  it('does not resolve an attestation from another organization when creating a signature', async () => {
    const res = await request(appWithAuth())
      .post('/sign')
      .send({
        attestation_id: 'ARK-ORGA-VER-ABC123',
        fingerprint: `sha256:${'a'.repeat(64)}`,
        format: 'PAdES',
        level: 'B-B',
        signer_certificate_id: '11111111-1111-4111-8111-111111111111',
      });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Attestation not found' });
    const attestationQuery = queries.find((query: QueryRecord) => query.table === 'attestations');
    expect(attestationQuery?.filters).toContainEqual({
      op: 'eq',
      column: 'public_id',
      value: 'ARK-ORGA-VER-ABC123',
    });
    expect(attestationQuery?.filters).toContainEqual({
      op: 'eq',
      column: 'attester_org_id',
      value: 'org-b',
    });
    expect(insertedRows).not.toContainEqual(expect.objectContaining({ table: 'signatures' }));
  });
});
