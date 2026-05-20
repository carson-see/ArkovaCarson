import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRecord = {
  table: string;
  selectArg?: string;
};

const { mockFrom, queries } = vi.hoisted(() => {
  type LocalQueryRecord = {
    table: string;
    selectArg?: string;
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

    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
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
    builder.then = vi.fn((onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => (
      Promise.resolve({ data: rowsFor(table), error: null }).then(onFulfilled, onRejected)
    ));
    return builder;
  }

  return {
    mockFrom: vi.fn((table: string) => createBuilder(table)),
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
  verifyAuthToken: vi.fn(),
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
});
