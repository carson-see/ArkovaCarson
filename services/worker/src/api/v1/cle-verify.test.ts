import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRecord = {
  table: string;
  selectArg?: string;
  insertPayload?: unknown;
};

const { mockFrom, mockVerifyAuthToken, queries } = vi.hoisted(() => {
  type LocalQueryRecord = {
    table: string;
    selectArg?: string;
    insertPayload?: unknown;
  };

  const queries: LocalQueryRecord[] = [];

  function rowsFor(table: string) {
    if (table === 'anchors') {
      return [
        {
          id: 'anchor-internal-id',
          public_id: 'ARK-CLE-PUB123',
          filename: 'CLE_California_123_2026-05-01.json',
          credential_type: 'CLE',
          metadata: {
            bar_number: '123',
            credit_hours: 2,
            credit_category: 'Ethics',
          },
          status: 'SECURED',
          created_at: '2026-05-01T00:00:00.000Z',
          chain_tx_id: 'tx-cle',
          chain_block_height: 12345,
        },
      ];
    }

    if (table === 'attestations') {
      return [
        {
          id: 'attestation-internal-id',
          public_id: 'ARK-CLE-ATT123',
          attestation_type: 'CLE_VERIFICATION',
          claims: {},
          status: 'ACTIVE',
          created_at: '2026-05-01T00:00:00.000Z',
        },
      ];
    }

    return [];
  }

  function createBuilder(table: string) {
    const record: LocalQueryRecord = { table };
    queries.push(record);

    const builder = Promise.resolve({ data: rowsFor(table), error: null }) as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    builder.select = vi.fn((arg?: string) => {
      record.selectArg = arg;
      return builder;
    });
    builder.eq = vi.fn(() => builder);
    builder.ilike = vi.fn(() => builder);
    builder.in = vi.fn(() => builder);
    builder.order = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.gte = vi.fn(() => builder);
    builder.lte = vi.fn(() => builder);
    builder.insert = vi.fn((payload: unknown) => {
      record.insertPayload = payload;
      return builder;
    });
    builder.single = vi.fn(async () => ({
      data: table === 'anchors' ? { public_id: 'ARK-CLE-SUBMIT123' } : null,
      error: null,
    }));
    return builder;
  }

  return {
    mockFrom: vi.fn((table: string) => createBuilder(table)),
    mockVerifyAuthToken: vi.fn(),
    queries,
  };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: mockFrom },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../auth.js', () => ({
  verifyAuthToken: mockVerifyAuthToken,
}));

vi.mock('../../config.js', () => ({
  config: {},
}));

import { cleVerifyRouter } from './cle-verify.js';

function appWithRouter() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/cle', cleVerifyRouter);
  return app;
}

describe('CLE public verification response shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyAuthToken.mockResolvedValue('user-123');
    queries.length = 0;
  });

  it('uses public IDs and does not expose internal anchor or attestation UUIDs', async () => {
    const res = await request(appWithRouter())
      .get('/api/v1/cle/verify')
      .query({ bar_number: '123', jurisdiction: 'California' });

    expect(res.status).toBe(200);
    expect(res.body.records[0]).toMatchObject({ public_id: 'ARK-CLE-PUB123' });
    expect(res.body.records[0]).not.toHaveProperty('id');
    expect(res.body.attestations[0]).toMatchObject({ public_id: 'ARK-CLE-ATT123' });
    expect(res.body.attestations[0]).not.toHaveProperty('id');

    const attestationQuery = queries.find((query: QueryRecord) => query.table === 'attestations');
    const attestationColumns = attestationQuery?.selectArg?.split(',').map((column) => column.trim()) ?? [];
    expect(attestationColumns).not.toContain('id');
  });

  it('submits CLE credits with public IDs only', async () => {
    const res = await request(appWithRouter())
      .post('/api/v1/cle/submit')
      .set('Authorization', 'Bearer test-token')
      .send({
        bar_number: '123',
        attorney_name: 'Casey Counsel',
        course_title: 'Ethics for Automated Compliance',
        provider_name: 'Arkova CLE',
        provider_accreditation_number: 'CA-ARK-1',
        credit_hours: 2,
        credit_category: 'Ethics',
        delivery_method: 'Live Webcast',
        jurisdiction: 'California',
        completion_date: '2026-05-01',
        course_number: 'ETH-2026',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ public_id: 'ARK-CLE-SUBMIT123' });
    expect(res.body).not.toHaveProperty('id');

    const insertQuery = queries.find((query: QueryRecord) => query.table === 'anchors' && query.insertPayload);
    expect(insertQuery).toBeDefined();

    const anchorQuery = queries.find((query: QueryRecord) => query.table === 'anchors' && query.selectArg === 'public_id');
    expect(anchorQuery).toBeDefined();
    expect(anchorQuery?.selectArg?.split(',').map((column) => column.trim())).not.toContain('id');
  });
});
